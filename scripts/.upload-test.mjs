// E2E: presigned DIRECT upload — mirrors the browser's new path exactly.
// init (worker) → PUT parts straight to OCI (presigned URLs, no worker) →
// POST completeUrl (worker) → meta. Cleans up after.
import { readFileSync } from 'node:fs'
import { webcrypto as crypto } from 'node:crypto'

const dev = Object.fromEntries(
  readFileSync('.dev.vars', 'utf8').split(/\r?\n/).map((l) => {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/)
    return m ? [m[1], m[2]] : null
  }).filter(Boolean),
)
const wr = JSON.parse(readFileSync('wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, ''))
const b64url = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
async function hmac(payload, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)))
}

const base = 'http://localhost:5173'
const doc = await (await fetch(`${base}/files/master/nexus.json`)).json()
const user = doc.users.app[0]
const session = { uid: user.id, name: user.name, role: 'admin', epoch: user.sessionEpoch ?? 0, exp: Date.now() + 3600_000 }
const sBody = b64url(JSON.stringify(session))
const bearer = `${sBody}.${await hmac(sBody, dev.SESSION_SECRET)}`

const parentId = Object.values(doc.projects).find((p) => p.fileIds.length)?.folderId
const total = 20 * 1024 * 1024
const init = await fetch(`${base}/api/upload/resumable`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
  body: JSON.stringify({ name: 'direct-test.mp4', parentId, mimeType: 'video/mp4', size: total }),
})
const initBody = await init.json()
console.log('init:', init.status, '| partSize:', initBody.partSize, '| direct URLs:', initBody.direct?.length, '| completeUrl:', Boolean(initBody.completeUrl))
if (!init.ok || !initBody.direct?.length) process.exit(1)
const { direct, partSize, completeUrl } = initBody

const t0 = Date.now()
for (let i = 0; i < direct.length; i++) {
  const start = i * partSize
  const end = Math.min(start + partSize, total)
  const t = Date.now()
  const res = await fetch(direct[i], {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4' },
    body: Buffer.alloc(end - start, (i + 3) % 251),
  })
  console.log(`direct part ${i + 1}: ${res.status} in ${Date.now() - t}ms etag=${(res.headers.get('etag') || '').slice(0, 14)}`)
  if (res.status !== 200 && res.status !== 201) process.exit(1)
}
const comp = await fetch(`${base}${completeUrl}`, { method: 'POST' })
const meta = await comp.json()
console.log('complete:', comp.status, `${((total / 1024 / 1024) / ((Date.now() - t0) / 1000)).toFixed(1)} MB/s avg`, '| size:', meta.size)
if (comp.status !== 200) process.exit(1)

// cleanup via S3
{
  const { AwsClient } = await import('aws4fetch')
  const s3 = new AwsClient({ accessKeyId: dev.OCI_S3_ACCESS_KEY_ID, secretAccessKey: dev.OCI_S3_SECRET_ACCESS_KEY, service: 's3', region: wr.vars.OCI_S3_REGION })
  const res = await s3.fetch(`${wr.vars.OCI_S3_ENDPOINT}/${wr.vars.OCI_S3_BUCKET}/${meta.id.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE' })
  console.log('cleanup:', res.status, meta.id)
}
console.log('DIRECT UPLOAD OK')
