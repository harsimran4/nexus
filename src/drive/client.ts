// Thin Google Drive v3 REST wrapper. Two credential modes:
//   'bearer' — a signed-in Google token (editors/admin, scope drive.file)
//   'key'    — the embedded API key (anonymous reads of link-shared content)
// 'auto' prefers bearer when present (editors keep working when the key breaks).
// Drive REST is CORS-open; no proxy exists in this architecture.

export type AuthMode = 'bearer' | 'key' | 'auto'
export type Credential = { mode: AuthMode; bearer?: string | null; apiKey?: string }

export type DriveErrorKind =
  | 'network' // fetch TypeError — offline / blocked
  | 'auth' // 401, invalid credentials — token dead or consent revoked
  | 'notFound' // 404 — no access (drive.file edge) or wrong id
  | 'rateLimit' // 403 userRateLimitExceeded / rateLimitExceeded, 429
  | 'downloadRestricted' // 403 cannotDownloadFile — "viewers can't download" toggle
  | 'permission' // other 403s (sharing blocked, key referrer mismatch)
  | 'api' // anything else

export class DriveError extends Error {
  kind: DriveErrorKind
  status?: number
  reason?: string
  constructor(kind: DriveErrorKind, message: string, status?: number, reason?: string) {
    super(message)
    this.name = 'DriveError'
    this.kind = kind
    this.status = status
    this.reason = reason
  }
}

const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3'

export function mapStatus(status: number, reason: string | undefined): DriveErrorKind {
  if (status === 401) return 'auth'
  if (status === 404) return 'notFound'
  if (status === 429) return 'rateLimit'
  if (status === 403) {
    if (!reason) return 'permission'
    if (reason === 'cannotDownloadFile') return 'downloadRestricted'
    if (reason === 'userRateLimitExceeded' || reason === 'rateLimitExceeded' || reason === 'dailyLimitExceeded')
      return 'rateLimit'
    return 'permission'
  }
  if (status >= 500) return 'rateLimit' // retryable per Google's guidance
  return 'api'
}

async function parseError(res: Response): Promise<DriveError> {
  let reason: string | undefined
  let message = `Drive API ${res.status}`
  try {
    const body = await res.json()
    reason = body?.error?.errors?.[0]?.reason
    if (body?.error?.message) message = body.error.message
  } catch {
    /* non-JSON error body */
  }
  return new DriveError(mapStatus(res.status, reason), message, res.status, reason)
}

function withKey(url: string, cred: Credential): string {
  const bearer = cred.mode === 'key' ? null : cred.bearer ?? getGlobalBearer()
  if (bearer) return url
  if (cred.mode === 'bearer') {
    // The caller explicitly wanted an authenticated user call (any write, or a
    // user-scoped read like listing Drive root). Falling back to the anonymous
    // API key here produces cryptic "unregistered callers" errors — fail loudly.
    throw new DriveError('auth', 'Sign in with Google first — this call needs your Google identity')
  }
  const key = cred.apiKey ?? getGlobalApiKey()
  if (!key) throw new DriveError('auth', 'No API key configured and not signed in')
  return url + (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key)
}

// Set by auth/tokenClient.ts at runtime; kept here to avoid a circular import.
let globalBearer: string | null = null
let globalApiKey: string | null = null
export function setGlobalBearer(token: string | null): void {
  globalBearer = token
}
export function setGlobalApiKey(key: string): void {
  globalApiKey = key
}
function getGlobalBearer(): string | null {
  return globalBearer
}
function getGlobalApiKey(): string | null {
  return globalApiKey
}

/** True when a signed-in token exists (mode 'auto' will use bearer). */
export function hasBearer(): boolean {
  return globalBearer !== null
}

async function driveFetch(url: string, init: RequestInit, cred: Credential): Promise<Response> {
  // Attach the bearer to EVERY call that may use one — GET reads included.
  // (A missing Authorization header here turns signed-in reads into anonymous
  // calls, which Drive rejects as "unregistered callers".)
  const headers = new Headers(init.headers)
  if (cred.mode !== 'key') {
    const bearer = cred.bearer ?? getGlobalBearer()
    if (bearer) headers.set('Authorization', 'Bearer ' + bearer)
  }
  let res: Response
  try {
    res = await fetch(url, { ...init, headers })
  } catch (e) {
    throw new DriveError('network', e instanceof Error ? e.message : 'network error')
  }
  if (!res.ok) throw await parseError(res)
  return res
}

