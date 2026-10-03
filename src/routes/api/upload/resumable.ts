// Resumable uploads — emulates the Drive resumable contract the client's
// XHR loop already speaks (client.ts uploadFile):
//   POST  init (bearer session required) → { url, partSize }
//   PUT   chunk with Content-Range: bytes a-b/total
//           → 308 + `Range: bytes=0-N` while incomplete (keep going at N+1)
//           → 200 + FileMeta JSON when the last part lands
//   PUT   status probe with `Content-Range: bytes */total`
//           → 308 + Range (how much the server already holds)
// Chunk PUTs carry an HMAC-signed URL instead of the bearer header, exactly
// like the old Worker proxy did — the XHR sends no custom headers.

import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/upload/resumable')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // TEMP DIAGNOSTIC: admin-only. Puts 16 bytes three ways and dumps
        // OCI's raw responses — distinguishes AccessDenied XML from a
        // firewall block page from an empty-body proxy 403.
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
      POST: async ({ request }) => {
        const { env } = await import('cloudflare:workers')
        const auth = await import('../../../server/auth')
        const session = await auth.requireWriterRequest(request)
        if (!session) return Response.json({ error: 'Sign in to upload' }, { status: 401 })

        const body = (await request.json().catch(() => null)) as
          | { name?: string; parentId?: string; mimeType?: string; size?: number }
          | null
        if (!body?.name || !body.parentId || !Number.isFinite(body.size) || (body.size ?? 0) <= 0) {
          return Response.json({ error: 'Missing name/parentId/size' }, { status: 400 })
        }

        const s3 = await import('../../../server/s3')
        const { sanitizeNameSegment } = await import('../../../server/mime')
        const bytes = crypto.getRandomValues(new Uint8Array(5))
        let rand = ''
        for (const b of bytes) rand += b.toString(16).padStart(2, '0')
        const id = 'f_' + Date.now().toString(16) + rand.slice(0, 10)
        const key = body.parentId + id + '__' + sanitizeNameSegment(body.name)
        const contentType = body.mimeType || 'application/octet-stream'
        const partSize = Number(env.PART_SIZE) || 16 * 1024 * 1024

        let uploadId: string
        try {
          uploadId = await s3.createMpu(key, contentType)
          console.info(`[upload-init] ${key} -> ${uploadId} (partSize ${partSize})`)
        } catch (e) {
          console.error(`[upload-init] createMpu failed: ${e instanceof Error ? e.message : e}`)
          return Response.json({ error: e instanceof Error ? e.message : 'Storage refused the upload' }, { status: 502 })
        }

        const payload = JSON.stringify({ key, uploadId, total: body.size, partSize })
        const token = auth.b64url(new TextEncoder().encode(payload))
        const key_ = await authSign(env.SESSION_SECRET, token)
        const url = `/api/upload/resumable?u=${token}&sig=${key_}`
        return Response.json({ url, partSize })
      },

      PUT: async ({ request }) => {
        const { env } = await import('cloudflare:workers')
        const auth = await import('../../../server/auth')
        const reqUrl = new URL(request.url)
        const u = reqUrl.searchParams.get('u')
        const sig = reqUrl.searchParams.get('sig')
        if (!u || !sig) return Response.json({ error: 'Missing upload target' }, { status: 400 })
        const expect = await authSign(env.SESSION_SECRET, u)
        if (expect !== sig) return Response.json({ error: 'Invalid upload signature' }, { status: 403 })
        let payload: { key: string; uploadId: string; total: number; partSize: number }
        try {
          payload = JSON.parse(new TextDecoder().decode(auth.b64urlToBytes(u)))
        } catch {
          return Response.json({ error: 'Corrupt upload target' }, { status: 400 })
        }

        const s3 = await import('../../../server/s3')
        const { metaCore } = await import('../../../server/queries')
        const contentRange = request.headers.get('Content-Range') ?? ''

        // Status probe: `bytes */total` — report how much we already hold.
        const probe = contentRange.match(/^bytes \*\/(\d+)$/)
        if (probe) {
          const parts = await s3.listParts(payload.key, payload.uploadId).catch(() => [])
          const held = contiguousBytes(parts)
          const headers: Record<string, string> = { 'X-Total': String(payload.total) }
          if (held > 0) headers.Range = `bytes=0-${held - 1}`
          return new Response(null, { status: 308, headers })
        }

        const m = contentRange.match(/^bytes (\d+)-(\d+)\/(\d+)$/)
        if (!m) return Response.json({ error: 'Bad Content-Range' }, { status: 400 })
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
          await s3.uploadPart(payload.key, payload.uploadId, partNumber, buf)
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
              const parts = await s3.listParts(payload.key, payload.uploadId)
              await s3.completeMpu(
                payload.key,
                payload.uploadId,
                parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
              )
              lastError = null
              break
            } catch (e) {
              lastError = e
              if (completeAttempt === 0) await new Promise((r) => setTimeout(r, 1200))
            }
          }
          if (lastError) throw lastError
          const meta = await metaCore(payload.key)
          return Response.json(meta)
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'Upload failed'
          console.error(`[upload-part] part ${partNumber} for ${payload.key}: ${msg}`)
          // The part may have landed and the session completed anyway — if
          // the finished object already exists at the full size, we're done.
          // (A retried last part after a lost completion would otherwise
          // restart the ENTIRE upload.)
          try {
            const h = await s3.head(payload.key)
            if (h && h.size === payload.total) {
              const { metaCore } = await import('../../../server/queries')
              return Response.json(await metaCore(payload.key))
            }
          } catch { /* fall through to the error paths */ }
          // OCI lost the session (NoSuchUpload) — tell the client to start a
          // fresh one (410 Gone) instead of hammering a dead uploadId.
          if (/no such upload/i.test(msg)) {
            return Response.json({ error: 'Upload session expired at storage' }, { status: 410 })
          }
          return Response.json({ error: msg }, { status: 502 })
        }
      },
    },
  },
})

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
