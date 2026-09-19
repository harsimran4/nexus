// Thin Drive wrapper — THREE credential modes now:
//   'bearer' — a Nexus app session (editor/admin, verified by the Worker).
//              Every call here goes to the Worker, never to Google directly.
//   'key'    — the embedded API key (anonymous/viewer reads). UNCHANGED —
//              still hits googleapis.com directly, exactly as before.
//   'google' — a raw Google OAuth token. ONLY used by the one-time #/init
//              bootstrap flow (before the Worker/nexus.json exist), and by
//              nothing else. See src/ui/pages/Init.tsx.
// 'auto' prefers a live app session when present, else falls back to 'key'.

export type AuthMode = 'bearer' | 'key' | 'google' | 'auto'
export type Credential = { mode: AuthMode; bearer?: string | null; apiKey?: string }

export type DriveErrorKind =
  | 'network'
  | 'auth'
  | 'notFound'
  | 'rateLimit'
  | 'downloadRestricted'
  | 'permission'
  | 'api'

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
// Set at build time — the Worker's deployed URL, e.g.
// https://nexus-drive-proxy.<you>.workers.dev
const WORKER = (import.meta.env.VITE_NEXUS_WORKER_URL ?? '').replace(/\/$/, '')

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
  if (status >= 500) return 'rateLimit'
  return 'api'
}

async function parseError(res: Response): Promise<DriveError> {
  let reason: string | undefined
  let message = `Drive API ${res.status}`
  try {
    const body = await res.json()
    reason = body?.error?.errors?.[0]?.reason ?? body?.error
    if (body?.error?.message) message = body.error.message
    else if (typeof body?.error === 'string') message = body.error
  } catch {
    /* non-JSON error body */
  }
  return new DriveError(mapStatus(res.status, reason), message, res.status, reason)
}

function withKey(url: string, cred: Credential): string {
  const key = cred.apiKey ?? getGlobalApiKey()
  if (!key) throw new DriveError('auth', 'No API key configured')
  return url + (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key)
}

// globalBearer: the app-session (Worker) token used for mode 'bearer'.
// globalGoogleBearer: a raw Google token, only ever set during #/init.
let globalBearer: string | null = null
let globalGoogleBearer: string | null = null
let globalApiKey: string | null = null

export function setGlobalBearer(token: string | null): void {
  globalBearer = token
}
export function setGlobalGoogleBearer(token: string | null): void {
  globalGoogleBearer = token
}
export function setGlobalApiKey(key: string): void {
  globalApiKey = key
}
function getGlobalApiKey(): string | null {
  return globalApiKey
}
export function hasBearer(): boolean {
  return globalBearer !== null
}

function sessionToken(cred: Credential): string {
  const t = cred.bearer ?? globalBearer
  if (!t) throw new DriveError('auth', 'Sign in first')
  return t
}
function googleToken(cred: Credential): string {
  const t = cred.mode === 'google' ? cred.bearer ?? globalGoogleBearer : null
  if (!t) throw new DriveError('auth', 'Sign in with Google first')
  return t
}

async function workerFetch(path: string, init: RequestInit, cred: Credential): Promise<Response> {
  if (!WORKER) throw new DriveError('api', 'VITE_NEXUS_WORKER_URL is not configured')
  const headers = new Headers(init.headers)
  headers.set('Authorization', 'Bearer ' + sessionToken(cred))
  let res: Response
  try {
    res = await fetch(WORKER + path, { ...init, headers })
  } catch (e) {
    throw new DriveError('network', e instanceof Error ? e.message : 'network error')
  }
  if (!res.ok) throw await parseError(res)
  return res
}

async function googleFetch(url: string, init: RequestInit, cred: Credential): Promise<Response> {
  const headers = new Headers(init.headers)
  if (cred.mode === 'google') headers.set('Authorization', 'Bearer ' + googleToken(cred))
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
      const retryable = err instanceof DriveError && (err.kind === 'rateLimit' || err.kind === 'network')
      if (!retryable || attempt === retries) throw err
      const waitMs = Math.min(2 ** attempt * 1000 + Math.floor(Math.random() * 1000), 32_000)
      opts.onRetry?.(attempt, err, waitMs)
      await new Promise((r) => setTimeout(r, waitMs))
    }
  }
  throw lastErr
}

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