export async function backoffRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { retries?: number; onRetry?: (attempt: number, err: DriveError, waitMs: number) => void } = {},
): Promise<T> {
  const retries = opts.retries ?? 4
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt)
    } catch (err) {
      lastErr = err
      const retryable =
        err instanceof DriveError && (err.kind === 'rateLimit' || err.kind === 'network')
      if (!retryable || attempt === retries) throw err
      // Official shape: min((2^n)s + jitter, 32s cap)
      const waitMs = Math.min(2 ** attempt * 1000 + Math.floor(Math.random() * 1000), 32_000)
      opts.onRetry?.(attempt, err, waitMs)
      await new Promise((r) => setTimeout(r, waitMs))
    }
  }
  throw lastErr
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export interface FileMeta {
  id: string
  name: string
  headRevisionId?: string
  md5Checksum?: string
  version?: string
  modifiedTime?: string
  mimeType?: string
  trashed?: boolean
  createdTime?: string
}

const META_FIELDS = 'id,name,headRevisionId,md5Checksum,version,modifiedTime,mimeType,trashed,createdTime'

export async function getMeta(fileId: string, cred: Credential): Promise<FileMeta> {
  const res = await driveFetch(withKey(`${API}/files/${fileId}?fields=${META_FIELDS}`, cred), { method: 'GET' }, cred)
  return res.json()
}

export async function readFile(fileId: string, cred: Credential): Promise<string> {
  const res = await driveFetch(withKey(`${API}/files/${fileId}?alt=media`, cred), { method: 'GET' }, cred)
  return res.text()
}

/** Whole-file JSON write (uploadType=media). Drive creates a new revision per write. */
export async function writeFileJson(
  fileId: string,
  content: string,
  cred: Credential,
  opts: { keepalive?: boolean } = {},
): Promise<FileMeta> {
  return writeFileText(fileId, content, cred, 'application/json', opts)
}

/** Whole-file media write (uploadType=media). */
export async function writeFileText(
  fileId: string,
  content: string,
  cred: Credential,
  mimeType = 'text/markdown',
  opts: { keepalive?: boolean } = {},
): Promise<FileMeta> {
  const bearer = cred.bearer ?? getGlobalBearer()
  if (!bearer) throw new DriveError('auth', 'Sign in with Google to write')
  const res = await fetch(`${UPLOAD_API}/files/${fileId}?uploadType=media&fields=${META_FIELDS}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': mimeType },
    body: content,
    keepalive: opts.keepalive,
  }).catch((e: unknown) => {
    throw new DriveError('network', e instanceof Error ? e.message : 'network error')
  })
  if (!res.ok) throw await parseError(res)
  return res.json()
}

export async function createFolder(name: string, parentId: string | null, cred: Credential): Promise<FileMeta> {
  const bearer = cred.bearer ?? getGlobalBearer()
  if (!bearer) throw new DriveError('auth', 'Sign in with Google to write')
  const body: Record<string, unknown> = { name, mimeType: 'application/vnd.google-apps.folder' }
  if (parentId) body.parents = [parentId]
  const res = await driveFetch(
    `${API}/files?fields=${META_FIELDS}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    cred,
  )
  return res.json()
}

export async function createJsonFile(
  name: string,
  parentId: string,
  content: string,
  cred: Credential,
): Promise<FileMeta> {
  return createTextFile(name, parentId, content, 'application/json', cred)
}

export async function createTextFile(
  name: string,
  parentId: string,
  content: string,
  mimeType: string,
  cred: Credential,
): Promise<FileMeta> {
  const bearer = cred.bearer ?? getGlobalBearer()
  if (!bearer) throw new DriveError('auth', 'Sign in with Google to write')
  const boundary = 'nexusbound' + Math.random().toString(36).slice(2)
  const metadata = JSON.stringify({ name, parents: [parentId], mimeType })
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n${content}\r\n--${boundary}--`
  const res = await driveFetch(
    `${UPLOAD_API}/files?uploadType=multipart&fields=${META_FIELDS}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'multipart/related; boundary=' + boundary },
      body,
    },
    cred,
  )
  return res.json()
}

