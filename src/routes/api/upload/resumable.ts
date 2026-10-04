// Resumable uploads — emulates the Drive resumable contract the client's
// XHR loop already speaks (client.ts uploadFile):
//   POST  init (bearer session required) → { url, partSize, direct[] }
//   PUT   chunk with Content-Range: bytes a-b/total
//           → 308 + `Range: bytes=0-N` while incomplete (keep going at N+1)
//           → 200 + FileMeta JSON when the last part lands
//   PUT   status probe with `Content-Range: bytes */total`
//           → 308 + Range (how much the server already holds)
//           → 200 + FileMeta once every byte is held (assembles the file)
//   DELETE the same u/sig URL → abort the multipart session (orphan hygiene)
// Chunk PUTs carry an HMAC-signed URL instead of the bearer header, exactly
// like the old Worker proxy did — the XHR sends no custom headers.
//
// COMPLETION LINKS THE FILE SERVER-SIDE: every success path funnels through
// finishUpload() → linkUploadedFile (the doc's fileIds entry is written here,
// with CAS), because client-side-only links get rolled back by the sync
// kernel's replay/discard/re-assert behaviors. Unknown state NEVER answers
// 308 — only a successful ListParts that genuinely shows fewer bytes does.

import { createFileRoute } from '@tanstack/react-router'
import type { Project, UploadLink } from '../../../types/schema'

interface UploadSession {
  key: string
  /** Multipart session id — ABSENT for single-shot uploads (no MPU at all). */
  uploadId?: string
  total: number
  partSize: number
  /** Single-shot mode: one presigned PutObject, completed via POST ?u=. */
  single?: boolean
  /** Expiry (epoch ms) for the capability itself — matches the presigned
   *  part URLs' 24h validity; DELETE shouldn't be forever-valid. */
  exp?: number
  projectId?: string | null
  sectionId?: string | null
  uid?: string | null
  name?: string | null
}

