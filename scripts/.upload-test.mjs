// E2E: presigned DIRECT upload + probe-completion + SERVER-SIDE LINK —
// mirrors the browser. The assertion that failed in production: after the
// upload completes, the project doc's fileIds must contain the new key
// without any client commit (the link is applied server-side at completion).
// NOTE: dev shares the production bucket/doc — the test splices its key back
// out of the doc at the end.
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
const fail = (msg) => { console.error('FAIL: ' + msg); process.exit(1) }

const base = 'http://localhost:5173'
const fetchDoc = async () => await (await fetch(`${base}/files/master/nexus.json`)).json()
let smallMeta = null

const doc = await fetchDoc()
const user = doc.users.app[0]
const session = { uid: user.id, name: user.name, role: 'admin', epoch: user.sessionEpoch ?? 0, exp: Date.now() + 3600_000 }
const sBody = b64url(JSON.stringify(session))
const bearer = `${sBody}.${await hmac(sBody, dev.SESSION_SECRET)}`

const project = Object.values(doc.projects).find((p) => p.fileIds.length)
if (!project) fail('no project with files to upload into')
const before = project.fileIds.length
const sectionId = project.mediaSections[0]?.id ?? null


const parentId = project.folderId
if (!parentId) fail('project has no folderId')

// ---- SINGLE-SHOT small file (≤1 part): presigned PutObject + POST complete ----
{
  const small = Buffer.alloc(768 * 1024, 7)
  const initS = await fetch(`${base}/api/upload/resumable`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ name: 'small-direct-test.webp', parentId, mimeType: 'image/webp', size: small.length, projectId: project.id, sectionId }),
  })
  const s = await initS.json()
  console.log('small init:', initS.status, '| single:', s.single, '| urls:', s.direct?.length)
  if (!initS.ok || s.single !== true || s.direct?.length !== 1) process.exit(1)
  const putRes = await fetch(s.direct[0], { method: 'PUT', headers: { 'Content-Type': 'image/webp' }, body: small })
  console.log('small direct put:', putRes.status)
  if (putRes.status !== 200 && putRes.status !== 201) process.exit(1)
  const compS = await fetch(`${base}${s.completeUrl}`, { method: 'POST' })
  const metaS = await compS.json()
  console.log('small complete:', compS.status, '| size:', metaS.size)
  if (compS.status !== 200 || metaS.size !== small.length) process.exit(1)
  const docS = await fetchDoc()
  const pS = docS.projects[project.id]
  const occS = pS.fileIds.filter((f) => f === metaS.id).length
  console.log('small linked in doc:', occS === 1)
  if (occS !== 1) fail('small upload not linked exactly once')
  smallMeta = metaS
}
const total = 20 * 1024 * 1024
const init = await fetch(`${base}/api/upload/resumable`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
  body: JSON.stringify({ name: 'direct-probe-test.mp4', parentId, mimeType: 'video/mp4', size: total, projectId: project.id, sectionId }),
})
const initBody = await init.json()
console.log('init:', init.status, '| direct URLs:', initBody.direct?.length)
if (!init.ok || !initBody.direct?.length) process.exit(1)
const { direct, partSize, url, completeUrl } = initBody

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

// probe-completion: a PUT with bytes */total — the server assembles + links.
const comp = await fetch(`${base}${url}`, {
  method: 'PUT',
  headers: { 'Content-Range': `bytes */${total}` },
})
const meta = await comp.json()
console.log('probe-complete:', comp.status, '| size:', meta.size, `| ${(total / 1048576 / ((Date.now() - t0) / 1000)).toFixed(1)} MB/s`)
if (comp.status !== 200) process.exit(1)