export async function copyFile(fileId: string, name: string, parentId: string, cred: Credential): Promise<FileMeta> {
  const bearer = cred.bearer ?? getGlobalBearer()
  if (!bearer) throw new DriveError('auth', 'Sign in with Google to write')
  const res = await driveFetch(
    `${API}/files/${fileId}/copy?fields=${META_FIELDS}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parents: [parentId] }),
    },
    cred,
  )
  return res.json()
}

export async function trashFile(fileId: string, cred: Credential): Promise<void> {
  const bearer = cred.bearer ?? getGlobalBearer()
  if (!bearer) throw new DriveError('auth', 'Sign in with Google to write')
  await driveFetch(
    `${API}/files/${fileId}`,
    { method: 'PATCH', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) },
    cred,
  )
}

/** Move a file/folder between parents (used by the workspace reorganization). */
export async function moveFile(
  fileId: string,
  addParent: string,
  removeParent: string | null,
  cred: Credential,
): Promise<FileMeta> {
  const bearer = cred.bearer ?? getGlobalBearer()
  if (!bearer) throw new DriveError('auth', 'Sign in with Google to write')
  const params = new URLSearchParams({ addParents: addParent, fields: META_FIELDS })
  if (removeParent) params.set('removeParents', removeParent)
  const res = await driveFetch(
    `${API}/files/${fileId}?${params.toString()}`,
    { method: 'PATCH', headers: { Authorization: `Bearer ${bearer}` } },
    cred,
  )
  return res.json()
}

/** Rename a Drive file or folder (project rename syncs its folder name). */
export async function renameFile(fileId: string, name: string, cred: Credential): Promise<FileMeta> {
  const bearer = cred.bearer ?? getGlobalBearer()
  if (!bearer) throw new DriveError('auth', 'Sign in with Google to write')
  const res = await driveFetch(
    `${API}/files/${fileId}?fields=${META_FIELDS}`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    },
    cred,
  )
  return res.json()
}

export interface ListResult {
  files: FileMeta[]
  nextPageToken?: string
}

export async function listChildren(
  folderId: string,
  cred: Credential,
  opts: { query?: string; pageSize?: number; pageToken?: string } = {},
): Promise<ListResult> {
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed = false` + (opts.query ? ' and ' + opts.query : ''),
    fields: 'nextPageToken,files(' + META_FIELDS + ')',
    pageSize: String(opts.pageSize ?? 100),
  })
  if (opts.pageToken) params.set('pageToken', opts.pageToken)
  const res = await driveFetch(withKey(`${API}/files?${params.toString()}`, cred), { method: 'GET' }, cred)
  return res.json()
}

/** Link-share a file/folder we created: "Anyone with the link — Viewer". */
export async function createAnyoneReaderPermission(fileId: string, cred: Credential): Promise<void> {
  const bearer = cred.bearer ?? getGlobalBearer()
  if (!bearer) throw new DriveError('auth', 'Sign in with Google to write')
  const res = await driveFetch(
    `${API}/files/${fileId}/permissions?fields=id`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'anyone', role: 'reader' }),
    },
    cred,
  )
  await res.json()
}

/**
 * Resumable upload with progress (XHR — fetch can't report upload progress).
 * Falls back to a single multipart request for small files.
 */
export async function uploadFile(
  folderId: string,
  file: File,
  cred: Credential,
  onProgress?: (pct: number) => void,
): Promise<FileMeta> {
  const bearer = cred.bearer ?? getGlobalBearer()
  if (!bearer) throw new DriveError('auth', 'Sign in with Google to write')

  // Small files: one multipart POST is simpler and cheaper ( Drive costs are
  // per-request; resumable's init+PUT is 2 requests + a session).
  if (file.size <= 5 * 1024 * 1024) {
    const boundary = 'nexusup' + Math.random().toString(36).slice(2)
    const metadata = JSON.stringify({ name: file.name, parents: [folderId] })
    const blobParts = [
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
      `--${boundary}\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`,
      file,
      `\r\n--${boundary}--`,
    ]
    const res = await driveFetch(
      `${UPLOAD_API}/files?uploadType=multipart&fields=${META_FIELDS}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'multipart/related; boundary=' + boundary },
        body: await new Blob(blobParts).arrayBuffer(),
      },
      cred,
    )
    onProgress?.(100)
    return res.json()
  }

  // Large files: resumable session via XHR for progress events.
  const initRes = await driveFetch(
    `${UPLOAD_API}/files?uploadType=resumable&fields=${META_FIELDS}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: file.name, parents: [folderId], mimeType: file.type || 'application/octet-stream' }),
    },
    cred,
  )
  const sessionUrl = initRes.headers.get('Location') ?? initRes.headers.get('location')
  if (!sessionUrl) throw new DriveError('api', 'Resumable session URL missing from Drive response')

  return new Promise<FileMeta>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', sessionUrl)
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText))
        } catch {
          reject(new DriveError('api', 'Invalid JSON from resumable upload'))
        }
      } else {
        let reason: string | undefined
        try {
          reason = JSON.parse(xhr.responseText)?.error?.errors?.[0]?.reason
        } catch {
          /* ignore */
        }
        reject(new DriveError(mapStatus(xhr.status, reason), `Upload failed (${xhr.status})`, xhr.status, reason))
      }
    }
    xhr.onerror = () => reject(new DriveError('network', 'Upload network error'))
    xhr.send(file)
  })
}

/** Download file bytes to the browser (viewers' "open" button, key path). */
export async function downloadFile(fileId: string, cred: Credential): Promise<Blob> {
  const res = await driveFetch(withKey(`${API}/files/${fileId}?alt=media`, cred), { method: 'GET' }, cred)
  return res.blob()
}

/** Embeddable thumbnail URL (lh3, no CORS needed since it's an <img> src). */
export function thumbnailUrl(fileId: string, size = 400): string {
  return `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w${size}`
}

export function webViewLink(fileId: string): string {
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`
}
