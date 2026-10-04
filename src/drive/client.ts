// Client data layer. Google Drive is gone — storage is an OCI Object Storage
// bucket, reached through this app's own server functions (writes) and the
// public /files/<key> + /api/public/* routes (reads, thumbnails, downloads).
// The exported names/shapes match the old Drive client so the UI and sync
// layers stay stable; the `cred` arguments are gone (the server knows who
// you are from the session token its middleware attaches).
//
// Keys are S3 object keys: `groups/<groupId>/<projectId>/<fileId>__<name>`.
// The id segment is immutable; the name is decorative (rename = copy+delete).

import type { DriveErrorKind, FileMeta, ListResult, FnResult } from '../types/storage'
import { DOC_KEY } from '../server/keys'
import { encodeKeyPath } from '../server/mime'
import {
  docPutFn,
  putTextFn,
  folderCreateFn,
  fileCreateFn,
  fileCopyFn,
  trashFn,
  movePrefixFn,
  renameFn,
  uploadSmallFn,
} from '../server/fns'

export type { DriveErrorKind, FileMeta, ListResult }

export class DriveError extends Error {
  kind: DriveErrorKind
  status?: number
  constructor(kind: DriveErrorKind, message: string, status?: number) {
    super(message)
    this.name = 'DriveError'
    this.kind = kind
    this.status = status
  }
}

/** HTTP status → error kind (used by the direct /files fetches). */
export function mapStatus(status: number): DriveErrorKind {
  if (status === 401) return 'auth'
  if (status === 404) return 'notFound'
  if (status === 410) return 'notFound'
  if (status === 429) return 'rateLimit'
  if (status >= 500) return 'rateLimit'
  if (status === 409) return 'conflict'
  return 'api'
}

// ---------------------------------------------------------------------------
// Session token — sessionStorage mirror (same key the old Worker flow used).
// ---------------------------------------------------------------------------

const WORKER_TOKEN_KEY = 'nexus.workerToken'

export function setGlobalBearer(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(WORKER_TOKEN_KEY, token)
    else sessionStorage.removeItem(WORKER_TOKEN_KEY)
  } catch {
    /* ignore */
  }
}

