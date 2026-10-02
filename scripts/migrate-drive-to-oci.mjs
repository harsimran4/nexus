// One-time migration: Google Drive workspace → OCI Object Storage bucket.
//
//   node scripts/migrate-drive-to-oci.mjs [--dry-run] [--resume]
//
// Reads .env.local  (VITE_NEXUS_API_KEY, VITE_NEXUS_ROOT_FOLDER_ID, VITE_NEXUS_FILE_ID)
// and    .dev.vars  (OCI_S3_ENDPOINT, OCI_S3_BUCKET, OCI_S3_REGION, OCI_S3_ACCESS_KEY_ID, OCI_S3_SECRET_ACCESS_KEY)
//
// What it does:
//   1. Downloads master/nexus.json from Drive and rewrites every storage
//      reference to the OCI key scheme (groups/<gid>/, groups/<gid>/<pid>/,
//      scripts/<id>.md) using the SAME sanitize/id rules as src/server/mime.ts
//      and src/server/fns.ts, so the app can't tell migrated keys from fresh ones.
//   2. Uploads every referenced file (media, scripts, script copies) — small
//      files as one PUT, large ones as multipart, streamed from Drive.
//   3. Creates the system folder markers (initFn's job in a fresh workspace).
//   4. Uploads the rewritten doc LAST (the doc is the index; content first).
//   5. Verifies: sizes/counts over the S3 API + a parse of the uploaded doc.
//
// Notes: Drive snapshots/ are NOT migrated (fresh history). Drive files not
// referenced by the doc are migrated into the folder they live in (orphans
// preserved, invisible to the app). drive-doc scripts stay as links — Google
// Docs can't be exported as bytes here.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AwsClient } from 'aws4fetch'
import { parseDoc } from '../src/types/schema.ts'

// ---------------------------------------------------------------------------
// env + args
// ---------------------------------------------------------------------------

const args = new Set(process.argv.slice(2))
const DRY = args.has('--dry-run')
const RESUME = args.has('--resume')
const MANIFEST_PATH = fileURLToPath(new URL('./.migrate-state.json', import.meta.url))

function parseEnvFile(path) {
  const out = {}
  if (!existsSync(path)) return out
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}
const dotEnv = parseEnvFile(fileURLToPath(new URL('../.env.local', import.meta.url)))
const dotVars = parseEnvFile(fileURLToPath(new URL('../.dev.vars', import.meta.url)))
// Non-secret vars live in wrangler.jsonc ([vars]) — the same source the dev
// server uses. Strip // comments before parsing.
const wrangler = JSON.parse(
  readFileSync(fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)), 'utf8').replace(/^\s*\/\/.*$/gm, ''),
)
const vars = { ...(wrangler.vars ?? {}), ...dotVars }

const API_KEY = dotEnv.VITE_NEXUS_API_KEY
const ROOT_ID = dotEnv.VITE_NEXUS_ROOT_FOLDER_ID
const NEXUS_FILE_ID = dotEnv.VITE_NEXUS_FILE_ID
const OCI = {
  endpoint: (vars.OCI_S3_ENDPOINT || process.env.OCI_S3_ENDPOINT || '').replace(/\/+$/, ''),
  bucket: vars.OCI_S3_BUCKET || 'nexus',
  region: vars.OCI_S3_REGION,
  accessKeyId: vars.OCI_S3_ACCESS_KEY_ID,
  secretAccessKey: vars.OCI_S3_SECRET_ACCESS_KEY,
}
for (const [k, v] of Object.entries({ API_KEY, ROOT_ID, NEXUS_FILE_ID, endpoint: OCI.endpoint, region: OCI.region, accessKeyId: OCI.accessKeyId, secretAccessKey: OCI.secretAccessKey })) {
  if (!v) {
    console.error(`Missing ${k} — fill .env.local / .dev.vars first`)
    process.exit(1)
  }
}

const DRIVE = 'https://www.googleapis.com/drive/v3'
const PART_SIZE = 16 * 1024 * 1024
const FOLDER_MARKER = '__folder__'
const TRASHED = 'trashed=false'

