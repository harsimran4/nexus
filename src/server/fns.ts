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
import type { DriveErrorKind, FnResult, FileMeta, ListResult, UploadProgressSession } from '../types/storage'
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
    // Same per-isolate throttle as login — SETUP_TOKEN is a public secret check.
    const { getRequest } = await import('@tanstack/react-start/server')
    const ip = getRequest().headers.get('CF-Connecting-IP') ?? 'unknown'
    if (auth.loginThrottled(ip)) return err('rateLimit', 'Too many attempts — wait a few minutes and try again')

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
      // P4 shadow: a fresh workspace is the mirror's first full insert.
      try {
        const { mirrorDocChange } = await import('./d1/mirror')
        await mirrorDocChange(null, doc, 'init')
      } catch (e) {
        console.error(`[d1-mirror] init: transition skipped (${e instanceof Error ? e.message : e})`)
      }
      await (await import('./hub')).notifyWorkspaceChange(doc.rev) // P5 live push — never throws
      auth.loginForgiven(ip) // success — don't count this attempt toward the throttle
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

/** Stage-3 boot snapshot: the workspace doc as D1 regenerates it — ONE
 *  batched read = one transactionally consistent snapshot. Below stage 3
 *  this returns just the stage and the client falls back to the bucket doc. */

/** P8 — the share-link read. The token IS the credential (same trust model
 *  as the upload-link routes): hash it, find the viewer (D1 point query —
 *  the mirror keeps the table fresh at every stage — with the bucket doc as
 *  fallback below stage 3), then answer with ONLY what the scope allows.
 *  A scoped viewer receives ONE project + its group + its thread/refs/
 *  scripts — the rest of the workspace is never serialized, which is the
 *  enforcement (server-side, not client filters). */
