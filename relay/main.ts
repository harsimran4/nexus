// Nexus write relay — Deno Deploy.
//
// The zero-Google write path for editors. The app sends writes HERE with a
// short HMAC ticket (obtained at Nexus login); the relay verifies the Nexus
// secret against nexus.json (sha256 tokens / argon2id / pbkdf2 — the exact
// hashes stored in the doc), then writes to Drive AS THE STUDIO ACCOUNT via a
// stored OAuth refresh token. Editors never see Google.
//
// Secrets (Deno Deploy → Settings → Environment variables):
//   GOOGLE_CLIENT_ID      — the same OAuth client the app uses
//   GOOGLE_CLIENT_SECRET  — its client secret (Cloud Console → Credentials)
//   GOOGLE_REFRESH_TOKEN  — offline-access refresh token (scripts/get-refresh-token.mjs)
//   NEXUS_FILE_ID         — VITE_NEXUS_FILE_ID from the app's .env.local
//   TICKET_SECRET         — any long random string (openssl rand -hex 32)
//
// Endpoints: GET /health · POST /verify {secret} · POST /write {baseVersion, doc}

import { argon2Verify } from 'npm:hash-wasm@4.12.0'

const CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') ?? ''
const CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') ?? ''
const REFRESH_TOKEN = Deno.env.get('GOOGLE_REFRESH_TOKEN') ?? ''
const FILE_ID = Deno.env.get('NEXUS_FILE_ID') ?? ''
const TICKET_SECRET = Deno.env.get('TICKET_SECRET') ?? ''

const TICKET_TTL_MS = 7 * 24 * 3600 * 1000

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS } })
}

// --- Google Drive access (as the studio account) ---------------------------

let cachedToken: { token: string; exp: number } | null = null

async function googleToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.exp - 60_000) return cachedToken.token
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) throw new Error(`Google token refresh failed (${res.status})`)
  const j = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!j.access_token) throw new Error('Google token refresh returned no access_token')
  cachedToken = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 }
  return cachedToken.token
}

async function readDoc(): Promise<string> {
  const token = await googleToken()
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${FILE_ID}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Drive read failed (${res.status})`)
  return res.text()
}

/** Overwrite nexus.json on Drive. Returns the new version token. */
async function writeDoc(body: string): Promise<{ version: string; md5Checksum?: string }> {
  const token = await googleToken()
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${FILE_ID}?uploadType=media&fields=version,md5Checksum`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body,
    },
  )
  if (!res.ok) throw new Error(`Drive write failed (${res.status})`)
  const j = (await res.json()) as { version?: string; md5Checksum?: string }
  return { version: j.version ?? '', md5Checksum: j.md5Checksum }
}

// --- Tickets ----------------------------------------------------------------

const enc = new TextEncoder()

function b64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function hmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(TICKET_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ])
}

async function mintTicket(userId: string): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({ uid: userId, exp: Date.now() + TICKET_TTL_MS })))
  const sig = b64url(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(), enc.encode(payload))))
  return `${payload}.${sig}`
}

async function checkTicket(ticket: string | null): Promise<{ uid: string } | null> {
  if (!ticket || !ticket.includes('.')) return null
  const [payload, sig] = ticket.split('.')
  const expected = await crypto.subtle.sign('HMAC', await hmacKey(), enc.encode(payload))
  const got = Uint8Array.from(atob(sig.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice((sig.length + 3) % 4)))
  if (got.length !== expected.byteLength) return null
  let diff = 0
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ new Uint8Array(expected)[i]
  if (diff !== 0) return null
  try {
    const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)))) as { uid?: string; exp?: number }
    if (!json.uid || !json.exp || Date.now() > json.exp) return null
    return { uid: json.uid }
  } catch {
    return null
  }
}

// --- Secret verification (same hashes the app stores) ------------------------

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(input))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

interface AppUserAuth {
  kind: 'token' | 'pbkdf2' | 'argon2id'
  hash: string
  salt?: string
  iterations?: number
}

async function verifySecret(secret: string, auth: AppUserAuth): Promise<boolean> {
  try {
    if (auth.kind === 'token') return auth.hash === 'sha256$' + (await sha256Hex(secret))
    if (auth.kind === 'argon2id') return await argon2Verify({ password: secret, hash: auth.hash })
    // pbkdf2
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'PBKDF2' }, false, ['deriveBits'])
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: fromBase64(auth.salt ?? ''), iterations: auth.iterations ?? 600_000, hash: 'SHA-256' },
      key,
      256,
    )
    let bin = ''
    for (const b of new Uint8Array(bits)) bin += String.fromCharCode(b)
    return btoa(bin) === auth.hash
  } catch {
    return false
  }
}

// --- Router --------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  const url = new URL(req.url)

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, file: FILE_ID ? 'configured' : 'MISSING_NEXUS_FILE_ID' })
    }

    if (req.method === 'POST' && url.pathname === '/verify') {
      const { secret } = (await req.json()) as { secret?: string }
      if (!secret) return json({ error: 'Missing secret' }, 400)
      const raw = await readDoc()
      const doc = JSON.parse(raw) as { users?: { app?: { id: string; disabled?: boolean; role?: string; auth?: AppUserAuth }[] } }
      for (const user of doc.users?.app ?? []) {
        if (user.disabled || !user.auth) continue
        if (user.role === 'viewer') continue
        if (await verifySecret(secret, user.auth)) {
          return json({ ok: true, ticket: await mintTicket(user.id), role: user.role, name: user.id })
        }
      }
      return json({ error: 'No matching login' }, 401)
    }

    if (req.method === 'POST' && url.pathname === '/write') {
      const authed = await checkTicket(new Headers(req.headers).get('Authorization')?.replace(/^Bearer\s+/i, '') ?? null)
      if (!authed) return json({ error: 'Write session expired — sign in again' }, 401)
      const body = (await req.json()) as { baseVersion?: string | null; doc?: string }
      if (!body.doc) return json({ error: 'Missing doc' }, 400)

      // Verify-token-then-write: refuse to overwrite a file that moved since
      // the client last read it. A missing baseVersion is treated as moved —
      // never write blind (the client then merges and retries with a version).
      const token = await googleToken()
      const meta = await fetch(
        `https://www.googleapis.com/drive/v3/files/${FILE_ID}?fields=version`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      if (!meta.ok) throw new Error(`Drive meta failed (${meta.status})`)
      const metaJson = (await meta.json()) as { version?: string }
      if (!body.baseVersion || metaJson.version !== body.baseVersion) {
        return json({ error: 'conflict', doc: await readDoc(), version: metaJson.version ?? '' }, 409)
      }

      // Cheap sanity check before the write — never persist unparseable JSON.
      JSON.parse(body.doc)
      const written = await writeDoc(body.doc)
      return json({ ok: true, ...written })
    }

    return json({ error: 'Not found' }, 404)
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Relay failure' }, 500)
  }
})