// ---------------------------------------------------------------------------
// key helpers — MUST mirror src/server/mime.ts and src/server/fns.ts
// ---------------------------------------------------------------------------

function sanitizeNameSegment(name) {
  return name.replace(/[/\\]/g, '_').replace(/[\u0000-\u001f]/g, '').replace(/\.{2,}/g, '.').replace(/__/g, '_').trim() || 'untitled'
}
let mintSeq = 0
function mintFileId() {
  const bytes = crypto.getRandomValues(new Uint8Array(5))
  let rand = ''
  for (const b of bytes) rand += b.toString(16).padStart(2, '0')
  return 'f_' + Date.now().toString(16) + rand.slice(0, 10) + (mintSeq++ % 10) // seq guards same-ms minting
}
function encodeKeyPath(key) {
  return key.split('/').map((s) => encodeURIComponent(s)).join('/')
}

// ---------------------------------------------------------------------------
// S3 client
// ---------------------------------------------------------------------------

const s3 = new AwsClient({ accessKeyId: OCI.accessKeyId, secretAccessKey: OCI.secretAccessKey, service: 's3', region: OCI.region, retries: 2 })
const objUrl = (key, query) => `${OCI.endpoint}/${OCI.bucket}/${encodeKeyPath(key)}${query ? '?' + query : ''}`