// THE production assertion: the doc holds the link with no client commit.
const linked = await fetchDoc()
const p2 = linked.projects[project.id]
const occurrences = p2.fileIds.filter((f) => f === meta.id).length
console.log('linked in doc:', occurrences === 1, `| fileIds ${before} -> ${p2.fileIds.length}`)
if (occurrences !== 1) fail(`fileIds should contain ${meta.id} exactly once (got ${occurrences})`)
if (sectionId && p2.mediaSectionOf[meta.id] !== sectionId) fail('mediaSectionOf not set for the uploaded key')

// Idempotence: completing the (now finished) session again must not double-link.
const again = await fetch(`${base}${completeUrl}`, { method: 'POST' })
const afterAgain = await fetchDoc()
const p3 = afterAgain.projects[project.id]
const occurrencesAgain = p3.fileIds.filter((f) => f === meta.id).length
console.log('re-complete:', again.status, '| occurrences still:', occurrencesAgain)
if (again.status !== 200) fail('re-completion of a finished session should self-verify 200')
if (occurrencesAgain !== 1) fail('second completion duplicated or dropped the link')

// ---- GUEST UPLOAD LINK: mint -> info -> guest upload -> revoke/expiry/limits ----
const guest = {}
const s3helpers = async () => {
  const { AwsClient } = await import('aws4fetch')
  const s3 = new AwsClient({ accessKeyId: dev.OCI_S3_ACCESS_KEY_ID, secretAccessKey: dev.OCI_S3_SECRET_ACCESS_KEY, service: 's3', region: wr.vars.OCI_S3_REGION })
  return {
    put: (key, body, contentType) => s3.fetch(`${wr.vars.OCI_S3_ENDPOINT}/${wr.vars.OCI_S3_BUCKET}/${key}`, { method: 'PUT', headers: { 'Content-Type': contentType }, body }),
    del: (key) => s3.fetch(`${wr.vars.OCI_S3_ENDPOINT}/${wr.vars.OCI_S3_BUCKET}/${key}`, { method: 'DELETE' }),
  }
}
{
  const { createHash } = await import('node:crypto')
  const { webcrypto: c2 } = await import('node:crypto')
  guest.raw = b64url(c2.getRandomValues(new Uint8Array(32)))
  guest.tokenHash = 'sha256$' + createHash('sha256').update(guest.raw).digest('hex')
  guest.linkId = 'ul_' + Date.now().toString(16) + 'e2e'
  guest.metaList = []
  const { put: putDoc } = await s3helpers()
  const mint = async (mutate) => {
    const d = await fetchDoc()
    mutate(d)
    return (await putDoc('master/nexus.json', JSON.stringify(d), 'application/json')).status
  }
  // ensure a REAL section exists (links require one) + mint the link
  const st = await mint((d) => {
    const pj = d.projects[project.id]
    if (pj.mediaSections.length === 0) {
      pj.mediaSections = [...pj.mediaSections, { id: 'sec_guesttest', name: 'GuestTest' }]
      guest.createdSection = true
    }
    guest.sectionId = pj.mediaSections[0].id
    d.uploadLinks = [...(d.uploadLinks ?? []), {
      id: guest.linkId, tokenHash: guest.tokenHash, projectId: project.id, sectionId: guest.sectionId,
      maxFileBytes: 100 * 1024 * 1024, note: 'e2e', createdAt: '1.0000', createdBy: user.id,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), revokedAt: null,
      updatedAt: '1.0000', writerId: 'e2e',
    }]
  })
  console.log('guest mint:', st)
  if (st !== 200) process.exit(1)

  const info = await fetch(`${base}/api/upload/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: guest.raw }) })
  const infoBody = await info.json()
  console.log('guest info:', info.status, '| project:', infoBody.projectName, '| section:', infoBody.sectionName)
  if (info.status !== 200 || infoBody.projectName !== project.name || infoBody.folderId !== parentId) fail('guest info wrong')
  const badInfo = await fetch(`${base}/api/upload/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'x'.repeat(40) }) })
  console.log('guest info bad token:', badInfo.status)
  if (badInfo.status !== 401) fail('bad token should 401')

  // guest init with FORGED destination — server must derive from the link
  const gInit = await fetch(`${base}/api/upload/resumable`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${guest.raw}` },
    body: JSON.stringify({ name: 'guest-test.webp', parentId: 'groups/FORGED/', projectId: 'prj_FORGED', mimeType: 'image/webp', size: 768 * 1024 }),
  })
  const g = await gInit.json()
  console.log('guest init:', gInit.status, '| single:', g.single)
  if (!gInit.ok || g.single !== true) process.exit(1)
  const gPut = await fetch(g.direct[0], { method: 'PUT', headers: { 'Content-Type': 'image/webp' }, body: Buffer.alloc(768 * 1024, 9) })
  console.log('guest direct put:', gPut.status)
  if (gPut.status !== 200 && gPut.status !== 201) process.exit(1)
  const gComp = await fetch(`${base}${g.completeUrl}`, { method: 'POST' })
  guest.meta = await gComp.json()
  console.log('guest complete:', gComp.status, '| key:', guest.meta.id)
  if (gComp.status !== 200) process.exit(1)
  if (!guest.meta.id.startsWith(parentId)) fail('forged destination accepted — key must derive from the LINK folder')
  const gd = await fetchDoc()
  const gp = gd.projects[project.id]
  if (gp.fileIds.filter((f) => f === guest.meta.id).length !== 1) fail('guest file not linked exactly once')
  if (gp.mediaSectionOf[guest.meta.id] !== guest.sectionId) fail('guest file not in the linked section')
  const lastAct = gd.activity[gd.activity.length - 1]
  if (lastAct.actor !== guest.linkId) fail('guest activity actor should be the link id, got ' + lastAct.actor)
  guest.metaList.push(guest.meta)

  // over-cap: size > maxFileBytes -> 413
  const capRes = await fetch(`${base}/api/upload/resumable`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${guest.raw}` },
    body: JSON.stringify({ name: 'toobig.bin', parentId, size: 100 * 1024 * 1024 + 1 }),
  })
  console.log('guest over-cap:', capRes.status)
  if (capRes.status !== 413) fail('over-cap should 413')

  // lazy presigning (writer session — the guest link's cap is 100 MB): 11 GB
  // -> 16 URLs at init + presignMoreUrl replenish, then abort
  const bigInit = await fetch(`${base}/api/upload/resumable`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ name: 'huge.mp4', parentId, mimeType: 'video/mp4', size: 11 * 1024 * 1024 * 1024 }),
  })
  const big = await bigInit.json()
  console.log('guest lazy init:', bigInit.status, '| urls:', big.direct?.length, '| more:', !!big.presignMoreUrl)
  if (!bigInit.ok || big.direct?.length !== 16 || !big.presignMoreUrl) process.exit(1)
  const more = await fetch(`${base}${big.presignMoreUrl}&next=17`, { method: 'POST' })
  const moreBody = await more.json()
  console.log('guest presign-more:', more.status, '| urls:', moreBody.direct?.length)
  if (more.status !== 200 || moreBody.direct?.length !== 16) fail('presign-more window failed')
  const bigAbort = await fetch(`${base}${big.url}`, { method: 'DELETE' })
  console.log('guest lazy abort:', bigAbort.status)
  if (bigAbort.status !== 204) fail('lazy session abort failed')

  // in-flight revocation: init now, revoke, completion must 401
  const flightInit = await fetch(`${base}/api/upload/resumable`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${guest.raw}` },
    body: JSON.stringify({ name: 'inflight.webp', parentId, mimeType: 'image/webp', size: 768 * 1024 }),
  })
  const flight = await flightInit.json()
  if (!flightInit.ok) process.exit(1)
  await fetch(flight.direct[0], { method: 'PUT', headers: { 'Content-Type': 'image/webp' }, body: Buffer.alloc(768 * 1024, 3) })
  const rSt = await mint((d) => {
    const l = d.uploadLinks.find((x) => x.id === guest.linkId)
    l.revokedAt = '2.0000'
    l.updatedAt = '2.0000'
    l.writerId = 'e2e'
  })
  const flightComp = await fetch(`${base}${flight.completeUrl}`, { method: 'POST' })
  console.log('revoked completion:', flightComp.status)
  if (flightComp.status !== 401) fail('revoked-link completion should 401')
  const infoAfterRevoke = await fetch(`${base}/api/upload/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: guest.raw }) })
  if (infoAfterRevoke.status !== 401) fail('revoked info should 401')
  const initAfterRevoke = await fetch(`${base}/api/upload/resumable`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${guest.raw}` },
    body: JSON.stringify({ name: 'x.webp', parentId, size: 1024 }),
  })
  if (initAfterRevoke.status !== 401) fail('revoked init should 401')
  console.log('revoked: info/init/completion all 401 OK (mint restore status ' + rSt + ')')

  // expiry: un-revoke but backdate expiry -> 401
  await mint((d) => {
    const l = d.uploadLinks.find((x) => x.id === guest.linkId)
    l.revokedAt = null
    l.expiresAt = new Date(Date.now() - 1000).toISOString()
    l.updatedAt = '3.0000'
    l.writerId = 'e2e'
  })
  const infoExpired = await fetch(`${base}/api/upload/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: guest.raw }) })
  console.log('expired info:', infoExpired.status)
  if (infoExpired.status !== 401) fail('expired info should 401')

  // throttle: 11 bad-token inits — the tail must 429 (failures count; this runs last)
  let last = null
  for (let i = 0; i < 11; i++) {
    last = await fetch(`${base}/api/upload/resumable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer bad-token-bad-token-bad-token' },
      body: JSON.stringify({ name: 'x', parentId, size: 1024 }),
    })
  }
  console.log('throttle last status:', last.status)
  if (last.status !== 429) fail('throttle should 429 after repeated failures')
}

// Cleanup: splice test keys/links/sections back out of the shared doc, then delete the objects.
{
  const { AwsClient } = await import('aws4fetch')
  const s3 = new AwsClient({ accessKeyId: dev.OCI_S3_ACCESS_KEY_ID, secretAccessKey: dev.OCI_S3_SECRET_ACCESS_KEY, service: 's3', region: wr.vars.OCI_S3_REGION })
  const put = (key, body, contentType) => s3.fetch(`${wr.vars.OCI_S3_ENDPOINT}/${wr.vars.OCI_S3_BUCKET}/${key}`, {
    method: 'PUT', headers: { 'Content-Type': contentType }, body,
  })
  const fresh = await fetchDoc()
  const p4 = fresh.projects[project.id]
  for (const m of [meta, smallMeta, ...(guest.metaList ?? [])].filter(Boolean)) {
    p4.fileIds = p4.fileIds.filter((f) => f !== m.id)
    delete p4.mediaSectionOf[m.id]
  }
  fresh.uploadLinks = (fresh.uploadLinks ?? []).filter((l) => l.id !== guest.linkId)
  if (guest.createdSection) p4.mediaSections = p4.mediaSections.filter((sec) => sec.id !== 'sec_guesttest')
  const docPut = await put('master/nexus.json', JSON.stringify(fresh), 'application/json')
  console.log('doc restore:', docPut.status)
  for (const m of [meta, smallMeta, ...(guest.metaList ?? [])].filter(Boolean)) {
    const enc = m.id.split('/').map(encodeURIComponent).join('/')
    const res = await put(enc, Buffer.alloc(0), 'application/octet-stream')
    const del = await s3.fetch(`${wr.vars.OCI_S3_ENDPOINT}/${wr.vars.OCI_S3_BUCKET}/${enc}`, { method: 'DELETE' })
    console.log('cleanup:', m.id.split('/').pop(), '->', del.status)
  }
}
console.log('DIRECT + PROBE-COMPLETE + SERVER-SIDE LINK + GUEST LINKS OK')
