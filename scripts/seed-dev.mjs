// Seed the fake-S3 bucket with a deterministic fixture workspace for e2e.
//   node scripts/seed-dev.mjs [endpoint] [bucket]
// (fake-s3.mjs accepts any Authorization — the worker's signed requests land
// the same way.) The seed is also the SINGLE SEAM P4 swaps: today it writes a
// fixture master/nexus.json; post-D1 it inserts SQL rows. Journeys never know.
//
// Login for the journeys: password `e2e admin passphrase` (>=12 with a space,
// per the password policy), stretched with the salt below using the EXACT
// client algorithm (src/auth/hashing.ts: PBKDF2-SHA256 600k → base64url →
// sha256$hex), so the real /login form works.

// Tiny but structurally valid one-page PDF (pdf.js tolerates a rough xref).
const TINY_PDF = [
  '%PDF-1.4',
  '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
  '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
  '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 220 110] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
  '4 0 obj << /Length 46 >> stream',
  'BT /F1 18 Tf 20 55 Td (E2E PDF page) Tj ET',
  'endstream endobj',
  '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
  'trailer << /Root 1 0 R /Size 6 >>',
  '%%EOF',
].join('\n')

const E2E_PDF_KEY = 'groups/E2E Group/E2E Upload Target/e2e-doc.pdf'

const ENDPOINT = (process.argv[2] ?? process.env.FAKE_S3_ENDPOINT ?? 'http://127.0.0.1:9399').replace(/\/+$/, '')
const BUCKET = process.argv[3] ?? process.env.FAKE_S3_BUCKET ?? 'nexus'

export const E2E_ADMIN_PASSWORD = 'e2e admin passphrase'
export const E2E_SALT = 'e2esalt_e2esalt_e2' // 16 chars, base64url-ish — public by design

const enc = encodeURIComponent
const url = (key, query = '') => `${ENDPOINT}/${BUCKET}/${enc(key)}${query}`

async function put(key, body, contentType = 'application/octet-stream') {
  const res = await fetch(url(key), { method: 'PUT', headers: { 'Content-Type': contentType }, body })
  if (!res.ok) throw new Error(`seed PUT ${key} → ${res.status}: ${await res.text().catch(() => '')}`)
}

async function sha256Hex(input) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Same stretch as src/auth/hashing.ts stretchSecret() — PBKDF2-SHA256, 600k,
// 256 bits, base64url. WebCrypto is global in Node 18+.
async function stretch(secret, saltB64) {
  const salt = Uint8Array.from(atob(saltB64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'PBKDF2' }, false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 600_000, hash: 'SHA-256' }, key, 256)
  const bin = String.fromCharCode(...new Uint8Array(bits))
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Deterministic guest upload link: raw token is public in this repo ON PURPOSE
// (it only unlocks a throwaway e2e bucket).
const GUEST_RAW_TOKEN = 'e2e-guest-token-0123456789abcdef'
// P8: a scoped share-link viewer — the e2e journey opens /share/<this token>.
const SCOPED_RAW_TOKEN = 'e2e-scoped-token-0123456789abcdef'