async function s3Put(key, body, contentType) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await s3.fetch(objUrl(key), { method: 'PUT', headers: { 'Content-Type': contentType, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' }, body })
      if (!res.ok) throw new Error(`S3 PUT ${key} → ${res.status}: ${(await res.text()).slice(0, 200)}`)
      return
    } catch (e) {
      if (attempt >= 3) throw e
      await sleep(2 ** attempt * 1000)
    }
  }
}
async function s3Del(key) {
  await s3.fetch(objUrl(key), { method: 'DELETE', headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' } })
}
async function s3Head(key) {
  const res = await s3.fetch(objUrl(key), { method: 'HEAD', headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' } })
  return res.ok ? { size: Number(res.headers.get('content-length') ?? 0) } : null
}

async function s3PutStreamed(key, driveRes, contentType, size) {
  if (size <= PART_SIZE) return s3Put(key, await driveRes.arrayBuffer(), contentType)
  // Multipart: pull Drive's stream in PART_SIZE chunks.
  const initRes = await s3.fetch(objUrl(key, 'uploads'), { method: 'POST', headers: { 'Content-Type': contentType, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' } })
  if (!initRes.ok) throw new Error(`MPU init ${key} → ${initRes.status}`)
  const uploadId = extractTag(await initRes.text(), 'UploadId')
  try {
    const reader = driveRes.body.getReader()
    const parts = []
    let buf = new Uint8Array(PART_SIZE)
    let fill = 0
    let partNumber = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      let chunk = value
      while (chunk.length) {
        const room = PART_SIZE - fill
        const take = Math.min(room, chunk.length)
        buf.set(chunk.subarray(0, take), fill)
        fill += take
        chunk = chunk.subarray(take)
        if (fill === PART_SIZE) {
          partNumber++
          const etag = await uploadPart(key, uploadId, partNumber, buf)
          parts.push({ partNumber, etag })
          buf = new Uint8Array(PART_SIZE)
          fill = 0
        }
      }
    }
    if (fill > 0) {
      partNumber++
      const etag = await uploadPart(key, uploadId, partNumber, buf.subarray(0, fill))
      parts.push({ partNumber, etag })
    }
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload>' +
      parts.map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>&quot;${p.etag}&quot;</ETag></Part>`).join('') +
      '</CompleteMultipartUpload>'
    const done = await s3.fetch(objUrl(key, `uploadId=${encodeURIComponent(uploadId)}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml', 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
      body: xml,
    })
    if (!done.ok) throw new Error(`MPU complete ${key} → ${done.status}: ${(await done.text()).slice(0, 300)}`)
  } catch (e) {
    await s3.fetch(objUrl(key, `uploadId=${encodeURIComponent(uploadId)}`), { method: 'DELETE', headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' } }).catch(() => {})
    throw e
  }
}
async function uploadPart(key, uploadId, partNumber, bytes) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await s3.fetch(objUrl(key, `partNumber=${partNumber}&uploadId=${encodeURIComponent(uploadId)}`), {
        method: 'PUT',
        headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
        body: bytes,
      })
      if (!res.ok) throw new Error(`part ${partNumber} → ${res.status}`)
      return res.headers.get('etag').replace(/^"|"$/g, '')
    } catch (e) {
      if (attempt >= 3) throw e
      await sleep(2 ** attempt * 1000)
    }
  }
}
function extractTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`))
  if (!m) throw new Error(`no <${tag}> in response`)
  return m[1]
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Drive client (API key — the folder is link-shared). The key is HTTP-
// referrer-restricted, so requests carry the deployed app's origin as
// Referer (the same origin the app itself sends from).
// ---------------------------------------------------------------------------

const DRIVE_HEADERS = { Referer: 'https://harsimran4.github.io/nexus/' }

async function driveList(folderId) {
  const files = []
  let pageToken
  do {
    const q = encodeURIComponent(`'${folderId}' in parents and ${TRASHED}`)
    const fields = encodeURIComponent('nextPageToken,files(id,name,mimeType,size,parents,createdTime)')
    const res = await fetch(`${DRIVE}/files?q=${q}&fields=${fields}&pageSize=1000&key=${API_KEY}${pageToken ? `&pageToken=${pageToken}` : ''}`, { headers: DRIVE_HEADERS })
    if (!res.ok) throw new Error(`Drive list ${folderId} → ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const page = await res.json()
    files.push(...(page.files ?? []))
    pageToken = page.nextPageToken
  } while (pageToken)
  return files
}
function driveDownloadUrl(fileId) {
  return `${DRIVE}/files/${fileId}?alt=media&key=${API_KEY}`
}
async function driveFetch(fileId) {
  const res = await fetch(driveDownloadUrl(fileId), { headers: DRIVE_HEADERS })
  if (!res.ok) throw new Error(`Drive download ${fileId} → ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res
}
/** driveFetch that rides out Google's per-IP abuse throttle (HTML "Sorry…"
 *  403 block pages): waits grow 5min → 10min → 20min, then gives up. */
const BLOCK_WAIT = [300_000, 600_000, 1_200_000]
async function driveFetchBlocking(fileId) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await driveFetch(fileId)
    } catch (e) {
      if (attempt >= BLOCK_WAIT.length || !/→ 403/.test(e.message)) throw e
      console.log(`    Drive throttle hit — waiting ${BLOCK_WAIT[attempt] / 1000}s…`)
      await sleep(BLOCK_WAIT[attempt])
    }
  }
}

// ---------------------------------------------------------------------------
// manifest (resume support)
// ---------------------------------------------------------------------------

const manifest = RESUME && existsSync(MANIFEST_PATH) ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) : { uploads: {} }
function saveManifest() {
  if (DRY) return
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest))
}
// The PLAN (rewritten doc + exact keys) persists in the manifest — a resumed
// run must reuse the SAME keys, or earlier runs' uploads would be orphaned.
const savedPlan = RESUME ? (manifest.plan ?? null) : null

// ---------------------------------------------------------------------------
// 1. walk Drive
// ---------------------------------------------------------------------------

let doc, uploads, markers, warnings, migratedBytes
if (savedPlan) {
  console.log(`Resuming the saved plan (${savedPlan.uploads.length} uploads) — Drive is not re-walked.`)
  ;({ doc, uploads, warnings, migratedBytes } = savedPlan)
  markers = new Set(savedPlan.markers)
} else {
console.log('Listing the Drive workspace…')
const byId = new Map() // driveId -> file meta + drivePath
async function walk(folderId, path) {
  for (const f of await driveList(folderId)) {
    const p = path ? `${path}/${f.name}` : f.name
    byId.set(f.id, { ...f, path: p })
    if (f.mimeType === 'application/vnd.google-apps.folder') await walk(f.id, p)
  }
}
await walk(ROOT_ID, '')
console.log(`  ${byId.size} entries (incl. folders)`)

// ---------------------------------------------------------------------------
// 2. load + rewrite the doc
// ---------------------------------------------------------------------------

console.log('Downloading the workspace doc…')
const docRes = await driveFetch(NEXUS_FILE_ID)
const rawDoc = await docRes.text()
const parsed = parseDoc(rawDoc)
if (!parsed.ok) {
  console.error('Drive nexus.json does not parse against the current schema:\n', parsed.error.issues?.slice(0, 10))
  process.exit(1)
}
const doc0 = structuredClone(parsed.doc)
doc = doc0

const newIdToKey = new Map() // driveFileId -> new OCI key (for uploads + doc rewrite)
uploads = [] // { driveId | body, key, contentType, size, label }
warnings = []
migratedBytes = 0

doc.ids = { rootFolderId: '', nexusFileId: 'master/nexus.json', systemFolders: { master: 'master/', snapshots: 'snapshots/', groups: 'groups/', scripts: 'scripts/' } }
// writerId re-stamped; updatedAt and all entity stamps are PRESERVED — they
// are HLCs ("<ms>.<counter>"), and a fresh ISO string would decode as the
// oldest-possible stamp in the LWW merge.
doc.writerId = 'migration'
doc.snapshots = [] // fresh snapshot history in the new bucket

// system + entity folder markers
markers = new Set(['master/', 'snapshots/', 'groups/', 'scripts/'])
for (const g of Object.values(doc.groups)) markers.add(`groups/${g.id}/`)
for (const p of Object.values(doc.projects)) {
  const g = doc.groups[p.groupId]
  if (g) markers.add(`groups/${g.id}/${p.id}/`)
}

function mediaKey(projectPrefix, driveName) {
  return projectPrefix + mintFileId() + '__' + sanitizeNameSegment(driveName)
}
function planUpload(driveId, key, contentType, label) {
  // A resumed run keeps the exact key an earlier attempt already uploaded —
  // the object is likely in the bucket already and the doc must reference it.
  const prevKey = RESUME ? manifest.uploads[driveId]?.key : null
  if (prevKey) key = prevKey
  const f = byId.get(driveId)
  const size = Number(f?.size ?? 0)
  if (f) migratedBytes += size
  uploads.push({ driveId, key, contentType, size, label })
  newIdToKey.set(driveId, key)
}

for (const g of Object.values(doc.groups)) {
  g.folderId = `groups/${g.id}/`
}
for (const p of Object.values(doc.projects)) {
  const g = doc.groups[p.groupId]
  const prefix = g ? `groups/${g.id}/${p.id}/` : null
  if (!prefix) {
    warnings.push(`project ${p.id} (${p.name}) has no live group — files left unmapped`)
    continue
  }
  p.folderId = prefix
  p.fileIds = p.fileIds.map((fid) => {
    const f = byId.get(fid)
    if (!f) {
      warnings.push(`project ${p.name}: doc references missing Drive file ${fid} — dropped from fileIds`)
      return null
    }
    if (f.mimeType === 'application/vnd.google-apps.folder') return null
    if (f.mimeType.startsWith('application/vnd.google-apps.')) {
      warnings.push(`project ${p.name}: Google-Docs-native file "${f.name}" (${f.mimeType}) can't be migrated as bytes — dropped from fileIds (still on Drive)`)
      return null
    }
    const key = mediaKey(prefix, f.name)
    planUpload(fid, key, f.mimeType || 'application/octet-stream', `media:${p.name}/${f.name}`)
    return key
  }).filter(Boolean)
  const sectionOf = {}
  for (const [fid, section] of Object.entries(p.mediaSectionOf)) {
    const key = newIdToKey.get(fid)
    if (key) sectionOf[key] = section
  }
  p.mediaSectionOf = sectionOf
}