export const scopedBootstrapFn = createServerFn({ method: 'POST' })
  .validator(z.object({ token: z.string().min(16).max(256) }))
  .handler(
    async ({
      data,
    }): Promise<FnResult<{ raw: string; projectId: string | null; viewerId: string; viewerName: string }>> => {
      try {
        const { env } = await import('cloudflare:workers')
        const auth = await import('./auth')
        const hash = 'sha256$' + (await auth.sha256Hex(data.token))

        let viewer: { id: string; name: string; scope: string; revokedAt: string | null } | null = null
        if (env.DB) {
          const res = await env.DB.prepare('SELECT id, name, scope, revoked_at FROM viewers WHERE token_hash = ?').bind(hash).run()
          const row = (res.results as { id: string; name: string; scope?: string; revoked_at?: string }[] | undefined)?.[0]
          if (row) {
            viewer = { id: String(row.id), name: String(row.name), scope: String(row.scope ?? ''), revokedAt: row.revoked_at != null ? String(row.revoked_at) : null }
          }
        }
        if (!viewer) {
          // No binding or the row hasn't mirrored — the bucket doc is truth.
          const s3 = await import('./s3')
          const { DOC_KEY } = await import('./keys')
          const doc = JSON.parse(await s3.getText(DOC_KEY)) as {
            users?: { viewers?: { id: string; name: string; scope?: string; revokedAt?: string | null; tokenHash: string }[] }
          }
          const v = (doc.users?.viewers ?? []).find((x) => x.tokenHash === hash)
          if (v) viewer = { id: v.id, name: v.name, scope: v.scope ?? '', revokedAt: v.revokedAt ?? null }
        }
        if (!viewer) return err('notFound', 'This link is not valid')
        if (viewer.revokedAt) return err('permission', 'This link was revoked')

        const s3 = await import('./s3')
        const { DOC_KEY } = await import('./keys')

        if (!viewer.scope) {
          // Whole-workspace viewer: the full doc — the exact bytes the public
          // read path already serves (no new exposure).
          return { ok: true, data: { raw: await s3.getText(DOC_KEY), projectId: null, viewerId: viewer.id, viewerName: viewer.name } }
        }

        // SCOPED: regenerate (stage 3 reads D1; below, the doc IS truth) and
        // filter BEFORE serialization. The full read is one batched read —
        // per-project point queries are a later optimization, the FILTER is
        // the enforcement.
        let full: import('../server/d1/tables').LightDoc
        if (env.DB) {
          const apply = await import('./d1/apply')
          if ((await apply.readStage(env.DB)) >= 3) {
            const regen = await import('./d1/regen')
            const tables = await import('./d1/tables')
            full = tables.rowsToDoc(await regen.readAllRows(env.DB))
          } else {
            full = JSON.parse(await s3.getText(DOC_KEY))
          }
        } else {
          full = JSON.parse(await s3.getText(DOC_KEY))
        }
        const project = (full.projects as Record<string, { deleted?: unknown; groupId: string }> | undefined)?.[viewer.scope]
        if (!project || project.deleted) return err('notFound', 'This project is no longer available')
        const gid = project.groupId
        const subset = {
          schema: full.schema ?? 1,
          rev: full.rev ?? 0,
          writerId: full.writerId,
          updatedAt: full.updatedAt,
          ids: full.ids,
          settings: full.settings,
          users: {
            studioSub: null,
            app: [],
            // the scoped viewer's own entry (their hash is useless without the
            // token they already hold in the URL)
            viewers: [{ id: viewer.id, name: viewer.name, tokenHash: hash, createdAt: '', createdBy: '', revokedAt: null, note: '', scope: viewer.scope }],
          },
          uploadLinks: [],
          refs: (full.refs ?? []).filter((r) => r.projectId === viewer!.scope),
          comments: (full.comments ?? []).filter((c) => c.projectId === viewer!.scope),
          groups: Object.fromEntries(Object.entries(full.groups ?? {}).filter(([id]) => id === gid)),
          projects: { [viewer.scope]: project },
          scripts: Object.fromEntries(Object.entries(full.scripts ?? {}).filter(([, s]) => (s as { projectId?: string | null }).projectId === viewer!.scope)),
          tombstones: [],
          activity: [],
          snapshots: [],
        }
        return { ok: true, data: { raw: JSON.stringify(subset), projectId: viewer.scope, viewerId: viewer.id, viewerName: viewer.name } }
      } catch (e) {
        return err('api', e instanceof Error ? e.message : 'Share link failed')
      }
    },
  )

export const bootstrapFn = createServerFn({ method: 'POST' })
  .middleware([writerAuth])
  .handler(async ({ context }): Promise<FnResult<{ raw?: string; rev?: number; stage: 1 | 2 | 3 }>> => {
    if (!context.auth.ok) return err('auth', context.auth.message)
    try {
      const { env } = await import('cloudflare:workers')
      if (!env.DB) return { ok: true, data: { stage: 1 } }
      const apply = await import('./d1/apply')
      const stage = await apply.readStage(env.DB)
      if (stage < 3) return { ok: true, data: { stage } }
      const regen = await import('./d1/regen')
      const tables = await import('./d1/tables')
      const doc = tables.rowsToDoc(await regen.readAllRows(env.DB))
      return { ok: true, data: { raw: JSON.stringify(doc), rev: doc.rev, stage: 3 } }
    } catch (e) {
      return err('api', e instanceof Error ? e.message : 'Bootstrap read failed')
    }
  })

/** Whole-doc write with optional compare-and-set on the previous ETag.
 *  (OCI ignores If-Match, so the CAS is our own read-compare-write — the
 *  sync engine's verify-then-write + rebase stays the real safety net.)
 *
 *  P4 shadow: the transition (prev doc → new doc) also mirrors into D1.
 *  The mirror NEVER fails the write — it logs, and /api/debug/d1?op=diff
 *  is the instrument that surfaces any drift. */
