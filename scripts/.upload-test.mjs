// E2E: presigned DIRECT upload + probe-completion — mirrors the browser.
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
  body: JSON.stringify({ name: 'direct-probe-test.mp4', parentId, mimeType: 'video/mp4', size: total }),
})
const initBody = await init.json()
console.log('init:', init.status, '| direct URLs:', initBody.direct?.length)
if (!init.ok || !initBody.direct?.length) process.exit(1)
const { direct, partSize, url } = initBody

const t0 = Date.now()
for (let i = 0; i < direct.length; i++) {
  const start = i * partSize
  const end = Math.min(start + partSize, total)
  const res = await fetch(direct[i], {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4' },
    body: Buffer.alloc(end - start, (i + 5) % 251),
  })
  console.log(`direct part ${i + 1}: ${res.status}`)
  if (res.status !== 200 && res.status !== 201) process.exit(1)
}

// probe-completion: a PUT with bytes */total — the server assembles.
const comp = await fetch(`${base}${url}`, {
  method: 'PUT',
  headers: { 'Content-Range': `bytes */${total}` },
})
const meta = await comp.json()
console.log('probe-complete:', comp.status, '| size:', meta.size, `| ${(total / 1048576 / ((Date.now() - t0) / 1000)).toFixed(1)} MB/s`)
if (comp.status !== 200) process.exit(1)

{
  const { AwsClient } = await import('aws4fetch')
  const s3 = new AwsClient({ accessKeyId: dev.OCI_S3_ACCESS_KEY_ID, secretAccessKey: dev.OCI_S3_SECRET_ACCESS_KEY, service: 's3', region: wr.vars.OCI_S3_REGION })
  const res = await s3.fetch(`${wr.vars.OCI_S3_ENDPOINT}/${wr.vars.OCI_S3_BUCKET}/${meta.id.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE' })
  console.log('cleanup:', res.status)
}
console.log('DIRECT + PROBE-COMPLETE OK')