export function hasBearer(): boolean {
  try {
    return sessionStorage.getItem(WORKER_TOKEN_KEY) !== null
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// RPC plumbing
// ---------------------------------------------------------------------------

async function call<T>(p: Promise<FnResult<T>>): Promise<T> {
  const r = await p
  if (!r.ok) throw new DriveError(r.kind, r.message)
  return r.data
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

function fileUrl(key: string): string {
  return '/files/' + encodeKeyPath(key)
}

async function fetchPublic(url: string): Promise<Response> {
  let res: Response
  try {
    res = await fetch(url)
  } catch (e) {
    throw new DriveError('network', e instanceof Error ? e.message : 'network error')
  }
  if (!res.ok) throw new DriveError(mapStatus(res.status), `Storage ${res.status}`, res.status)
  return res
}

// ---------------------------------------------------------------------------
// Reads — ALL through the public routes, one path for anonymous, viewer and
// editor alike (the old setup's link-shared Drive folder had exactly this
// exposure; writes are the only thing gated behind a session).
// ---------------------------------------------------------------------------

export async function getMeta(key: string): Promise<FileMeta> {
  const res = await fetchPublic('/api/public/meta?key=' + encodeURIComponent(key))
  return (await res.json()) as FileMeta
}

export async function readFile(key: string): Promise<string> {
  return (await fetchPublic(fileUrl(key))).text()
}

export async function downloadFile(key: string): Promise<Blob> {
  return (await fetchPublic(fileUrl(key))).blob()
}

/** Download while streaming the body — reports byte progress as it lands.
 *  `total` is null when the response has no usable Content-Length. */
export async function downloadFileProgress(
  key: string,
  onProgress?: (received: number, total: number | null) => void,
): Promise<Blob> {
  const res = await fetchPublic(fileUrl(key))
  const len = res.headers.get('content-length')
  const total = len && /^\d+$/.test(len) ? Number(len) : null
  if (!res.body) {
    const blob = await res.blob()
    onProgress?.(blob.size, blob.size)
    return blob
  }
  const reader = res.body.getReader()
  const chunks: BlobPart[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.byteLength
    onProgress?.(received, total)
  }
  const blob = new Blob(chunks)
  onProgress?.(blob.size, blob.size)
  return blob
}

export async function listChildren(
  parent: string,
  opts: { pageSize?: number; pageToken?: string } = {},
): Promise<ListResult> {
  const q = new URLSearchParams({ parent, pageSize: String(opts.pageSize ?? 100) })
  if (opts.pageToken) q.set('pageToken', opts.pageToken)
  const res = await fetchPublic('/api/public/list?' + q.toString())
  return (await res.json()) as ListResult
}

// ---------------------------------------------------------------------------
// Writes (all server functions; require a signed-in editor/admin)
// ---------------------------------------------------------------------------

export async function writeFileJson(key: string, content: string, expectEtag?: string): Promise<FileMeta> {
  if (key === DOC_KEY) {
    const { etag } = await call(docPutFn({ data: { raw: content, expectEtag } }))
    return { id: DOC_KEY, name: 'nexus.json', mimeType: 'application/json', headRevisionId: etag, version: etag }
  }
  return writeFileText(key, content, 'application/json')
}

export async function writeFileText(key: string, content: string, mimeType = 'text/markdown'): Promise<FileMeta> {
  return call(putTextFn({ data: { key, content, mimeType } }))
}

/** Create a folder marker. `key` is the full prefix, e.g.
 *  `projects/prj_x/` — the caller derives it from entity ids. */
export async function createFolder(_name: string, _parentId: string | null, key: string): Promise<FileMeta> {
  return call(folderCreateFn({ data: { name: _name, parentId: _parentId, key } }))
}

export async function createJsonFile(name: string, parentId: string, content: string): Promise<FileMeta> {
  return createTextFile(name, parentId, content, 'application/json')
}

export async function createTextFile(name: string, parentId: string, content: string, mimeType: string): Promise<FileMeta> {
  return call(fileCreateFn({ data: { name, parentId, content, mimeType } }))
}

export async function copyFile(key: string, name: string, parentId: string): Promise<FileMeta> {
  return call(fileCopyFn({ data: { key, name, parentId } }))
}

/** Move a key (or whole prefix) into trash/. Prefixes loop until empty. */
export async function trashFile(key: string): Promise<void> {
  for (;;) {
    const r = await call(trashFn({ data: { key } }))
    if (!r.remaining) return
  }
}

/** Move a whole prefix under another, preserving relative keys (a project
 *  moving groups keeps its file ids). Loops until the source is empty; the
 *  caller rewrites doc references (fileIds etc.) in the same commit. */
export async function movePrefix(from: string, to: string): Promise<void> {
  for (;;) {
    const r = await call(movePrefixFn({ data: { from, to } }))
    if (!r.remaining) return
  }
}

/** Rename a file — the KEY changes (copy+delete); the caller must rewrite
 *  the doc (fileIds/mediaSectionOf) with the returned meta.id in the same
 *  commit. Folder renames are doc-only (don't call this for prefixes). */
export async function renameFile(key: string, newName: string): Promise<FileMeta> {
  return call(renameFn({ data: { key, newName } }))
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

/** One XHR PUT that resolves with whatever response came back (any status);
 *  rejects only on true network failure (timeout included — without a
 *  timeout a stalled connection hangs the batch forever with no error).
 *  Body may be null (status probes). */
function xhrPut(
  url: string,
  body: Blob | null,
  headers: Record<string, string>,
  onLoaded?: (loaded: number) => void,
  readRange = false,
  timeoutMs = 120_000,
): Promise<{ status: number; range: string | null; json: FileMeta | null; error: string | null }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.timeout = timeoutMs
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v)
    if (onLoaded) xhr.upload.onprogress = (e) => { if (e.lengthComputable) onLoaded(e.loaded) }
    xhr.onload = () => {
      let json: FileMeta | null = null
      let error: string | null = null
      try {
        const parsed = JSON.parse(xhr.responseText) as FileMeta | { error?: string }
        if (parsed && typeof parsed === 'object' && 'error' in parsed && typeof (parsed as { error?: unknown }).error === 'string') {
          error = (parsed as { error: string }).error
        } else {
          json = parsed as FileMeta
        }
      } catch {
        /* 308 Resume Incomplete responses have no body */
      }
      // Range is only exposed on same-origin (relay) responses — reading it
      // on cross-origin (direct) ones just spams the console.
      resolve({ status: xhr.status, range: readRange ? xhr.getResponseHeader('Range') : null, json, error })
    }
    xhr.onerror = () => reject(new DriveError('network', 'Upload network error'))
    xhr.ontimeout = () => reject(new DriveError('network', 'Upload timed out'))
    xhr.send(body)
  })
}

const UPLOAD_RETRIES = 5 // consecutive network failures before giving up
const PART_RETRIES = 3 // server-side (429/5xx) failures before giving up
const MAX_CONSECUTIVE_FAILURES = 12 // hard budget across ALL retry paths — the tile must always reach a terminal state