export const docPutFn = createServerFn({ method: 'POST' })
  .validator(z.object({ raw: z.string().max(16 * 1024 * 1024), expectEtag: z.string().optional() }))
  .middleware([writerAuth])
  .handler(async ({ data, context }): Promise<FnResult<{ etag: string }>> => {
    if (!context.auth.ok) return err('auth', context.auth.message)
    try {
      const { env } = await import('cloudflare:workers')
      // STAGE 3: the doc is derived — whole-doc writes are refused and old
      // tabs fall to the read-only path. Reload picks up the gateway client.
      if (env.DB) {
        const apply = await import('./d1/apply')
        if ((await apply.readStage(env.DB)) >= 3) {
          return err('permission', 'The workspace now lives in its database — reload the page to keep editing')
        }
      }
      const s3 = await import('./s3')
      const auth = await import('./auth')
      if (data.expectEtag !== undefined) {
        const h = await s3.head(DOC_KEY)
        if (h && h.etag !== data.expectEtag) return err('conflict', 'The workspace changed on the server — rebasing')
      }
      // Snapshot the doc we're about to overwrite. Absent workspace → null
      // (full insert); unreadable/transient read → skip this one transition.
      let prevDoc: unknown = null
      let mirrorable = true
      try {
        prevDoc = JSON.parse(await s3.getText(DOC_KEY))
      } catch (e) {
        if (!(e instanceof Error && 'status' in e && (e as { status?: number }).status === 404)) mirrorable = false
      }
      const res = await s3.put(DOC_KEY, data.raw, { contentType: 'application/json' })
      auth.invalidateDocCache()
      const nextDoc = JSON.parse(data.raw)
      if (mirrorable) {
        try {
          const { mirrorDocChange } = await import('./d1/mirror')
          await mirrorDocChange(prevDoc, nextDoc, 'docPut')
        } catch (e) {
          console.error(`[d1-mirror] docPut: transition skipped (${e instanceof Error ? e.message : e})`)
        }
      }
      await (await import('./hub')).notifyWorkspaceChange(nextDoc.rev ?? 0) // P5 live push — never throws
      return { ok: true, data: res }
    } catch (e) {
      return err('api', e instanceof Error ? e.message : 'Write failed')
    }
  })

/** Live guest-upload sessions for the owner's pill: read the progress/
 *  beacon objects (one small overwrite per report — no doc contention).
 *  Active sessions gone quiet >30min are dead (tab closed) and dropped;
 *  completed ones linger an hour so the owner sees the outcome. */
export const uploadProgressFn = createServerFn({ method: 'POST' })
  .middleware([writerAuth])
  .handler(async ({ context }): Promise<FnResult<UploadProgressSession[]>> => {
    if (!context.auth.ok) return err('auth', context.auth.message)
    try {
      const s3 = await import('./s3')
      const auth = await import('./auth')
      const page = await s3.list({ prefix: 'progress/', maxKeys: 20 })
      const sessions: UploadProgressSession[] = []
      const now = Date.now()
      for (const entry of page.contents) {
        if (!entry.key.startsWith('progress/') || !entry.key.endsWith('.json')) continue
        try {
          const rec = JSON.parse(await s3.getText(entry.key)) as UploadProgressSession
          if (typeof rec.linkId !== 'string' || typeof rec.at !== 'string') continue
          const age = now - Date.parse(rec.at)
          if (rec.state === 'active' ? age > 30 * 60_000 : age > 60 * 60_000) continue
          sessions.push(rec)
        } catch {
          continue // one unreadable beacon never blocks the rest
        }
      }
      if (sessions.length > 0) {
        const doc = await auth.getCachedDoc()
        for (const s of sessions) s.projectName = doc?.projects[s.projectId]?.name
      }
      return { ok: true, data: sessions }
    } catch (e) {
      return err('api', e instanceof Error ? e.message : 'Progress read failed')
    }
  })

// ---------------------------------------------------------------------------
// Stage-2 mutation gateway — transactional entity ops (see docs/d1-migration.md)
// ---------------------------------------------------------------------------