export interface ListResult {
  files: FileMeta[]
  nextPageToken?: string
}

// ---------------------------------------------------------------------------
// Reads — bearer -> Worker, key -> direct (unchanged), google -> direct
// ---------------------------------------------------------------------------

export async function getMeta(fileId: string, cred: Credential): Promise<FileMeta> {
  if (cred.mode === 'bearer' || (cred.mode === 'auto' && globalBearer)) {
    const res = await workerFetch(`/drive/meta/${fileId}`, { method: 'GET' }, { ...cred, mode: 'bearer' })
    return res.json()
  }
  const res = await googleFetch(withKey(`${API}/files/${fileId}?fields=${META_FIELDS}`, cred), { method: 'GET' }, cred)
  return res.json()
}

export async function readFile(fileId: string, cred: Credential): Promise<string> {
  if (cred.mode === 'bearer' || (cred.mode === 'auto' && globalBearer)) {
    const res = await workerFetch(`/drive/content/${fileId}`, { method: 'GET' }, { ...cred, mode: 'bearer' })
    return res.text()
  }
  const res = await googleFetch(withKey(`${API}/files/${fileId}?alt=media`, cred), { method: 'GET' }, cred)
  return res.text()
}

export async function downloadFile(fileId: string, cred: Credential): Promise<Blob> {
  if (cred.mode === 'bearer' || (cred.mode === 'auto' && globalBearer)) {
    const res = await workerFetch(`/drive/content/${fileId}`, { method: 'GET' }, { ...cred, mode: 'bearer' })
    return res.blob()
  }
  const res = await googleFetch(withKey(`${API}/files/${fileId}?alt=media`, cred), { method: 'GET' }, cred)
  return res.blob()
}

export async function listChildren(
  folderId: string,
  cred: Credential,
  opts: { query?: string; pageSize?: number; pageToken?: string } = {},
): Promise<ListResult> {
  if (cred.mode === 'bearer') {
    const params = new URLSearchParams({ parent: folderId, pageSize: String(opts.pageSize ?? 100) })
    if (opts.query) params.set('query', opts.query)
    if (opts.pageToken) params.set('pageToken', opts.pageToken)
    const res = await workerFetch(`/drive/list?${params.toString()}`, { method: 'GET' }, cred)
    return res.json()
  }
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed = false` + (opts.query ? ' and ' + opts.query : ''),
    fields: 'nextPageToken,files(' + META_FIELDS + ')',
    pageSize: String(opts.pageSize ?? 100),
  })
  if (opts.pageToken) params.set('pageToken', opts.pageToken)
  const res = await googleFetch(withKey(`${API}/files?${params.toString()}`, cred), { method: 'GET' }, cred)
  return res.json()
}

// ---------------------------------------------------------------------------
// Writes — bearer -> Worker (the only supported write mode at runtime);
// google -> direct (bootstrap only)
// ---------------------------------------------------------------------------

export async function writeFileJson(fileId: string, content: string, cred: Credential): Promise<FileMeta> {
  return writeFileText(fileId, content, cred, 'application/json')
}

export async function writeFileText(
  fileId: string,
  content: string,
  cred: Credential,
  mimeType = 'text/markdown',
): Promise<FileMeta> {
  if (cred.mode === 'bearer') {
    const res = await workerFetch(
      `/drive/content/${fileId}`,
      { method: 'PATCH', headers: { 'X-Mime-Type': mimeType }, body: content },
      cred,
    )
    return res.json()
  }
  const res = await googleFetch(
    `${UPLOAD_API}/files/${fileId}?uploadType=media&fields=${META_FIELDS}`,
    { method: 'PATCH', headers: { 'Content-Type': mimeType }, body: content },
    cred,
  )
  return res.json()
}

export async function createFolder(name: string, parentId: string | null, cred: Credential): Promise<FileMeta> {
  if (cred.mode === 'bearer') {
    const res = await workerFetch(
      '/drive/folders',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, parentId }) },
      cred,
    )
    return res.json()
  }
  const body: Record<string, unknown> = { name, mimeType: 'application/vnd.google-apps.folder' }
  if (parentId) body.parents = [parentId]
  const res = await googleFetch(
    `${API}/files?fields=${META_FIELDS}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    cred,
  )
  return res.json()
}

export async function createJsonFile(name: string, parentId: string, content: string, cred: Credential): Promise<FileMeta> {
  return createTextFile(name, parentId, content, 'application/json', cred)
}