/** Per-part transfer deadline, scaled for slow links: 8 MiB in 120s floors
 *  at ~0.56 Mbps and doomed every upload from a weak connection to minutes
 *  of timeouts. 40 KB/s floor ≈ 0.32 Mbps at the default part size. */
function partTimeoutMs(bytes: number): number {
  return Math.max(120_000, Math.ceil((bytes / 40_000) * 1000))
}

/** Upload with progress. Every size rides the presigned DIRECT path — the
 *  browser PUTs bytes straight to storage (single PutObject for ≤1 part, or
 *  multipart parts above that), because Oracle's Cloudflare front
 *  intermittently 403s the worker-relayed write path. Small files fall back
 *  to the worker relay only as a last resort. The server links the file into
 *  the doc at completion — the client's own link commit is a UI mirror.
 *  `authToken` (guest upload links) replaces the stored session bearer. */
export async function uploadFile(
  parentId: string,
  file: File,
  onProgress?: (pct: number) => void,
  opts: { projectId?: string | null; sectionId?: string | null; authToken?: string } = {},
): Promise<FileMeta> {
  if (!opts.authToken && !hasBearer()) throw new DriveError('auth', 'Sign in to upload')

  for (let attempt = 0; ; attempt++) {
    try {
      return await resumableUpload(parentId, file, onProgress, opts)
    } catch (e) {
      if (e instanceof DriveError && e.kind === 'notFound' && attempt === 0) continue
      // Small files: one last-resort attempt through the worker relay. It
      // rides the flaky worker→OCI write path (Oracle's Cloudflare front
      // intermittently 403s worker-egress PUTs), so it's the backup, not
      // the default — the direct path above is the one that works. Not
      // available to guests (authToken) — the relay needs a writer session.
      if (file.size <= 5 * 1024 * 1024 && !opts.authToken) {
        const form = new FormData()
        form.set('parentId', parentId)
        form.set('file', file)
        if (opts.projectId) form.set('projectId', opts.projectId)
        if (opts.sectionId) form.set('sectionId', opts.sectionId)
        const meta = await call(uploadSmallFn({ data: form }))
        onProgress?.(100)
        return meta
      }
      throw e
    }
  }
}

/** Fire-and-forget abort of a dead upload session — failed uploads must not
 *  leak in-progress multipart sessions at storage (no lifecycle API exists
 *  on OCI's S3 endpoint to clean them later). */
function abortSession(sessionUrl: string): void {
  try {
    const xhr = new XMLHttpRequest()
    xhr.open('DELETE', sessionUrl)
    xhr.send()
  } catch {
    /* best-effort */
  }
}