async function main() {
  const salt = E2E_SALT
  const stretched = await stretch(E2E_ADMIN_PASSWORD, salt)
  const adminHash = 'sha256$' + (await sha256Hex(stretched))
  const guestHash = 'sha256$' + (await sha256Hex(GUEST_RAW_TOKEN))
  const scopedHash = 'sha256$' + (await sha256Hex(SCOPED_RAW_TOKEN))

  const now = '2026-01-01T00:00:00.000Z'
  const doc = {
    schema: 1,
    rev: 7,
    writerId: 'seed',
    updatedAt: now,
    ids: { rootFolderId: '', nexusFileId: 'master/nexus.json' },
    users: {
      app: [
        {
          id: 'u_e2e_admin',
          name: 'E2E Admin',
          role: 'admin',
          disabled: false,
          auth: { kind: 'token', hash: adminHash },
          createdAt: now,
          createdBy: 'seed',
          sessionEpoch: 1,
          updatedAt: now,
          writerId: 'seed',
        },
      ],
      studioSub: null,
      viewers: [
        {
          id: 'vw_e2e_scoped',
          name: 'Scoped Client',
          tokenHash: scopedHash,
          createdAt: now,
          createdBy: 'seed',
          revokedAt: null,
          note: 'one-project share link',
          scope: 'prj_e2e_upload',
          updatedAt: now,
          writerId: 'seed',
        },
      ],
    },
    settings: {
      updatedAt: now,
      writerId: 'seed',
      rootFolderName: 'Nexus Root',
      authStretchSalt: salt,
      api: { keyOverride: null },
      privacy: { requireViewerLogin: false, redactNames: false },
      pipeline: [
        { id: 'pending', label: 'Pending', bucket: 'todo' },
        { id: 'in_process', label: 'In process', bucket: 'doing' },
        { id: 'completed', label: 'Completed', bucket: 'done' },
      ],
      labels: ['finished', 'client-approved', 'needs-review'],
      workflow: { archiveDoneAfterDays: 30 },
      sync: { debounceMs: 400, pollMs: 60_000, tombstoneGcDays: 90, snapshotKeep: 30, maxDocBytes: 4_000_000 },
    },
    uploadLinks: [
      {
        id: 'ul_e2e_guest',
        tokenHash: guestHash,
        projectId: 'prj_e2e_upload',
        sectionId: 'sec_raw',
        maxFileBytes: 1024 * 1024 * 1024,
        note: 'e2e guest link',
        createdAt: now,
        createdBy: 'seed',
        expiresAt: '2036-01-01T00:00:00.000Z',
        revokedAt: null,
        updatedAt: now,
        writerId: 'seed',
      },
    ],
    refs: [],
    groups: {
      grp_e2e: {
        id: 'grp_e2e',
        name: 'E2E Group',
        description: 'seeded',
        folderId: null,
        color: '',
        createdAt: now,
        updatedAt: now,
        writerId: 'seed',
        deleted: null,
        archivedAt: null,
      },
    },
    projects: {
      prj_e2e_move: {
        id: 'prj_e2e_move',
        groupId: 'grp_e2e',
        name: 'E2E Move Target',
        folderId: null,
        status: 'pending',
        labels: [],
        fileIds: [],
        mediaSections: [],
        mediaSectionOf: {},
        assigneeAppId: null,
        dueAt: null,
        notes: '',
        approved: null,
        createdAt: now,
        updatedAt: now,
        writerId: 'seed',
        deleted: null,
        archivedAt: null,
      },
      prj_e2e_upload: {
        id: 'prj_e2e_upload',
        groupId: 'grp_e2e',
        name: 'E2E Upload Target',
        folderId: null,
        status: 'in_process',
        labels: [],
        fileIds: [E2E_PDF_KEY],
        mediaSections: [{ id: 'sec_raw', name: 'Raw' }],
        mediaSectionOf: { [E2E_PDF_KEY]: 'sec_raw' },
        assigneeAppId: null,
        dueAt: null,
        notes: '',
        approved: null,
        createdAt: now,
        updatedAt: now,
        writerId: 'seed',
        deleted: null,
        archivedAt: null,
      },
    },
    scripts: {
      scr_e2e: {
        id: 'scr_e2e',
        title: 'E2E Script',
        storage: { type: 'inline', body: '# Seeded body\n\nOriginal line.\n' },
        projectId: 'prj_e2e_move',
        status: 'draft',
        copies: [],
        createdAt: now,
        updatedAt: now,
        writerId: 'seed',
        deleted: null,
        archivedAt: null,
      },
    },
    tombstones: [],
    activity: [{ at: now, actor: 'system:seed', verb: 'seed', ref: 'workspace', meta: {} }],
    snapshots: [],
    crypto: null,
  }

  await put('master/nexus.json', JSON.stringify(doc, null, 2), 'application/json')
  // System folder markers (SYSTEM_PREFIXES) + the project's folder marker.
  for (const prefix of ['master/', 'snapshots/', 'groups/', 'scripts/', 'trash/', 'progress/']) {
    await put(`${prefix}__folder__`, '')
  }
  await put('groups/E2E Group/__folder__', '')
  await put('groups/E2E Group/E2E Move Target/__folder__', '')
  await put('groups/E2E Group/E2E Upload Target/__folder__', '')
  await put(E2E_PDF_KEY, TINY_PDF, 'application/pdf')
  // The seeded script's inline body lives in the doc; a script MD file for the
  // md-storage path if a journey needs it later.
  await put('scripts/scr_e2e.md', '# Seeded body\n\nOriginal line.\n', 'text/markdown')
  // A snapshot for the restore journey: a copy of the doc + its meta entry.
  // The snapshot FILE must carry the snapshots meta itself: restoring adopts
  // the file's content as the doc, so a file without its own entry makes the
  // seeded snapshot vanish from Maintenance after the first restore.
  const withSnapshot = { ...doc, snapshots: [{ fileId: 'snapshots/nexus-2026-01-01.json', rev: 7, at: now, by: 'seed', note: '2026-01-01' }] }
  await put('snapshots/nexus-2026-01-01.json', JSON.stringify(withSnapshot, null, 2), 'application/json')
  await put('master/nexus.json', JSON.stringify(withSnapshot, null, 2), 'application/json')

  console.log(`seeded ${BUCKET} at ${ENDPOINT} — admin password: "${E2E_ADMIN_PASSWORD}", guest token: ${GUEST_RAW_TOKEN}, scoped share token: ${SCOPED_RAW_TOKEN}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