export async function createTextFile(
  name: string,
  parentId: string,
  content: string,
  mimeType: string,
  cred: Credential,
): Promise<FileMeta> {
  if (cred.mode === 'bearer') {
    const res = await workerFetch(
      '/drive/files',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, parentId, content, mimeType }) },
      cred,
    )
    return res.json()
  }
  const boundary = 'nexusbound' + Math.random().toString(36).slice(2)
  const metadata = JSON.stringify({ name, parents: [parentId], mimeType })
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n${content}\r\n--${boundary}--`
  const res = await googleFetch(
    `${UPLOAD_API}/files?uploadType=multipart&fields=${META_FIELDS}`,
    { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body },
    cred,
  )
  return res.json()
}

export async function copyFile(fileId: string, name: string, parentId: string, cred: Credential): Promise<FileMeta> {
  if (cred.mode === 'bearer') {
    const res = await workerFetch(
      `/drive/files/${fileId}/copy`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, parentId }) },
      cred,
    )
    return res.json()
  }
  const res = await googleFetch(
    `${API}/files/${fileId}/copy?fields=${META_FIELDS}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, parents: [parentId] }) },
    cred,
  )
  return res.json()
}

export async function trashFile(fileId: string, cred: Credential): Promise<void> {
  if (cred.mode === 'bearer') {
    await workerFetch(
      `/drive/files/${fileId}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) },
      cred,
    )
    return
  }
  await googleFetch(
    `${API}/files/${fileId}`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) },
    cred,
  )
}

export async function moveFile(fileId: string, addParent: string, removeParent: string | null, cred: Credential): Promise<FileMeta> {
  if (cred.mode === 'bearer') {
    const params = new URLSearchParams({ addParent })
    if (removeParent) params.set('removeParent', removeParent)
    const res = await workerFetch(
      `/drive/files/${fileId}?${params.toString()}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) },
      cred,
    )
    return res.json()
  }
  const params = new URLSearchParams({ addParents: addParent, fields: META_FIELDS })
  if (removeParent) params.set('removeParents', removeParent)
  const res = await googleFetch(`${API}/files/${fileId}?${params.toString()}`, { method: 'PATCH' }, cred)
  return res.json()
}

export async function renameFile(fileId: string, name: string, cred: Credential): Promise<FileMeta> {
  if (cred.mode === 'bearer') {
    const res = await workerFetch(
      `/drive/files/${fileId}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) },
      cred,
    )
    return res.json()
  }
  const res = await googleFetch(
    `${API}/files/${fileId}?fields=${META_FIELDS}`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) },
    cred,
  )
  return res.json()
}

export async function createAnyoneReaderPermission(fileId: string, cred: Credential): Promise<void> {
  if (cred.mode === 'bearer') {
    await workerFetch(`/drive/permissions/${fileId}`, { method: 'POST' }, cred)
    return
  }
  await googleFetch(
    `${API}/files/${fileId}/permissions?fields=id`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'anyone', role: 'reader' }) },
    cred,
  )
}

/** Resumable upload with progress (XHR — fetch can't report upload progress). */
export async function uploadFile(
  folderId: string,
  file: File,
  cred: Credential,
  onProgress?: (pct: number) => void,
): Promise<FileMeta> {
  if (cred.mode !== 'bearer') throw new DriveError('auth', 'Sign in to upload')

  if (file.size <= 5 * 1024 * 1024) {
    const form = new FormData()
    form.set('parentId', folderId)
    form.set('file', file)
    const res = await workerFetch('/drive/upload', { method: 'POST', body: form }, cred)
    onProgress?.(100)
    return res.json()
  }

  const initRes = await workerFetch(
    '/drive/upload/resumable/init',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: file.name, parentId: folderId, mimeType: file.type }) },
    cred,
  )
  const { url: sessionUrl } = (await initRes.json()) as { url: string }

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
        reject(new DriveError(mapStatus(xhr.status, undefined), `Upload failed (${xhr.status})`, xhr.status))
      }
    }
    xhr.onerror = () => reject(new DriveError('network', 'Upload network error'))
    xhr.send(file)
  })
}

export function thumbnailUrl(fileId: string, size = 400): string {
  return `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w${size}`
}

export function webViewLink(fileId: string): string {
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`
}