export const Route = createFileRoute('/api/upload/resumable')({
  server: {
    handlers: {
      // TEMP DIAGNOSTIC: admin-only. Puts 16 bytes three ways and dumps
      // OCI's raw responses — distinguishes AccessDenied XML from a
      // firewall block page from an empty-body proxy 403.
      // PENDING REMOVAL: kept until the live evidence pass (step 0) has
      // captured its output on the deployed worker.
      GET: async ({ request }) => {
        const { env } = await import('cloudflare:workers')
        const auth = await import('../../../server/auth')
        const session = await auth.requireWriterRequest(request)
        if (!session || session.role !== 'admin') return Response.json({ error: 'admin only' }, { status: 401 })
        const { AwsClient } = await import('aws4fetch')
        const testKey = 'trash/put-probe.bin'
        const out: Record<string, unknown> = {}
        const variants: Record<string, Record<string, string>> = {
          'unsigned-payload': { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
          'no-header': {},
          'signed-payload': { 'x-amz-content-sha256': await crypto.subtle.digest('SHA-256', new TextEncoder().encode('probe-test-body')).then((d) => [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')) },
        }
        for (const [name, headers] of Object.entries(variants)) {
          try {
            const client = new AwsClient({ accessKeyId: env.OCI_S3_ACCESS_KEY_ID, secretAccessKey: env.OCI_S3_SECRET_ACCESS_KEY, service: 's3', region: env.OCI_S3_REGION, retries: 0 })
            const res = await client.fetch(`${env.OCI_S3_ENDPOINT.replace(/\/+$/, '')}/${env.OCI_S3_BUCKET}/${testKey}`, {
              method: 'PUT', headers, body: 'probe-test-body',
            })
            const text = await res.text()
            out[name] = { status: res.status, body: text.slice(0, 400), cfRay: res.headers.get('cf-ray'), server: res.headers.get('server'), contentType: res.headers.get('content-type') }
          } catch (e) {
            out[name] = { threw: e instanceof Error ? e.message : String(e) }
          }
        }
        // replicate the REAL failing small upload: project prefix, spaces +
        // parens in the filename, Content-Type set, ~30KB body
        try {
          const client = new AwsClient({ accessKeyId: env.OCI_S3_ACCESS_KEY_ID, secretAccessKey: env.OCI_S3_SECRET_ACCESS_KEY, service: 's3', region: env.OCI_S3_REGION, retries: 0 })
          const { encodeKeyPath } = await import('../../../server/mime')
          const realKey = 'groups/grp_1a0c2bf747e09c843225a/prj_1a0c2d44f78403f90875f/probe testing (1).webp'
          const res = await client.fetch(`${env.OCI_S3_ENDPOINT.replace(/\/+$/, '')}/${env.OCI_S3_BUCKET}/${encodeKeyPath(realKey)}`, {
            method: 'PUT', headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'Content-Type': 'image/webp' }, body: 'x'.repeat(30_000),
          })
          const text = await res.text()
          out['real-small-upload'] = { status: res.status, key: realKey, body: text.slice(0, 400) }
        } catch (e) {
          out['real-small-upload'] = { threw: e instanceof Error ? e.message : String(e) }
        }
        return Response.json(out, { headers: { 'Cache-Control': 'no-store' } })
      },
      // POST ?u=<session>&sig=…&next=<partNumber> → presign the NEXT WINDOW
      // of direct part URLs (lazy presigning keeps big inits off the CPU cap).
      // POST ?u=<session>&sig=… → COMPLETE an in-flight multipart upload.
      // POST without → INIT: creates the MPU (or a single-shot session).
      POST: async ({ request }) => {
        const reqUrl = new URL(request.url)
        if (reqUrl.searchParams.has('next')) return presignMore(reqUrl)
        if (reqUrl.searchParams.has('u')) return completeUpload(reqUrl)
        return initUpload(request)
      },

      PUT: async ({ request }) => {
        const authorized = await authorizeSession(request)
        if (authorized instanceof Response) return authorized
        const payload = authorized

        const s3 = await import('../../../server/s3')
        const contentRange = request.headers.get('Content-Range') ?? ''

        // Status probe: `bytes */total` — report how much we already hold.
        const probe = contentRange.match(/^bytes \*\/(\d+)$/)
        if (probe && payload.single) {
          // Single-shot session: no MPU to list — the finished object IS the state.
          const h = await s3.head(payload.key).catch(() => null)
          if (h && h.size === payload.total) return finishUpload(payload)
          return new Response(null, { status: 308, headers: { 'X-Total': String(payload.total) } })
        }
        if (probe) {
          // ListParts is the state oracle — its failure is NOT "zero bytes
          // held". Retry, and on persistent failure answer 502 so the client
          // never mistakes "unknown" for "resume from 0" (that 308 loop is
          // how fully-uploaded files were declared failed).
          let parts: Awaited<ReturnType<typeof s3.listParts>> | null = null
          let listError: unknown = null
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              parts = await s3.listParts(payload.key, payload.uploadId as string)
              listError = null
              break
            } catch (e) {
              listError = e
              if (attempt < 2) await sleep(1200)
            }
          }
          if (!parts || listError) {
            const msg = listError instanceof Error ? listError.message : 'ListParts failed'
            console.error(`[upload-probe-list] ${payload.key}: ${msg}`)
            if (s3.isNoSuchUpload(listError)) {
              return new Response(null, { status: 410, headers: { 'X-Total': String(payload.total), 'X-Session-Expired': '1' } })
            }
            return Response.json({ error: msg }, { status: 502 })
          }
          const held = contiguousBytes(parts)
          // Every byte is held — assemble now. (Direct-part uploads finish
          // with this probe: it's the only worker request after the parts.)
          if (held >= payload.total && parts.length > 0) {
            let completeError: unknown = null
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                await s3.completeMpu(
                  payload.key,
                  payload.uploadId as string,
                  parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
                )
                completeError = null
                break
              } catch (e) {
                completeError = e
                if (attempt < 1) await sleep(1200)
              }
            }
            if (completeError) {
              const msg = completeError instanceof Error ? completeError.message : 'Complete failed'
              console.error(`[upload-probe-complete] ${payload.key}: ${msg}`)
              // Completed anyway? The finished object says so.
              try {
                const h = await s3.head(payload.key)
                if (h && h.size === payload.total) return finishUpload(payload)
              } catch { /* fall through */ }
              if (s3.isNoSuchUpload(completeError)) {
                return new Response(null, { status: 410, headers: { 'X-Total': String(payload.total), 'X-Session-Expired': '1' } })
              }
              return Response.json({ error: msg }, { status: 502 })
            }
            return finishUpload(payload)
          }
          const headers: Record<string, string> = { 'X-Total': String(payload.total) }
          if (held > 0) headers.Range = `bytes=0-${held - 1}`
          return new Response(null, { status: 308, headers })
        }

        const m = contentRange.match(/^bytes (\d+)-(\d+)\/(\d+)$/)
        if (!m) return Response.json({ error: 'Bad Content-Range' }, { status: 400 })
        if (payload.single || !payload.uploadId) return Response.json({ error: 'Single-shot sessions take no chunk PUTs' }, { status: 400 })
        const start = Number(m[1])
        const end = Number(m[2])
        const total = Number(m[3])
        if (total !== payload.total || end < start || end >= total) {
          return Response.json({ error: 'Content-Range mismatch' }, { status: 400 })
        }
        if (start % payload.partSize !== 0 || end - start + 1 > payload.partSize) {
          return Response.json({ error: 'Chunk not aligned with part size' }, { status: 400 })
        }

        const partNumber = Math.floor(start / payload.partSize) + 1
        const buf = await request.arrayBuffer()
        if (buf.byteLength !== end - start + 1) {
          return Response.json({ error: 'Body length does not match Content-Range' }, { status: 400 })
        }
        try {
          await s3.uploadPart(payload.key, payload.uploadId as string, partNumber, buf)
          if (end + 1 < payload.total) {
            return new Response(null, { status: 308, headers: { Range: `bytes=0-${end}` } })
          }
          // Last part — complete the MPU and return the file's meta. The
          // complete step retries once: OCI intermittently 403s with an
          // empty body here, and failing AFTER the last part landed costs
          // the client the whole re-upload.
          let lastError: unknown
          for (let completeAttempt = 0; completeAttempt < 2; completeAttempt++) {
            try {
              const parts = await s3.listParts(payload.key, payload.uploadId as string)
              await s3.completeMpu(
                payload.key,
                payload.uploadId as string,
                parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
              )
              lastError = null
              break
            } catch (e) {
              lastError = e
              if (completeAttempt === 0) await sleep(1200)
            }
          }
          if (lastError) throw lastError
          return finishUpload(payload)
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'Upload failed'
          console.error(`[upload-part] part ${partNumber} for ${payload.key}: ${msg}`)
          // The part may have landed and the session completed anyway — if
          // the finished object already exists at the full size, we're done.
          // (A retried last part after a lost completion would otherwise
          // restart the ENTIRE upload.)
          try {
            const h = await s3.head(payload.key)
            if (h && h.size === payload.total) return finishUpload(payload)
          } catch { /* fall through to the error paths */ }
          // OCI lost the session (NoSuchUpload) — tell the client to start a
          // fresh one (410 Gone) instead of hammering a dead uploadId.
          if (s3.isNoSuchUpload(e)) {
            return Response.json({ error: 'Upload session expired at storage' }, { status: 410 })
          }
          return Response.json({ error: msg }, { status: 502 })
        }
      },

      // DELETE the same u/sig URL → abort the multipart session. The client
      // fires this when it gives up so failed uploads stop leaking orphaned
      // MPU sessions. Idempotent: an already-dead session still 204s.
      DELETE: async ({ request }) => {
        const authorized = await authorizeSession(request)
        if (authorized instanceof Response) return authorized
        const payload = authorized
        if (payload.single || !payload.uploadId) return new Response(null, { status: 204 }) // nothing to abort
        const s3 = await import('../../../server/s3')
        try {
          await s3.abortMpu(payload.key, payload.uploadId)
        } catch (e) {
          if (!s3.isNoSuchUpload(e)) {
            console.error(`[upload-abort] ${payload.key}: ${e instanceof Error ? e.message : e}`)
            return Response.json({ error: 'Abort failed' }, { status: 502 })
          }
        }
        return new Response(null, { status: 204 })
      },
    },
  },
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Parts presigned per request. 10 GB ≈ 1280 parts — presigning them all at
 *  init would blow the free-plan CPU budget (each sign derives fresh HMAC
 *  keys); a 16-URL window is ~1 ms. Clients replenish ≤4 parts before dry. */
const LAZY_WINDOW = 16

/** Presign the next window of part URLs for an MPU session. */
async function presignMore(reqUrl: URL): Promise<Response> {
  const authorized = await authorizeSession(reqUrl)
  if (authorized instanceof Response) return authorized
  const payload = authorized
  if (payload.single || !payload.uploadId) return Response.json({ error: 'Single-shot sessions presign nothing' }, { status: 400 })
  const next = Number(reqUrl.searchParams.get('next'))
  const nParts = Math.ceil(payload.total / payload.partSize)
  if (!Number.isInteger(next) || next < 2 || next > nParts) return Response.json({ error: 'Bad next part number' }, { status: 400 })
  const s3 = await import('../../../server/s3')
  const end = Math.min(next + LAZY_WINDOW - 1, nParts)
  const direct: string[] = []
  for (let i = next; i <= end; i++) direct.push(await s3.presignPart(payload.key, payload.uploadId, i))
  return Response.json({ direct })
}

/** Verify the u/sig pair and decode the session payload. Returns a Response
 *  on any auth/validation failure, else the parsed session. */
async function authorizeSession(request: Request | URL): Promise<UploadSession | Response> {
  const { env } = await import('cloudflare:workers')
  const auth = await import('../../../server/auth')
  const reqUrl = request instanceof URL ? request : new URL(request.url)
  const u = reqUrl.searchParams.get('u')
  const sig = reqUrl.searchParams.get('sig')
  if (!u || !sig) return Response.json({ error: 'Missing upload target' }, { status: 400 })
  if ((await authSign(env.SESSION_SECRET, u)) !== sig) return Response.json({ error: 'Invalid upload signature' }, { status: 403 })
  let payload: UploadSession
  try {
    payload = JSON.parse(new TextDecoder().decode(auth.b64urlToBytes(u))) as UploadSession
  } catch {
    return Response.json({ error: 'Corrupt upload target' }, { status: 400 })
  }
  // Expired capability → the client's 410 path re-inits a fresh session.
  if (payload.exp && Date.now() > payload.exp) {
    return new Response(null, { status: 410, headers: { 'X-Session-Expired': '1' } })
  }
  return payload
}

/** Shared completion tail for EVERY success path (probe-complete, relay
 *  last-part, POST complete): link the file into the project doc
 *  server-side, then return the file's meta. Link failure is logged, never
 *  fatal — the bytes are already stored and the client commit backstops. */
async function finishUpload(payload: UploadSession): Promise<Response> {
  // Guest sessions re-validate their link at completion against a FRESH doc
  // read (not the 60s cache): revocation then stops a file from APPEARING
  // immediately, not within a cache-TTL window.
  if (payload.uid?.startsWith('ul_')) {
    const auth = await import('../../../server/auth')
    const { linkIsActive } = await import('../../../server/uploadLinks')
    const doc = await auth.loadNexusDoc().catch(() => null)
    const link = doc?.uploadLinks?.find((l) => l.id === payload.uid)
    const project = doc?.projects[link?.projectId ?? '']
    if (!link || !linkIsActive(link, project, Date.now())) {
      return Response.json({ error: 'This upload link is no longer active' }, { status: 401 })
    }
  }
  try {
    const { linkUploadedFile } = await import('../../../server/linking')
    const outcome = await linkUploadedFile({
      key: payload.key,
      projectId: payload.projectId ?? null,
      sectionId: payload.sectionId ?? null,
      actorUid: payload.uid ?? null,
      fileName: payload.name ?? null,
    })
    if (outcome === 'no-project') {
      console.warn(`[upload-link] ${payload.key}: no matching project — link left to the client commit`)
    }
  } catch (e) {
    console.error(`[upload-link] ${payload.key}: ${e instanceof Error ? e.message : e}`)
  }
  const { metaCore } = await import('../../../server/queries')
  return Response.json(await metaCore(payload.key))
}

async function completeUpload(reqUrl: URL): Promise<Response> {
  const authorized = await authorizeSession(reqUrl)
  if (authorized instanceof Response) return authorized
  const payload = authorized
  const s3 = await import('../../../server/s3')
  // Single-shot completion: the browser PUT the whole object direct — done
  // is simply "the object exists at the full size" (then link + meta).
  if (payload.single) {
    const h = await s3.head(payload.key).catch(() => null)
    if (h && h.size === payload.total) return finishUpload(payload)
    return Response.json({ error: 'The upload has not landed at storage yet' }, { status: 502 })
  }
  try {
    const parts = await s3.listParts(payload.key, payload.uploadId as string)
    await s3.completeMpu(
      payload.key,
      payload.uploadId as string,
      parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Complete failed'
    console.error(`[upload-complete] ${payload.key}: ${msg}`)
    // The session may have completed anyway — or every byte went direct
    // and the object already exists. Either way, done is done.
    try {
      const h = await s3.head(payload.key)
      if (h && h.size === payload.total) return finishUpload(payload)
    } catch { /* fall through */ }
    if (s3.isNoSuchUpload(e)) return Response.json({ error: 'Upload session expired at storage' }, { status: 410 })
    return Response.json({ error: msg }, { status: 502 })
  }
  return finishUpload(payload)
}

/** Guest-link branch of init: verify the bearer as an upload-link raw token.
 *  Returns the link + project, or the error Response to send. */
async function guestFromRequest(request: Request): Promise<{ link: UploadLink; project: Project } | Response> {
  const auth = await import('../../../server/auth')
  const { getRequest } = await import('@tanstack/react-start/server')
  const ip = getRequest().headers.get('CF-Connecting-IP') ?? 'unknown'
  if (auth.loginThrottled(ip)) {
    return Response.json({ error: 'Too many attempts — wait a few minutes and try again' }, { status: 429 })
  }
  const bearer = auth.bearerFrom(request)
  if (!bearer) return Response.json({ error: 'Sign in to upload' }, { status: 401 })
  const doc = await auth.loadNexusDoc().catch(() => null)
  if (!doc) return Response.json({ error: 'Workspace is not reachable — try again in a moment' }, { status: 503 })
  const { resolveUploadLink } = await import('../../../server/uploadLinks')
  const verdict = await resolveUploadLink(doc, bearer, Date.now())
  if (!verdict.ok) {
    console.log(`[upload-init] guest reject (${verdict.log}) from ${ip}`)
    return Response.json({ error: verdict.message }, { status: verdict.status })
  }
  auth.loginForgiven(ip) // successes must not count toward the failure window
  return { link: verdict.link, project: verdict.project }
}

async function initUpload(request: Request): Promise<Response> {
  const { env } = await import('cloudflare:workers')
  const auth = await import('../../../server/auth')
  const session = await auth.requireWriterRequest(request)

  // App writers authenticate with a bearer session; guests with an upload
  // link. For guests, EVERYTHING about the destination comes from the link —
  // the request's parentId/projectId/sectionId are ignored.
  let guest: { link: UploadLink; project: Project } | null = null
  if (!session) {
    const g = await guestFromRequest(request)
    if (g instanceof Response) return g
    guest = g
  }

  const body = (await request.json().catch(() => null)) as
    | { name?: string; parentId?: string; mimeType?: string; size?: number; projectId?: string; sectionId?: string | null }
    | null

  let prefix: string
  if (guest) {
    if (!body?.name || !Number.isFinite(body.size) || (body.size ?? 0) <= 0) {
      return Response.json({ error: 'Missing name/size' }, { status: 400 })
    }
    if (!guest.project.folderId) {
      return Response.json({ error: 'The project folder is not ready yet — try again in a few seconds' }, { status: 409 })
    }
    if ((body.size ?? 0) > guest.link.maxFileBytes) {
      return Response.json({ error: `Files on this link are limited to ${Math.round(guest.link.maxFileBytes / (1024 * 1024))} MB` }, { status: 413 })
    }
    prefix = guest.project.folderId
  } else {
    if (!body?.name || !body.parentId || !Number.isFinite(body.size) || (body.size ?? 0) <= 0) {
      return Response.json({ error: 'Missing name/parentId/size' }, { status: 400 })
    }
    prefix = body.parentId
  }

  const s3 = await import('../../../server/s3')
  const { sanitizeNameSegment } = await import('../../../server/mime')
  const bytes = crypto.getRandomValues(new Uint8Array(5))
  let rand = ''
  for (const b of bytes) rand += b.toString(16).padStart(2, '0')
  const id = 'f_' + Date.now().toString(16) + rand.slice(0, 10)
  const key = prefix + id + '__' + sanitizeNameSegment(body.name)
  const contentType = body.mimeType || 'application/octet-stream'
  const partSize = Number(env.PART_SIZE) || 16 * 1024 * 1024

  const nParts = Math.ceil((body.size ?? 0) / partSize)
  const exp = Date.now() + 24 * 60 * 60 * 1000
  // The session token carries the project identity so completion can link
  // the file into the doc server-side (the u/sig path has no bearer). 24h
  // expiry — same validity as the presigned URLs.
  const identity = {
    total: body.size,
    partSize,
    exp,
    projectId: guest ? guest.link.projectId : body.projectId ?? null,
    sectionId: guest ? guest.link.sectionId : body.sectionId ?? null,
    uid: guest ? guest.link.id : session!.uid,
    name: body.name,
  }

  if (nParts <= 1) {
    // Single-shot: ONE presigned PutObject and no multipart session at all —
    // zero worker→OCI write relays for the bytes. (Oracle's Cloudflare front
    // in front of the S3 endpoint intermittently 403s worker-egress PUTs with
    // empty bodies; browser-origin presigned PUTs demonstrably pass.) The
    // completion POST just HEAD-verifies the object, links it, returns meta.
    let directUrl: string
    try {
      directUrl = await s3.presignPut(key)
      console.info(`[upload-init] ${key} -> single-shot (presigned put)`)
    } catch (e) {
      console.error(`[upload-init] presignPut failed: ${e instanceof Error ? e.message : e}`)
      return Response.json({ error: e instanceof Error ? e.message : 'Storage refused the upload' }, { status: 502 })
    }
    const payload = JSON.stringify({ key, ...identity, single: true })
    const token = auth.b64url(new TextEncoder().encode(payload))
    const key_ = await authSign(env.SESSION_SECRET, token)
    const url = `/api/upload/resumable?u=${token}&sig=${key_}`
    return Response.json({ url, partSize, direct: [directUrl], completeUrl: url, single: true })
  }

  let uploadId: string
  try {
    uploadId = await s3.createMpu(key, contentType)
    console.info(`[upload-init] ${key} -> ${uploadId} (partSize ${partSize})`)
  } catch (e) {
    console.error(`[upload-init] createMpu failed: ${e instanceof Error ? e.message : e}`)
    return Response.json({ error: e instanceof Error ? e.message : 'Storage refused the upload' }, { status: 502 })
  }

  // Presign direct PUT URLs per part — the browser uploads bytes straight to
  // storage and the Worker never touches them. Only the first LAZY_WINDOW
  // parts are minted here; bigger files replenish via POST ?next= (presigning
  // every part of a 10 GB file in one request would blow the CPU budget).
  const eager = Math.min(nParts, LAZY_WINDOW)
  const direct: string[] = []
  for (let i = 1; i <= eager; i++) direct.push(await s3.presignPart(key, uploadId, i))

  const payload = JSON.stringify({ key, uploadId, ...identity })
  const token = auth.b64url(new TextEncoder().encode(payload))
  const key_ = await authSign(env.SESSION_SECRET, token)
  const url = `/api/upload/resumable?u=${token}&sig=${key_}`
  return Response.json({
    url,
    partSize,
    direct,
    completeUrl: url,
    ...(nParts > LAZY_WINDOW ? { presignMoreUrl: url } : {}),
  })
}

function contiguousBytes(parts: { partNumber: number; size: number }[]): number {
  // Parts arrive in ascending order; count only the contiguous run from 1.
  let next = 1
  let bytes = 0
  for (const p of parts) {
    if (p.partNumber !== next) break
    bytes += p.size
    next++
  }
  return bytes
}

async function authSign(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))
  let bin = ''
  for (const b of new Uint8Array(sigBuf)) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
