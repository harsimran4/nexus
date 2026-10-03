// Sweep orphaned objects from the bucket — anything NOT referenced by the
// live workspace doc (test leftovers, abandoned upload attempts). Never
// touches trash/ (app-managed) or folder markers. Run:
//   node scripts/sweep-orphans.mjs [--dry-run]
import { readFileSync } from 'node:fs'
import { AwsClient } from 'aws4fetch'

const DRY = process.argv.includes('--dry-run')
const dev = Object.fromEntries(
  readFileSync('.dev.vars', 'utf8').split(/\r?\n/).map((l) => {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/)
    return m ? [m[1], m[2]] : null
  }).filter(Boolean),
)
const wr = JSON.parse(readFileSync('wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, ''))
const env = { ...wr.vars, ...dev }
const base = `${env.OCI_S3_ENDPOINT.replace(/\/+$/, '')}/${env.OCI_S3_BUCKET}`
const s3 = new AwsClient({ accessKeyId: env.OCI_S3_ACCESS_KEY_ID, secretAccessKey: env.OCI_S3_SECRET_ACCESS_KEY, service: 's3', region: env.OCI_S3_REGION })
const enc = (k) => k.split('/').map(encodeURIComponent).join('/')

// 1. live doc
const doc = JSON.parse(await (await s3.fetch(`${base}/master/nexus.json`)).text())

// 2. expected set — everything the app owns. Conservative by design:
//    markers and backups are NEVER swept, and every live file keeps its
//    generated thumbnail.
const expected = new Set([
  'master/nexus.json',
  'master/__folder__', 'snapshots/__folder__', 'groups/__folder__', 'scripts/__folder__', 'thumbs/__folder__',
])
const thumbOf = (mediaKey) => {
  const base = mediaKey.slice(mediaKey.lastIndexOf('/') + 1)
  const id = base.split('__')[0]
  return base.includes('__') && id ? `thumbs/${id}.jpg` : null
}
for (const g of Object.values(doc.groups)) expected.add(`groups/${g.id}/__folder__`)
for (const p of Object.values(doc.projects)) {
  if (p.folderId === null) continue
  expected.add(`${p.folderId}__folder__`)
  for (const f of p.fileIds) {
    expected.add(f)
    const t = thumbOf(f)
    if (t) expected.add(t)
  }
}
for (const s of Object.values(doc.scripts)) {
  if (s.storage.type === 'md' && s.storage.fileId) expected.add(s.storage.fileId)
  for (const c of s.copies) expected.add(c.fileId)
}
for (const s of doc.snapshots) expected.add(s.fileId)
// Folder markers are zero-byte and harmless — keep every one we find.

// 3. list everything, excluding trash/, snapshots/, scripts/ (kept whole)
const orphans = []
let scanned = 0
let token = null
do {
  const q = new URLSearchParams({ 'list-type': '2', 'encoding-type': 'url' })
  if (token) q.set('continuation-token', token)
  const res = await s3.fetch(`${base}/?${q.toString().replace(/\+/g, '%20')}`, {})
  const text = await res.text()
  for (const m of text.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = m[1]
    const key = decodeURIComponent((block.match(/<Key>([^<]+)<\/Key>/) || [])[1] || '').replace(/\+/g, ' ')
    const size = Number((block.match(/<Size>(\d+)<\/Size>/) || [])[1] || 0)
    scanned++
    if (key.startsWith('trash/') || key.startsWith('snapshots/') || key.startsWith('scripts/')) continue
    if (key.endsWith('__folder__')) continue // markers are never swept
    if (!expected.has(key)) orphans.push({ key, size })
  }
  token = /<IsTruncated>true<\/IsTruncated>/.test(text)
    ? (text.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] ?? null)
    : null
} while (token)

const bytes = orphans.reduce((n, o) => n + o.size, 0)
console.log(`scanned ${scanned} objects; ${orphans.length} orphans, ${(bytes / 1048576).toFixed(1)} MB to free\n`)
for (const o of orphans) console.log(`  ${(o.size / 1048576).toFixed(2).padStart(9)} MB  ${o.key}`)
if (DRY) { console.log('\n--dry-run: nothing deleted.'); process.exit(0) }

let deleted = 0
for (const o of orphans) {
  const res = await s3.fetch(`${base}/${enc(o.key)}`, { method: 'DELETE', headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' } })
  if (res.ok) deleted++
  else console.log(`  FAILED (${res.status}): ${o.key}`)
}
console.log(`\nDeleted ${deleted}/${orphans.length} orphans, freed ${(bytes / 1048576).toFixed(1)} MB.`)