/** Apply a batch of validated entity ops in ONE D1 transaction under the
 *  kernel's LWW/tombstone rules, then write through (regenerate nexus.json
 *  from D1 and put it). Below stage 2 this refuses softly so the client
 *  falls back to the whole-doc writer. */
export const mutateFn = createServerFn({ method: 'POST' })
  .validator(z.object({ ops: z.array(z.unknown()).max(500), baseRev: z.number().int().min(0).optional() }))
  .middleware([writerAuth])
  .handler(async ({ data, context }): Promise<FnResult<{ applied: boolean; stage: 1 | 2 | 3; rev?: number; etag?: string }>> => {
    if (!context.auth.ok) return err('auth', context.auth.message)
    if (context.auth.session.role === 'viewer') return err('permission', 'Viewers cannot edit')
    try {
      const { env } = await import('cloudflare:workers')
      if (!env.DB) return { ok: true, data: { applied: false, stage: 1 } }
      const apply = await import('./d1/apply')
      const stage = await apply.readStage(env.DB)
      if (stage < 2) return { ok: true, data: { applied: false, stage } }
      // Validation failures are 'api' (won't fix itself — the client gateway
      // falls back to the legacy writer); only D1/write-through races are
      // 'conflict' (retryable).
      let ops
      try {
        ops = apply.validateOps(data.ops, { allowStrong: context.auth.session.role === 'admin' })
      } catch (ve) {
        console.error(`[mutateFn] validation rejected: ${ve instanceof Error ? ve.message : ve}`)
        return err('api', ve instanceof Error ? ve.message : 'Invalid mutation batch')
      }
      const { hlcNow } = await import('../util/hlc')
      const stamp = hlcNow()
      const compiled = await apply.compileOps(ops)
      const stmts = [...apply.bookkeepingOps(`gateway:${context.auth.session.uid}`, stamp), ...compiled].map((op) =>
        op.args.length ? env.DB!.prepare(op.sql).bind(...op.args) : env.DB!.prepare(op.sql),
      )
      await env.DB.batch(stmts)
      const s3 = await import('./s3')
      const { DOC_KEY } = await import('./keys')
      const wt = await apply.writeThrough(env.DB, s3, DOC_KEY)
      // P5 live push — broadcast AFTER the write-through lands, so a reacting
      // tab's meta check sees the fresh derived doc immediately.
      await (await import('./hub')).notifyWorkspaceChange(wt.rev)
      return { ok: true, data: { applied: true, stage, rev: wt.rev, etag: wt.etag } }
    } catch (e) {
      console.error(`[mutateFn] apply failed: ${e instanceof Error ? e.message : e}`)
      return err('conflict', e instanceof Error ? e.message : 'Mutation failed')
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

// Workers free plan caps ~50 subrequests/request. Each object costs a copy
// + a delete, each batch one list, and a cold isolate spends one more on
// writerAuth's doc re-check — keep the worst case well under.
const SUBREQUEST_BUDGET = 40
const TRASH_BATCH = Math.floor(SUBREQUEST_BUDGET / 2) - 1 // 19 objects
const MOVE_BATCH = TRASH_BATCH // same cap, same loop-until-empty contract

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

/** Move one prefix under another, PRESERVING each key's relative path (a
 *  project moving groups keeps its file ids). Client loops while `remaining`. */
export const movePrefixFn = createServerFn({ method: 'POST' })
  .validator(z.object({ from: z.string().regex(/\/$/), to: z.string().regex(/\/$/) }))
  .middleware([writerAuth])
  .handler(async ({ data, context }): Promise<FnResult<{ moved: number; remaining: boolean }>> => {
    if (!context.auth.ok) return err('auth', context.auth.message)
    try {
      const s3 = await import('./s3')
      if (data.from === data.to || data.to.startsWith(data.from) || data.from.startsWith(data.to)) {
        return err('api', 'Refusing to move a prefix into itself')
      }
      const page = await s3.list({ prefix: data.from, maxKeys: MOVE_BATCH })
      for (const entry of page.contents) {
        const rel = entry.key.slice(data.from.length)
        await s3.copy(entry.key, data.to + rel)
        await s3.del(entry.key)
      }
      return { ok: true, data: { moved: page.contents.length, remaining: page.isTruncated } }
    } catch (e) {
      return err('api', e instanceof Error ? e.message : 'Move failed')
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
      const projectId = String(data.get('projectId') ?? '') || null
      const sectionId = String(data.get('sectionId') ?? '') || null
      const s3 = await import('./s3')
      const { sanitizeNameSegment } = await mimeHelpers()
      const id = mintFileId()
      const key = fileKey(parentId, id, sanitizeNameSegment(file.name))
      const buf = await file.arrayBuffer()
      // Storage's edge intermittently 403s worker-origin PUTs (empty body,
      // passes on retry) — don't let one flake kill the upload.
      let putError: unknown
      let etag = ''
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          etag = (await s3.put(key, buf, { contentType: file.type || 'application/octet-stream' })).etag
          putError = null
          break
        } catch (e) {
          putError = e
          if (attempt < 2) await new Promise((r) => setTimeout(r, 900))
        }
      }
      if (putError) throw putError
      // Meta from the put's OWN etag — the old post-put verification HEAD sat
      // outside the retry loop, so one HEAD flake reported failure for bytes
      // that were already safely stored (user retries → duplicate object).
      const meta = await fileMetaFromHead(key, { etag, size: buf.byteLength, lastModified: new Date().toUTCString() })
      // Link the file into the project doc server-side — the client commit is
      // only a UI mirror (sync-kernel replay/discard/re-assert can undo it).
      try {
        const { linkUploadedFile } = await import('./linking')
        const { outcome } = await linkUploadedFile({
          key,
          projectId,
          sectionId,
          actorUid: context.auth.session.uid,
          fileName: file.name,
        })
        if (outcome === 'no-project') {
          console.warn(`[upload-link] ${key}: no matching project — link left to the client commit`)
        }
      } catch (e) {
        console.error(`[upload-link] ${key}: ${e instanceof Error ? e.message : e}`)
      }
      return { ok: true, data: meta }
    } catch (e) {
      return err('api', e instanceof Error ? e.message : 'Upload failed')
    }
  })

/** Store a generated thumbnail for a media object. The thumb key is derived
 *  SERVER-SIDE from the media key's id segment (thumbs/<id>.jpg) — the client
 *  never picks the storage location. Thumbnails are optional cache warmers:
 *  losing one just falls back to the video's own first frame. */
export const putThumbFn = createServerFn({ method: 'POST' })
  .validator((input: FormData) => input) // identity: the payload IS the form
  .middleware([writerAuth])
  .handler(async ({ data, context }): Promise<FnResult<{ etag: string }>> => {
    if (!context.auth.ok) return err('auth', context.auth.message)
    try {
      if (!(data instanceof FormData)) return err('api', 'Expected multipart form data')
      const file = data.get('file')
      const mediaKey = String(data.get('mediaKey') ?? '')
      if (!(file instanceof File) || !mediaKey) return err('api', 'Missing file or mediaKey')
      const base = mediaKey.slice(mediaKey.lastIndexOf('/') + 1)
      const id = base.split('__')[0]
      if (!base.includes('__') || !id) return err('api', 'Bad media key')
      if (file.size > 300 * 1024) return err('api', 'Thumbnail too large (300 KB max)')
      const contentType = file.type || 'image/jpeg'
      if (contentType !== 'image/jpeg') return err('api', 'Thumbnails must be JPEG')
      const s3 = await import('./s3')
      const res = await s3.put(`thumbs/${id}.jpg`, await file.arrayBuffer(), { contentType: 'image/jpeg' })
      return { ok: true, data: res }
    } catch (e) {
      return err('api', e instanceof Error ? e.message : 'Thumbnail upload failed')
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