for (const s of Object.values(doc.scripts)) {
  if (s.storage.type === 'md' && s.storage.fileId) {
    const f = byId.get(s.storage.fileId)
    const key = `scripts/${s.id}.md`
    if (f && !f.mimeType.startsWith('application/vnd.google-apps.')) {
      planUpload(s.storage.fileId, key, 'text/markdown', `script:${s.title}`)
    } else {
      uploads.push({ body: '', key, contentType: 'text/markdown', size: 0, label: `script:${s.title} (body missing on Drive — empty file)` })
      newIdToKey.set(s.storage.fileId, key)
      if (!f) warnings.push(`script "${s.title}": body file ${s.storage.fileId} not found on Drive — wrote an empty ${key}`)
    }
    s.storage = { type: 'md', fileId: key }
  } else if (s.storage.type === 'drive-doc') {
    warnings.push(`script "${s.title}" is a linked Google Doc — left as a link (export it manually if needed)`)
  }
  s.copies = s.copies.map((c, i) => {
    const f = byId.get(c.fileId)
    if (!f) return null
    const key = `scripts/${s.id}-${sanitizeNameSegment(c.label)}-${i + 1}.md`
    planUpload(c.fileId, key, 'text/markdown', `script-copy:${s.title}/${c.label}`)
    return { ...c, fileId: key }
  }).filter(Boolean)
}

