// Recover orphaned uploads — files sitting in the bucket that the workspace
// doc never recorded (the 97-files-lost guest-upload incident, 2026-10:
// concurrent completions clobbered each other's doc links while the guest saw
// "All done"). Lists them by default; --adopt links them into the doc in ONE
// read-modify-write (safe: runs after the contention is over).
//
//   node scripts/adopt-orphans.mjs            # list only
//   node scripts/adopt-orphans.mjs --adopt    # link every orphan into its project
//
// Scope: groups/ prefixes of LIVE projects only. trash/, snapshots/,
// scripts/, thumbs/, progress/, markers and master/ are never touched —
// run scripts/sweep-orphans.mjs --dry-run for genuine garbage.
import { readFileSync } from 'node:fs'
import { AwsClient } from 'aws4fetch'

const ADOPT = process.argv.includes('--adopt')
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

const doc = JSON.parse(await (await s3.fetch(`${base}/master/nexus.json`)).text())

// expected set — the same conservative inventory sweep-orphans keeps
const expected = new Set(['master/nexus.json'])
for (const p of Object.values(doc.projects)) {
  if (p.folderId === null) continue
  expected.add(`${p.folderId}__folder__`)
  for (const f of p.fileIds) {
    expected.add(f)
    const seg = f.slice(f.lastIndexOf('/') + 1)
    const id = seg.split('__')[0]
    if (seg.includes('__') && id) expected.add(`thumbs/${id}.jpg`)
  }
}
for (const s of Object.values(doc.scripts)) {
  if (s.storage?.type === 'md' && s.storage.fileId) expected.add(s.storage.fileId)
  for (const c of s.copies ?? []) expected.add(c.fileId)
}
for (const s of doc.snapshots) expected.add(s.fileId)

// list everything under groups/, keep live-project files the doc doesn't know
const orphans = []
let token = null
do {
  const q = new URLSearchParams({ 'list-type': '2', 'encoding-type': 'url', prefix: 'groups/' })
  if (token) q.set('continuation-token', token)
  const res = await s3.fetch(`${base}/?${q.toString().replace(/\+/g, '%20')}`, {})
  const text = await res.text()
  for (const m of text.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = decodeURIComponent((m[1].match(/<Key>([^<]+)<\/Key>/) || [])[1] || '').replace(/\+/g, ' ')
    const size = Number((m[1].match(/<Size>(\d+)<\/Size>/) || [])[1] || 0)
    if (key.endsWith('__folder__')) continue
    if (!expected.has(key)) orphans.push({ key, size })
  }
  token = /<IsTruncated>true<\/IsTruncated>/.test(text)
    ? (text.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] ?? null)
    : null
} while (token)

if (orphans.length === 0) {
  console.log('No orphans under groups/ — nothing to recover.')
  process.exit(0)
}

// longest live-project prefix owns each key (mirrors linking.ts)
const projects = Object.values(doc.projects).filter((p) => !p.deleted && p.folderId)
const ownerOf = (key) => {
  let best = null
  for (const p of projects) {
    if (key.startsWith(p.folderId) && (!best || p.folderId.length > best.folderId.length)) best = p
  }
  return best
}
// a project's single active share link lends its section so recovered files
// land where the guest was sending them; otherwise they arrive un-sectioned
const activeLinks = (projectId) =>
  (doc.uploadLinks ?? []).filter((l) => l.projectId === projectId && !l.revokedAt && Date.parse(l.expiresAt) > Date.now())
const sectionOf = (projectId) => {
  const links = activeLinks(projectId)
  return links.length === 1 ? links[0].sectionId : null
}
const uploadDate = (key) => {
  // id = 'f_' + Date.now().toString(16) (11 hex chars) + 10 random hex chars,
  // no separator — the timestamp is exactly the first 11 hex chars.
  const m = key.match(/f_([0-9a-f]{11})/)
  let ms = m ? parseInt(m[1], 16) : NaN
  if (!Number.isFinite(ms) || ms < 1.5e12 || ms > 4e12) return 'unknown date'
  try {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
  } catch {
    return 'unknown date'
  }
}

const byOwner = new Map()
for (const o of orphans) {
  const p = ownerOf(o.key)
  const pid = p ? p.id : 'UNOWNED'
  if (!byOwner.has(pid)) byOwner.set(pid, { project: p, files: [] })
  byOwner.get(pid).files.push(o)
}

console.log(`${orphans.length} orphaned upload(s) under groups/:\n`)
for (const [pid, { project, files }] of byOwner) {
  const mb = files.reduce((n, o) => n + o.size, 0) / 1048576
  console.log(`  ${pid}${project ? ` — "${project.name}"` : '  (no live project owns this prefix — NOT adoptable)'}`)
  console.log(`    ${files.length} file(s), ${mb.toFixed(1)} MB`)
  for (const o of files.slice(0, 8)) {
    const name = o.key.slice(o.key.indexOf('__') + 1)
    console.log(`      ${uploadDate(o.key)}  ${name}`)
  }
  if (files.length > 8) console.log(`      … and ${files.length - 8} more`)
}
console.log(ADOPT ? '\n--adopt: linking…' : '\nDry run — re-run with --adopt to link these into the doc.')
if (!ADOPT) process.exit(0)

const adoptable = [...byOwner.entries()].filter(([, v]) => v.project)
if (adoptable.length === 0) {
  console.log('Nothing adoptable (orphans exist but no live project owns them).')
  process.exit(1)
}

// ONE read-modify-write: contention is over by the time anyone runs this
const res = await s3.fetch(`${base}/${enc('master/nexus.json')}`)
const before = { etag: res.headers.get('etag') }
const fresh = JSON.parse(await res.text())
const now = new Date().toISOString()
let adopted = 0
for (const [pid, { files }] of adoptable) {
  const project = fresh.projects[pid]
  const sectionId = sectionOf(pid)
  for (const o of files) {
    if (project.fileIds.includes(o.key)) continue
    project.fileIds.push(o.key)
    if (sectionId && project.mediaSections.some((s) => s.id === sectionId)) project.mediaSectionOf[o.key] = sectionId
    project.updatedAt = now
    project.writerId = 'recovery'
    fresh.activity = [
      ...(fresh.activity ?? []),
      { at: now, actor: 'recovery', verb: 'project.attach', ref: pid, meta: { fileId: o.key, via: 'adopt' } },
    ].slice(-1500)
    adopted++
  }
}
if (!adopted) {
  console.log('All orphans already recorded — nothing to do.')
  process.exit(0)
}
fresh.rev += 1
fresh.updatedAt = now
fresh.writerId = 'recovery'
const put = await s3.fetch(`${base}/${enc('master/nexus.json')}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
  body: JSON.stringify(fresh),
})
if (!put.ok) {
  console.error(`PUT failed (${put.status}) — nothing written, doc unchanged. Re-run to retry.`)
  process.exit(1)
}
console.log(`Adopted ${adopted} file(s) into the doc (rev ${fresh.rev}). Reload the app to see them.`)
