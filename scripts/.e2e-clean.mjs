// One-off cleanup for E2E leftovers in the shared dev/prod doc+bucket (run
// if scripts/.upload-test.mjs died before its own cleanup).
import { readFileSync } from 'node:fs'
const dev = Object.fromEntries(
  readFileSync('.dev.vars', 'utf8').split(/\r?\n/).map((l) => {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/)
    return m ? [m[1], m[2]] : null
  }).filter(Boolean),
)
const wr = JSON.parse(readFileSync('wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, ''))
const { AwsClient } = await import('aws4fetch')
const s3 = new AwsClient({ accessKeyId: dev.OCI_S3_ACCESS_KEY_ID, secretAccessKey: dev.OCI_S3_SECRET_ACCESS_KEY, service: 's3', region: wr.vars.OCI_S3_REGION })
const base = 'http://localhost:5173'
const d = await (await fetch(base + '/files/master/nexus.json')).json()
const pj = Object.values(d.projects).find((p) => p.fileIds.some((f) => f.includes('direct-probe-test') || f.includes('small-direct-test') || f.includes('guest-test') || f.includes('inflight')))
const doomed = pj ? pj.fileIds.filter((f) => /direct-probe-test|small-direct-test|guest-test|inflight/.test(f)) : []
if (pj) {
  pj.fileIds = pj.fileIds.filter((f) => !doomed.includes(f))
  for (const k of doomed) delete pj.mediaSectionOf[k]
}
d.uploadLinks = (d.uploadLinks ?? []).filter((l) => !l.id.endsWith('e2e'))
if (pj) pj.mediaSections = pj.mediaSections.filter((sec) => sec.id !== 'sec_guesttest')
const put = await s3.fetch(wr.vars.OCI_S3_ENDPOINT + '/' + wr.vars.OCI_S3_BUCKET + '/master/nexus.json', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) })
console.log('doc restore:', put.status, '| removed keys:', doomed.length)
for (const k of doomed) {
  const enc = k.split('/').map(encodeURIComponent).join('/')
  const del = await s3.fetch(wr.vars.OCI_S3_ENDPOINT + '/' + wr.vars.OCI_S3_BUCKET + '/' + enc, { method: 'DELETE' })
  console.log('del', k.split('__')[0], '->', del.status)
}