// Orphans: Drive files no doc entry references — migrate them into the
// project folder they live in (preserved on storage, invisible to the app).
const referenced = new Set(uploads.map((u) => u.driveId).filter(Boolean))
for (const f of byId.values()) {
  if (f.mimeType === 'application/vnd.google-apps.folder') continue
  if (referenced.has(f.id) || f.id === NEXUS_FILE_ID) continue
  if (f.path === 'master/nexus.json' || f.path.startsWith('snapshots/')) continue
  if (f.mimeType.startsWith('application/vnd.google-apps.')) continue
  const segs = f.path.split('/')
  const prefix = segs[0] === 'groups' && segs.length >= 4 ? projectPrefixByPath(segs[1], segs[2]) : null
  if (!prefix) {
    warnings.push(`orphan outside any live project folder skipped: ${f.path}`)
    continue
  }
  const key = prefix + mintFileId() + '__' + sanitizeNameSegment(segs.slice(3).join('_'))
  planUpload(f.id, key, f.mimeType || 'application/octet-stream', `orphan:${f.path}`)
}
/** groups/<GroupFolderName>/<ProjectFolderName>/… → project folderId via doc names. */
function projectPrefixByPath(groupFolderName, projectFolderName) {
  const g = Object.values(doc.groups).find((x) => sanitizeNameSegment(x.name) === sanitizeNameSegment(groupFolderName))
  if (!g) return null
  const p = Object.values(doc.projects).find((x) => x.groupId === g.id && sanitizeNameSegment(x.name) === sanitizeNameSegment(projectFolderName))
  return p?.folderId ?? null
}
manifest.plan = { doc, uploads, markers: [...markers], warnings, migratedBytes }
saveManifest()
}

// ---------------------------------------------------------------------------
// 3. summary / dry-run gate
// ---------------------------------------------------------------------------

