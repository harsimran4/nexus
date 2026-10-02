// Server functions — the app's entire write API against OCI Object Storage.
// Everything that touches s3/auth/env is imported DYNAMICALLY inside handler
// bodies so the client bundle never pulls in server-only modules (and never
// has to resolve 'cloudflare:workers').
//
// Auth model (unchanged from the old nexus-worker): HMAC-signed bearer
// session tokens in the Authorization header. The writerAuth middleware's
// .client() block attaches the token from sessionStorage; .server() verifies.

import { createServerFn, createMiddleware } from '@tanstack/react-start'
import { z } from 'zod'
import type { Session } from './auth'
import type { DriveErrorKind, FnResult, FileMeta, ListResult } from '../types/storage'
import { SYSTEM_PREFIXES } from '../types/storage'
import { DOC_KEY, FOLDER_MARKER } from './keys'

const WORKER_TOKEN_KEY = 'nexus.workerToken'

const err = (kind: DriveErrorKind, message: string): FnResult<never> => ({ ok: false, kind, message })

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

export const writerAuth = createMiddleware({ type: 'function' })
  .client(({ next }) => {
    let token: string | null = null
    try {
      token = sessionStorage.getItem(WORKER_TOKEN_KEY)
    } catch {
      token = null
    }
    return next({ headers: token ? { Authorization: 'Bearer ' + token } : {} })
  })
  .server(async ({ next }) => {
    const { env } = await import('cloudflare:workers')
    const auth = await import('./auth')
    // Function middleware doesn't receive the Request object — read it from
    // the request-scoped ALS context instead.
    const { getRequest } = await import('@tanstack/react-start/server')
    const session = await auth.verifyToken(env.SESSION_SECRET, auth.bearerFrom(getRequest()))
    // One next() call with one context shape — the union is computed first,
    // so the middleware's inferred context type stays intact.
    let verdict: { ok: false; message: string } | { ok: true; session: Session }
    if (!session || !auth.requireWriter(session)) verdict = { ok: false, message: 'Sign in required' }
    else if (!(await auth.stillValid(session))) verdict = { ok: false, message: 'Session no longer valid — sign in again' }
    else verdict = { ok: true, session }
    return next({ context: { auth: verdict } })
  })

// ---------------------------------------------------------------------------
// Meta helpers
// ---------------------------------------------------------------------------

async function mimeHelpers() {
  return import('./mime')
}

async function fileMetaFromHead(key: string, h: { etag: string; size: number; lastModified: string | null }): Promise<FileMeta> {
  const { mimeFromKey, nameFromKey } = await mimeHelpers()
  const etag = h.etag
  return {
    id: key,
    name: nameFromKey(key),
    mimeType: mimeFromKey(key),
    size: h.size,
    modifiedTime: h.lastModified ?? undefined,
    createdTime: h.lastModified ?? undefined,
    headRevisionId: etag,
    version: etag,
    md5Checksum: /^[0-9a-f]{32}$/.test(etag) ? etag : undefined,
  }
}

function folderMeta(prefix: string): FileMeta {
  const base = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
  return {
    id: prefix,
    name: base.split('/').pop() ?? prefix,
    mimeType: 'application/vnd.google-apps.folder',
  }
}

/** Mint a file id shaped like util/id.ts's uid(): f_<ms-hex><10 rand hex>. */
function mintFileId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5))
  let rand = ''
  for (const b of bytes) rand += b.toString(16).padStart(2, '0')
  return 'f_' + Date.now().toString(16) + rand.slice(0, 10)
}

function fileKey(parent: string, id: string, safeName: string): string {
  return parent + id + '__' + safeName
}