async function resumableUpload(
  parentId: string,
  file: File,
  onProgress?: (pct: number) => void,
  opts: { projectId?: string | null; sectionId?: string | null; authToken?: string } = {},
): Promise<FileMeta> {
  const initRes = await fetch('/api/upload/resumable', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (opts.authToken ?? sessionStorage.getItem(WORKER_TOKEN_KEY) ?? '') },
    body: JSON.stringify({ name: file.name, parentId, mimeType: file.type, size: file.size, projectId: opts.projectId ?? null, sectionId: opts.sectionId ?? null }),
  })
  if (!initRes.ok) {
    let message = `Upload init failed (${initRes.status})`
    try {
      const body = (await initRes.json()) as { error?: string }
      if (body.error) message = body.error
    } catch {
      /* keep default */
    }
    throw new DriveError(mapStatus(initRes.status), message, initRes.status)
  }
  const { url: sessionUrl, partSize, direct, completeUrl, single, presignMoreUrl } = (await initRes.json()) as {
    url: string
    partSize: number
    direct?: string[]
    completeUrl?: string
    single?: boolean
    presignMoreUrl?: string
  }

  const total = file.size
  const contentType = file.type || 'application/octet-stream'

  // ---- single-shot: one presigned PutObject, then POST the completion ----
  if (single && direct && direct.length === 1 && completeUrl) {
    const put = () => xhrPut(direct[0], file, { 'Content-Type': contentType }, (loaded) => onProgress?.(Math.round((loaded / total) * 95)), false, partTimeoutMs(total))
    let last: { status: number; error: string | null } | null = null
    for (let i = 0; i < 3; i++) {
      try {
        const res = await put()
        if (res.status === 200 || res.status === 201) {
          last = null
          break
        }
        last = { status: res.status, error: res.error }
      } catch {
        last = { status: 0, error: 'network error' }
      }
      if (i < 2) await new Promise((r) => setTimeout(r, Math.min(2 ** (i + 1) * 700, 4_000)))
    }
    if (last) throw new DriveError(mapStatus(last.status) === 'rateLimit' ? 'rateLimit' : 'api', `Upload failed (${last.status || 'network'})${last.error ? ` — ${last.error}` : ''}`, last.status || undefined)
  onProgress?.(96)
  // Completion: HEAD-verify at storage, link the doc server-side, meta.
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(completeUrl, { method: 'POST' })
      if (res.ok) {
        const body = (await res.json()) as FileMeta | { error?: string }
        if (body && !('error' in body)) {
          onProgress?.(100)
          return body as FileMeta
        }
      }
      if (res.status === 410) throw new DriveError('notFound', 'Upload session expired — restarting', 410)
    } catch (e) {
      if (e instanceof DriveError) throw e
    }
    await new Promise((r) => setTimeout(r, 1200))
  }
  throw new DriveError('api', 'Upload could not be completed — try again')
}

  let offset = 0
  let failures = 0
  let partRetries = 0
  let consecutiveFails = 0
  let useDirect = Array.isArray(direct) && direct.length > 0
  const nPartsTotal = Math.ceil(total / partSize)
  let signedParts = useDirect ? direct!.length : 0
  // Lazy presigning: big files get 16 URLs at init and replenish windows of
  // 16 whenever ≤4 remain, keeping every init (and replenish) request far
  // under the worker's CPU budget. The array stays index-aligned with parts.
  const replenish = async (): Promise<boolean> => {
    if (!presignMoreUrl || !direct) return false
    try {
      const res = await fetch(`${presignMoreUrl}&next=${signedParts + 1}`, { method: 'POST' })
      if (!res.ok) return false
      const body = (await res.json()) as { direct?: string[] }
      if (!Array.isArray(body.direct) || body.direct.length === 0) return false
      for (let k = 0; k < body.direct.length && signedParts + k < nPartsTotal; k++) direct[signedParts + k] = body.direct[k]
      signedParts += body.direct.length
      return true
    } catch {
      return false
    }
  }
  // Terminal escape for ANY retry loop: without a global budget a persistent
  // failure mode retried one part forever (the tile hung at some % — this
  // was the "fails partway and never finishes" live symptom).
  const budgetDead = (): DriveError | null =>
    consecutiveFails > MAX_CONSECUTIVE_FAILURES
      ? new DriveError('api', 'Upload keeps failing — stopped after repeated errors')
      : null
  while (offset < total) {
    const end = Math.min(offset + partSize, total)
    // ---- direct path: browser PUT straight to storage, Worker untouched ----
    if (useDirect && direct) {
      const idx = offset / partSize
      if (idx >= signedParts) {
        const ok = await replenish()
        if (!ok || !direct[idx]) {
          useDirect = false // lazy presigning failed — finish via the relay
          partRetries = 0
          continue
        }
      }
      try {
        const res = await xhrPut(direct[idx], file.slice(offset, end), { 'Content-Type': contentType }, undefined, false, partTimeoutMs(end - offset))
        if (res.status === 200 || res.status === 201) {
          partRetries = 0
          consecutiveFails = 0
          offset = end
          onProgress?.(Math.round((offset / total) * 100))
          continue
        }
        // storage edge flake — retry the direct PUT before falling back
        if (res.status === 403 || res.status === 429 || res.status >= 500) {
          if (partRetries < 2) {
            partRetries++
            consecutiveFails++
            await new Promise((r) => setTimeout(r, Math.min(2 ** partRetries * 700, 4_000)))
            continue // same part, same URL
          }
        }
        useDirect = false // anything else (or retries spent): finish via the relay
        partRetries = 0 // the relay has its own failure domain — don't inherit the direct path's spent budget
        continue
      } catch (e) {
        if (e instanceof DriveError && e.kind === 'network' && partRetries < 2) {
          partRetries++
          consecutiveFails++
          await new Promise((r) => setTimeout(r, Math.min(2 ** partRetries * 700, 4_000)))
          continue
        }
        useDirect = false
        partRetries = 0 // same — fresh retry budget for the relay
        continue
      }
    }
    // ---- relay path: bytes pass through the Worker (Content-Range protocol) ----
    try {
      const res = await xhrPut(
        sessionUrl,
        file.slice(offset, end),
        { 'Content-Type': contentType, 'Content-Range': `bytes ${offset}-${end - 1}/${total}` },
        (loaded) => onProgress?.(Math.round(((offset + loaded) / total) * 100)),
        true,
        partTimeoutMs(end - offset),
      )
      failures = 0
      if (res.status === 200 || res.status === 201) {
        if (res.json) {
          onProgress?.(100)
          return res.json
        }
        throw new DriveError('api', 'Upload finished but the server sent no metadata')
      }
      if (res.status === 308) {
        partRetries = 0
        consecutiveFails = 0
        const m = res.range?.match(/bytes=0-(\d+)/)
        offset = m ? Number(m[1]) + 1 : offset
        continue
      }
      // Server-side hiccup (429 throttle, 5xx): retry this part a few times
      // before giving up — one bad moment at storage shouldn't kill a big
      // upload. The server's own error text rides along for the UI.
      if ((res.status === 429 || res.status >= 500) && partRetries < PART_RETRIES) {
        partRetries++
        throw new DriveError('rateLimit', `Upload part failed (${res.status})${res.error ? ` — ${res.error}` : ''} — retrying`, res.status)
      }
      // Terminal (retries spent or non-retryable status): no "retrying" in
      // the message — the tile must not promise a retry that won't happen.
      throw new DriveError(mapStatus(res.status), `Upload failed (${res.status})${res.error ? ` — ${res.error}` : ''}`, res.status)
    } catch (e) {
      // The strict `<` here pairs with the throw-side increment above: once
      // PART_RETRIES are spent this is false and a persistent 429/5xx
      // TERMINATES instead of looping forever (the old `<=` made every 5xx
      // retryable indefinitely because mapStatus maps 5xx → 'rateLimit').
      if (e instanceof DriveError && e.kind === 'rateLimit' && partRetries < PART_RETRIES) {
        consecutiveFails++
        const dead = budgetDead()
        if (dead) throw dead
        await new Promise((r) => setTimeout(r, Math.min(2 ** partRetries * 1500, 12_000)))
        continue // same offset — the part never landed
      }
      if (e instanceof DriveError && e.kind !== 'network') {
        abortSession(sessionUrl)
        throw e
      }
      failures++
      consecutiveFails++
      if (failures > UPLOAD_RETRIES) {
        abortSession(sessionUrl)
        throw e instanceof DriveError ? e : new DriveError('network', 'Upload network error')
      }
      const dead = budgetDead()
      if (dead) {
        abortSession(sessionUrl)
        throw dead
      }
      // Ask the server how much it already holds, then resume from that byte.
      const status = await xhrPut(sessionUrl, null, { 'Content-Range': `bytes */${total}` }, undefined, true, 30_000).catch(() => null)
      if (status && (status.status === 200 || status.status === 201)) {
        onProgress?.(100)
        if (status.json) return status.json
      }
      const m = status?.range?.match(/bytes=0-(\d+)/)
      if (m) offset = Number(m[1]) + 1
      onProgress?.(Math.round((offset / total) * 100))
      await new Promise((r) => setTimeout(r, Math.min(2 ** failures * 1000, 15_000)))
    }
  }

  // All parts landed — the status probe (a PUT, same shape the relay uses)
  // tells the server to assemble the file. A lost completion self-verifies
  // server-side; a dead session (410) re-inits via the outer loop; if the
  // probes still can't finish it, the POST complete route is one more
  // independent attempt before the whole session is aborted. A probe that
  // flat-out REJECTS (network error/timeout) is just another failed probe —
  // it must not bypass the fallback: the server may complete the session on
  // its own, and reporting failure here makes the client's retry a duplicate.
  for (let i = 0; i < 3; i++) {
    const status = await xhrPut(sessionUrl, null, { 'Content-Range': `bytes */${total}` }, undefined, true, 30_000).catch(() => null)
    if (status && (status.status === 200 || status.status === 201)) {
      if (status.json) {
        onProgress?.(100)
        return status.json
      }
    }
    if (status && status.status === 410) throw new DriveError('notFound', 'Upload session expired — restarting', 410)
    await new Promise((r) => setTimeout(r, 1200))
  }
  if (completeUrl) {
    try {
      const res = await fetch(completeUrl, { method: 'POST' })
      if (res.ok) {
        const body = (await res.json()) as FileMeta | { error?: string }
        if (body && !('error' in body)) {
          onProgress?.(100)
          return body as FileMeta
        }
      }
    } catch { /* fall through to the terminal error */ }
  }
  abortSession(sessionUrl)
  throw new DriveError('api', 'Upload could not be completed — try again')
}

// ---------------------------------------------------------------------------
// Public URLs (thumbnails / "Open") — plain same-origin URLs, no auth
// ---------------------------------------------------------------------------

export function thumbnailUrl(key: string, _size = 400): string {
  return fileUrl(key)
}

export function webViewLink(key: string): string {
  return fileUrl(key)
}