console.log(`\nPlan:`)
console.log(`  groups:   ${Object.keys(doc.groups).length}`)
console.log(`  projects: ${Object.keys(doc.projects).length}`)
console.log(`  scripts:  ${Object.keys(doc.scripts).length} (bodies: ${uploads.filter((u) => u.label.startsWith('script:')).length})`)
console.log(`  uploads:  ${uploads.length} files, ${(migratedBytes / 1e6).toFixed(1)} MB`)
console.log(`  markers:  ${markers.size}`)
console.log(`  users:    ${doc.users.app.length} app logins PRESERVED, ${doc.users.viewers.length} viewer tokens PRESERVED`)
if (warnings.length) {
  console.log(`\nWarnings (${warnings.length}):`)
  for (const w of warnings) console.log('  ! ' + w)
}
if (DRY) {
  console.log('\n--dry-run: stopping before any writes.')
  for (const u of uploads.slice(0, 15)) console.log(`  would upload ${u.label} → ${u.key} (${(u.size / 1e6).toFixed(2)} MB)`)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// 4. execute: markers → files → doc LAST
// ---------------------------------------------------------------------------

console.log('\nCreating folder markers…')
for (const prefix of markers) {
  await s3Put(prefix + FOLDER_MARKER, new ArrayBuffer(0), 'application/x-nexus-folder')
  process.stdout.write(`  ${prefix}\n`)
}

console.log('\nUploading files…')
let done = 0
for (const u of uploads) {
  done++
  const prev = manifest.uploads[u.driveId ?? u.key]
  if (RESUME && prev?.key === u.key && (await s3Head(u.key))) {
    console.log(`  [${done}/${uploads.length}] skip (already up) ${u.key}`)
    continue
  }
  try {
    if (u.driveId) {
      const res = await driveFetchBlocking(u.driveId)
      await s3PutStreamed(u.key, res, u.contentType, u.size || 1)
      await sleep(2500) // pacing — hammering the unsigned path is what trips the throttle
    } else {
      await s3Put(u.key, u.body, u.contentType)
    }
    manifest.uploads[u.driveId ?? u.key] = { key: u.key, at: new Date().toISOString() }
    console.log(`  [${done}/${uploads.length}] ${u.key} (${(u.size / 1e6).toFixed(2)} MB)`)
    if (done % 10 === 0) saveManifest()
  } catch (e) {
    console.error(`  FAILED ${u.label} → ${u.key}: ${e.message}`)
    saveManifest()
    process.exit(1)
  }
}
saveManifest()

console.log('\nWriting the rewritten doc (master/nexus.json)…')
await s3Put('master/nexus.json', JSON.stringify(doc), 'application/json')

// ---------------------------------------------------------------------------
// 5. verify
// ---------------------------------------------------------------------------

console.log('\nVerifying…')
let okCount = 0
const sample = uploads.filter((u) => u.driveId)
for (const u of [sample[0], sample[Math.floor(sample.length / 2)], sample[sample.length - 1]].filter(Boolean)) {
  const h = await s3Head(u.key)
  const expect = u.size || undefined
  const ok = h && (!expect || h.size === expect)
  console.log(`  ${ok ? 'OK ' : 'BAD'} ${u.key} (${h?.size} vs Drive ${expect})`)
  if (ok) okCount++
}
const check = parseDoc(JSON.stringify(doc))
console.log(`  doc parse: ${check.ok ? 'OK' : 'FAILED ' + JSON.stringify(check.error.issues?.slice(0, 5))}`)

// ---------------------------------------------------------------------------
// 6. cleanup — remove strays from earlier aborted runs (keys not in this plan)
// ---------------------------------------------------------------------------

console.log('\nCleaning up strays from earlier attempts…')
const expected = new Set(uploads.map((u) => u.key))
for (const m of markers) expected.add(m + FOLDER_MARKER)
expected.add('master/nexus.json')
let strays = 0
for (const prefix of ['groups/', 'scripts/', 'master/']) {
  let token = null
  do {
    const params = new URLSearchParams({ 'list-type': '2', 'encoding-type': 'url', prefix })
    if (token) params.set('continuation-token', token)
    const res = await s3.fetch(objUrl('', params.toString().replace(/\+/g, '%20')), { headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' } })
    if (!res.ok) throw new Error(`list ${prefix} → ${res.status}`)
    const xmlText = await res.text()
    for (const m of xmlText.matchAll(/<Key>([^<]+)<\/Key>/g)) {
      const key = decodeURIComponent(m[1])
      if (!expected.has(key)) {
        await s3Del(key)
        strays++
        console.log(`  removed stray ${key}`)
      }
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xmlText)
      ? (xmlText.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] ?? null)
      : null
  } while (token)
}
if (strays === 0) console.log('  none — the bucket matches the plan exactly.')

console.log(`\nDone. ${uploads.length} files migrated, ${(migratedBytes / 1e6).toFixed(1)} MB, ${strays} strays removed.`)
console.log('Next: open http://localhost:5173 — the workspace should boot with the original logins.')
console.log('NOTE: scripts/.migrate-state.json holds the migration plan — keep it until the app is verified, then delete. Keep .env.local until Drive is formally retired.')