async function sha256Hex(v: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ---------------------------------------------------------------------------
// Public (no session) — login + first-run init
// ---------------------------------------------------------------------------

export const loginFn = createServerFn({ method: 'POST' })
  .validator(z.object({ secret: z.string().min(1).max(4096) }))
  .handler(async ({ data }): Promise<FnResult<{ token: string; role: string; name: string; uid: string; expiresIn: number }>> => {
    const { env } = await import('cloudflare:workers')
    const auth = await import('./auth')
    const { getRequest } = await import('@tanstack/react-start/server')
    const ip = getRequest().headers.get('CF-Connecting-IP') ?? 'unknown'
    if (auth.loginThrottled(ip)) return err('rateLimit', 'Too many login attempts — wait a few minutes and try again')
    try {
      const doc = await auth.loadNexusDoc()
      for (const user of doc.users?.app ?? []) {
        if (user.disabled) continue
        let ok = false
        if (user.auth.kind === 'token') ok = await auth.verifyStaticToken(data.secret, user.auth.hash)
        else if (user.auth.kind === 'pbkdf2') ok = await auth.verifyPassword(data.secret, user.auth)
        if (ok) {
          auth.loginForgiven(ip)
          const payload = {
            uid: user.id,
            name: user.name,
            role: user.role,
            epoch: user.sessionEpoch ?? 0,
            exp: Date.now() + auth.SESSION_TTL_SECONDS * 1000,
          }
          return {
            ok: true,
            data: {
              token: await auth.signToken(env.SESSION_SECRET, payload),
              role: user.role,
              name: user.name,
              uid: user.id,
              expiresIn: auth.SESSION_TTL_SECONDS,
            },
          }
        }
      }
      // Viewer capability tokens — the client normally checks these locally
      // against the doc; kept for parity with the old Worker route.
      const tokenHash = 'sha256$' + (await sha256Hex(data.secret))
      for (const viewer of doc.users?.viewers ?? []) {
        if (viewer.revokedAt) continue
        if (viewer.tokenHash === tokenHash) {
          auth.loginForgiven(ip)
          const payload = { uid: viewer.id, name: viewer.name, role: 'viewer' as const, exp: Date.now() + auth.SESSION_TTL_SECONDS * 1000 }
          return {
            ok: true,
            data: {
              token: await auth.signToken(env.SESSION_SECRET, payload),
              role: 'viewer',
              name: viewer.name,
              uid: viewer.id,
              expiresIn: auth.SESSION_TTL_SECONDS,
            },
          }
        }
      }
      return err('auth', 'No matching login')
    } catch (e) {
      const status = e instanceof Error && 'status' in e ? (e as { status?: number }).status : undefined
      if (status === 404) return err('notFound', 'Workspace not initialized')
      return err('api', e instanceof Error ? e.message : 'Login failed')
    }
  })

const initInput = z.object({
  setupToken: z.string().min(1),
  doc: z.record(z.string(), z.unknown()),
})

/** One-time workspace init. Gated by the SETUP_TOKEN secret; refuses when a
 *  workspace already exists. Creates the system-folder markers + nexus.json. */
export const initFn = createServerFn({ method: 'POST' })
  .validator(initInput)
  .handler(async ({ data }): Promise<FnResult<{ rootFolderId: string; nexusFileId: string }>> => {
    const { env } = await import('cloudflare:workers')
    const s3 = await import('./s3')
    const auth = await import('./auth')
    const { parseDoc } = await import('../types/schema')

    const expected = env.SETUP_TOKEN ?? ''
    if (!expected) return err('api', 'SETUP_TOKEN is not configured on the server')
    // Compare digests — no length/oracle side channel.
    if ((await sha256Hex(data.setupToken)) !== (await sha256Hex(expected))) return err('auth', 'Invalid setup token')

    if (await s3.head(DOC_KEY)) return err('api', 'A workspace already exists in this bucket — reload the app to open it')

    const parsed = parseDoc(data.doc)
    if (!parsed.ok) return err('api', 'Malformed workspace document')
    const doc = parsed.doc
    doc.ids = {
      rootFolderId: '',
      nexusFileId: DOC_KEY,
      systemFolders: { ...SYSTEM_PREFIXES },
    }
    doc.updatedAt = new Date().toISOString()

    try {
      for (const prefix of Object.values(SYSTEM_PREFIXES)) {
        await s3.put(prefix + FOLDER_MARKER, null, { contentType: 'application/x-nexus-folder' })
      }
      await s3.put(DOC_KEY, JSON.stringify(doc), { contentType: 'application/json' })
      auth.invalidateDocCache()
      return { ok: true, data: { rootFolderId: '', nexusFileId: DOC_KEY } }
    } catch (e) {
      return err('api', e instanceof Error ? e.message : 'Init failed')
    }
  })

// ---------------------------------------------------------------------------
// Document reads/writes (the sync engine's only surface)
// ---------------------------------------------------------------------------

export const docGetFn = createServerFn({ method: 'POST' })
  .middleware([writerAuth])
  .handler(async ({ context }): Promise<FnResult<{ raw: string; etag: string }>> => {
    if (!context.auth.ok) return err('auth', context.auth.message)
    try {
      const s3 = await import('./s3')
      const h = await s3.head(DOC_KEY)
      if (!h) return err('notFound', 'Workspace not initialized')
      return { ok: true, data: { raw: await s3.getText(DOC_KEY), etag: h.etag } }
    } catch (e) {
      return err('api', e instanceof Error ? e.message : 'Read failed')
    }
  })

/** Whole-doc write with optional compare-and-set on the previous ETag.
 *  (OCI ignores If-Match, so the CAS is our own read-compare-write — the
 *  sync engine's verify-then-write + rebase stays the real safety net.) */
export const docPutFn = createServerFn({ method: 'POST' })
  .validator(z.object({ raw: z.string().max(16 * 1024 * 1024), expectEtag: z.string().optional() }))
  .middleware([writerAuth])
  .handler(async ({ data, context }): Promise<FnResult<{ etag: string }>> => {
    if (!context.auth.ok) return err('auth', context.auth.message)
    try {
      const s3 = await import('./s3')
      const auth = await import('./auth')
      if (data.expectEtag !== undefined) {
        const h = await s3.head(DOC_KEY)
        if (h && h.etag !== data.expectEtag) return err('conflict', 'The workspace changed on the server — rebasing')
      }
      const res = await s3.put(DOC_KEY, data.raw, { contentType: 'application/json' })
      auth.invalidateDocCache()
      return { ok: true, data: res }
    } catch (e) {
      return err('api', e instanceof Error ? e.message : 'Write failed')
    }
  })

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const metaFn = createServerFn({ method: 'POST' })
  .validator(z.object({ key: z.string().min(1) }))
  .middleware([writerAuth])
  .handler(async ({ data }): Promise<FnResult<FileMeta>> => {
    try {
      const { metaCore } = await import('./queries')
      return { ok: true, data: await metaCore(data.key) }
    } catch (e) {
      const status = e instanceof Error && (e as { status?: number }).status === 404 ? 404 : undefined
      return status === 404 ? err('notFound', 'Not found') : err('api', e instanceof Error ? e.message : 'Meta failed')
    }
  })

export const readTextFn = createServerFn({ method: 'POST' })
  .validator(z.object({ key: z.string().min(1) }))
  .middleware([writerAuth])
  .handler(async ({ data }): Promise<FnResult<string>> => {
    try {
      const s3 = await import('./s3')
      return { ok: true, data: await s3.getText(data.key) }
    } catch (e) {
      const status = e instanceof Error && (e as { status?: number }).status === 404 ? 404 : undefined
      return status === 404 ? err('notFound', 'Not found') : err('api', e instanceof Error ? e.message : 'Read failed')
    }
  })

export const listFn = createServerFn({ method: 'POST' })
  .validator(z.object({ parent: z.string(), pageSize: z.number().int().min(1).max(1000).default(100), pageToken: z.string().optional() }))
  .middleware([writerAuth])
  .handler(async ({ data }): Promise<FnResult<ListResult>> => {
    try {
      const { listCore } = await import('./queries')
      return { ok: true, data: await listCore(data.parent, data.pageSize, data.pageToken) }
    } catch (e) {
      return err('api', e instanceof Error ? e.message : 'List failed')
    }
  })

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export const putTextFn = createServerFn({ method: 'POST' })
  .validator(z.object({ key: z.string().min(1), content: z.string().max(16 * 1024 * 1024), mimeType: z.string().default('text/markdown') }))
  .middleware([writerAuth])
  .handler(async ({ data, context }): Promise<FnResult<FileMeta>> => {
    if (!context.auth.ok) return err('auth', context.auth.message)
    try {
      const s3 = await import('./s3')
      const res = await s3.put(data.key, data.content, { contentType: data.mimeType })
      return {
        ok: true,
        data: await fileMetaFromHead(data.key, {
          etag: res.etag,
          size: new TextEncoder().encode(data.content).length,
          lastModified: new Date().toUTCString(),
        }),
      }
    } catch (e) {
      return err('api', e instanceof Error ? e.message : 'Write failed')
    }
  })

export const folderCreateFn = createServerFn({ method: 'POST' })
  .validator(z.object({ name: z.string().min(1), parentId: z.string().nullable(), key: z.string().min(1).regex(/\/$/) }))
  .middleware([writerAuth])
  .handler(async ({ data, context }): Promise<FnResult<FileMeta>> => {
    if (!context.auth.ok) return err('auth', context.auth.message)
    try {
      const s3 = await import('./s3')
      await s3.put(data.key + FOLDER_MARKER, null, { contentType: 'application/x-nexus-folder' })
      return { ok: true, data: folderMeta(data.key) }
    } catch (e) {
      return err('api', e instanceof Error ? e.message : 'Folder creation failed')
    }
  })

export const fileCreateFn = createServerFn({ method: 'POST' })
  .validator(z.object({ name: z.string().min(1), parentId: z.string(), content: z.string(), mimeType: z.string() }))
  .middleware([writerAuth])
  .handler(async ({ data, context }): Promise<FnResult<FileMeta>> => {
    if (!context.auth.ok) return err('auth', context.auth.message)
    try {
      const s3 = await import('./s3')
      const { sanitizeNameSegment } = await mimeHelpers()
      const id = mintFileId()
      const key = fileKey(data.parentId, id, sanitizeNameSegment(data.name))
      await s3.put(key, data.content, { contentType: data.mimeType })
      return {
        ok: true,
        data: await fileMetaFromHead(key, {
          etag: (await s3.head(key))?.etag ?? '',
          size: new TextEncoder().encode(data.content).length,
          lastModified: new Date().toUTCString(),
        }),
      }
    } catch (e) {
      return err('api', e instanceof Error ? e.message : 'File creation failed')
    }
  })

export const fileCopyFn = createServerFn({ method: 'POST' })
  .validator(z.object({ key: z.string().min(1), name: z.string().min(1), parentId: z.string() }))
  .middleware([writerAuth])
  .handler(async ({ data, context }): Promise<FnResult<FileMeta>> => {
    if (!context.auth.ok) return err('auth', context.auth.message)
    try {
      const s3 = await import('./s3')
      const { sanitizeNameSegment } = await mimeHelpers()
      const id = mintFileId()
      const dst = fileKey(data.parentId, id, sanitizeNameSegment(data.name))
      await s3.copy(data.key, dst)
      const h = await s3.head(dst)
      if (!h) return err('api', 'Copy vanished after completion')
      return { ok: true, data: await fileMetaFromHead(dst, h) }
    } catch (e) {
      return err('api', e instanceof Error ? e.message : 'Copy failed')
    }
  })

const TRASH_BATCH = 25 // stay far under the per-request subrequest cap

/** Move one key (or up to TRASH_BATCH keys of one prefix) into trash/.
 *  Returns `remaining > 0` for prefixes so the client can loop. */
export const trashFn = createServerFn({ method: 'POST' })
  .validator(z.object({ key: z.string().min(1) }))
  .middleware([writerAuth])
  .handler(async ({ data, context }): Promise<FnResult<{ trashed: number; remaining: boolean }>> => {
    if (!context.auth.ok) return err('auth', context.auth.message)
    try {
      const s3 = await import('./s3')
      const stamp = String(Date.now())
      if (!data.key.endsWith('/')) {
        await s3.copy(data.key, `${s3.TRASH_PREFIX}${stamp}/${data.key}`)
        await s3.del(data.key)
        return { ok: true, data: { trashed: 1, remaining: false } }
      }
      const page = await s3.list({ prefix: data.key, maxKeys: TRASH_BATCH })
      for (const entry of page.contents) {
        await s3.copy(entry.key, `${s3.TRASH_PREFIX}${stamp}/${entry.key}`)
        await s3.del(entry.key)
      }
      return { ok: true, data: { trashed: page.contents.length, remaining: page.isTruncated } }
    } catch (e) {
      return err('api', e instanceof Error ? e.message : 'Delete failed')
    }
  })

/** Rename a FILE: copy to `<dir><sameId>__<newname>` + delete old. The key
 *  changes — the client rewrites the doc (fileIds/mediaSectionOf) in the
 *  same commit. Folder prefixes: nothing to do (names live in the doc). */
export const renameFn = createServerFn({ method: 'POST' })
  .validator(z.object({ key: z.string().min(1), newName: z.string().min(1) }))
  .middleware([writerAuth])
  .handler(async ({ data, context }): Promise<FnResult<FileMeta>> => {
    if (!context.auth.ok) return err('auth', context.auth.message)
    try {
      const s3 = await import('./s3')
      const { sanitizeNameSegment } = await mimeHelpers()
      const dir = data.key.slice(0, data.key.lastIndexOf('/') + 1)
      const seg = data.key.slice(dir.length)
      const idSeg = seg.includes('__') ? seg.slice(0, seg.indexOf('__')) : seg
      const newKey = dir + idSeg + '__' + sanitizeNameSegment(data.newName)
      if (newKey !== data.key) {
        await s3.copy(data.key, newKey)
        await s3.del(data.key)
      }
      const h = await s3.head(newKey)
      if (!h) return err('notFound', 'File vanished during rename')
      return { ok: true, data: await fileMetaFromHead(newKey, h) }
    } catch (e) {
      return err('api', e instanceof Error ? e.message : 'Rename failed')
    }
  })

export const uploadSmallFn = createServerFn({ method: 'POST' })
  .validator((input: FormData) => input) // identity: the payload IS the form
  .middleware([writerAuth])
  .handler(async ({ data, context }): Promise<FnResult<FileMeta>> => {
    if (!context.auth.ok) return err('auth', context.auth.message)
    try {
      if (!(data instanceof FormData)) return err('api', 'Expected multipart form data')
      const parentId = String(data.get('parentId') ?? '')
      const file = data.get('file')
      if (!parentId || !(file instanceof File)) return err('api', 'Missing parentId or file')
      const s3 = await import('./s3')
      const { sanitizeNameSegment } = await mimeHelpers()
      const id = mintFileId()
      const key = fileKey(parentId, id, sanitizeNameSegment(file.name))
      const buf = await file.arrayBuffer()
      await s3.put(key, buf, { contentType: file.type || 'application/octet-stream' })
      const h = await s3.head(key)
      return {
        ok: true,
        data: await fileMetaFromHead(key, h ?? { etag: '', size: buf.byteLength, lastModified: new Date().toUTCString() }),
      }
    } catch (e) {
      return err('api', e instanceof Error ? e.message : 'Upload failed')
    }
  })

/** Bucket facts for the Admin storage card (admin-only). */
export const storageInfoFn = createServerFn({ method: 'POST' })
  .middleware([writerAuth])
  .handler(async ({ context }): Promise<FnResult<{ bucket: string; endpoint: string; region: string }>> => {
    if (!context.auth.ok) return err('auth', context.auth.message)
    if (context.auth.session.role !== 'admin') return err('permission', 'Admin only')
    const { env } = await import('cloudflare:workers')
    return { ok: true, data: { bucket: env.OCI_S3_BUCKET, endpoint: env.OCI_S3_ENDPOINT, region: env.OCI_S3_REGION } }
  })
