// Nexus Drive Proxy — a small Cloudflare Worker.
//
// Purpose: editors/admins never touch Google auth. They log in with the same
// app token/password Nexus already used. This Worker verifies that secret
// against nexus.json (fetched with ITS OWN Google credentials — the studio
// account's refresh token, held only here as a secret) and issues a signed
// session token. Every subsequent Drive read/write from the app goes through
// this Worker instead of hitting googleapis.com directly, so the real Google
// credential never reaches a browser.
//
// Required secrets (wrangler secret put NAME):
//   GOOGLE_CLIENT_ID       — OAuth client id (Desktop app type is fine)
//   GOOGLE_CLIENT_SECRET   — that client's secret
//   GOOGLE_REFRESH_TOKEN   — minted once for the studio account (see scripts/get-refresh-token.mjs)
//   SESSION_SECRET         — random 32+ byte string, e.g. `openssl rand -base64 32`
// Required vars (wrangler.toml [vars], not secret):
//   NEXUS_FILE_ID          — the id of nexus.json (from your existing .env.local)

const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SESSION_TTL_SECONDS = 12 * 60 * 60 // 12h — matches a normal work session

// ---------------------------------------------------------------------------
// CORS — restrict this to your real GitHub Pages origin before going live.
// ---------------------------------------------------------------------------
function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type,X-Mime-Type,X-File-Name',
    'Access-Control-Expose-Headers': 'Location,Range',
  }
}

function json(data, status, env, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env), ...(extraHeaders || {}) },
  })
}

function err(status, message, env) {
  return json({ error: message }, status, env)
}

// ---------------------------------------------------------------------------
// Google access-token cache (best-effort per isolate; cheap to re-fetch)
// ---------------------------------------------------------------------------
let cachedAccessToken = null
let cachedExpiry = 0

async function getGoogleAccessToken(env) {
  if (cachedAccessToken && Date.now() < cachedExpiry - 60_000) return cachedAccessToken
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: env.GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  })
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) throw new Error('Failed to refresh Google access token: ' + (await res.text()))
  const data = await res.json()
  cachedAccessToken = data.access_token
  cachedExpiry = Date.now() + data.expires_in * 1000
  return cachedAccessToken
}

async function driveFetch(env, path, init = {}, base = DRIVE_API) {
  const token = await getGoogleAccessToken(env)
  const headers = new Headers(init.headers)
  headers.set('Authorization', 'Bearer ' + token)
  const res = await fetch(base + path, { ...init, headers })
  return res
}

// ---------------------------------------------------------------------------
// Session tokens: header.payload.sig, all base64url, HMAC-SHA256 signed.
// ---------------------------------------------------------------------------
function b64url(bytes) {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function b64urlToBytes(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4))
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
function utf8(str) {
  return new TextEncoder().encode(str)
}

async function hmacKey(env) {
  return crypto.subtle.importKey('raw', utf8(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ])
}

async function signSession(env, payload) {
  const key = await hmacKey(env)
  const body = b64url(utf8(JSON.stringify(payload)))
  const sigBuf = await crypto.subtle.sign('HMAC', key, utf8(body))
  const sig = b64url(new Uint8Array(sigBuf))
  return body + '.' + sig
}

async function verifySession(env, token) {
  if (!token) return null
  const [body, sig] = token.split('.')
  if (!body || !sig) return null
  const key = await hmacKey(env)
  const ok = await crypto.subtle.verify('HMAC', key, b64urlToBytes(sig), utf8(body))
  if (!ok) return null
  let payload
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(body)))
  } catch {
    return null
  }
  if (!payload.exp || Date.now() > payload.exp) return null
  return payload
}

function requireWriter(session) {
  return session && (session.role === 'admin' || session.role === 'editor')
}

// Short-lived doc cache so a disabled user / password reset takes effect
// within ~60s of every write, instead of only when their 12h token expires.
let cachedDoc = null
let cachedDocAt = 0
async function getCachedDoc(env) {
  if (cachedDoc && Date.now() - cachedDocAt < 60_000) return cachedDoc
  cachedDoc = await loadNexusDoc(env)
  cachedDocAt = Date.now()
  return cachedDoc
}

async function stillValid(env, session) {
  if (session.role === 'viewer') return true // viewer writes are never allowed anyway
  const doc = await getCachedDoc(env).catch(() => null)
  if (!doc) return true // Drive hiccup — don't lock everyone out over a transient read failure
  const user = (doc.users?.app ?? []).find((u) => u.id === session.uid)
  if (!user || user.disabled) return false
  if ((user.sessionEpoch ?? 0) !== (session.epoch ?? 0)) return false
  return true
}

// ---------------------------------------------------------------------------
// Credential verification — mirrors src/auth/hashing.ts exactly.
// ---------------------------------------------------------------------------
async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', utf8(input))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
function fromB64(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
function toB64(bytes) {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}
async function verifyToken(raw, hash) {
  return hash === 'sha256$' + (await sha256Hex(raw))
}
async function pbkdf2Bits(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', utf8(password), { name: 'PBKDF2' }, false, ['deriveBits'])
  return crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256)
}
async function verifyPassword(password, auth) {
  try {
    if (auth.kind === 'argon2id') {
      const { argon2Verify } = await import('hash-wasm')
      return await argon2Verify({ password, hash: auth.hash })
    }
    const salt = fromB64(auth.salt)
    const key = await pbkdf2Bits(password, salt, auth.iterations)
    return toB64(new Uint8Array(key)) === auth.hash
  } catch {
    return false
  }
}

async function loadNexusDoc(env) {
  const res = await driveFetch(env, `/files/${env.NEXUS_FILE_ID}?alt=media`)
  if (!res.ok) throw new Error('Could not read nexus.json: ' + res.status)
  return res.json()
}

async function handleSession(request, env) {
  const { secret } = await request.json().catch(() => ({}))
  if (!secret || typeof secret !== 'string') return err(400, 'Missing secret', env)
  const doc = await loadNexusDoc(env)

  for (const user of doc.users?.app ?? []) {
    if (user.disabled) continue
    let ok = false
    if (user.auth.kind === 'token') ok = await verifyToken(secret, user.auth.hash)
    else ok = await verifyPassword(secret, user.auth)
    if (ok) {
      const payload = {
        uid: user.id,
        name: user.name,
        role: user.role,
        epoch: user.sessionEpoch ?? 0,
        exp: Date.now() + SESSION_TTL_SECONDS * 1000,
      }
      const token = await signSession(env, payload)
      return json({ token, role: user.role, name: user.name, expiresIn: SESSION_TTL_SECONDS }, 200, env)
    }
  }

  // Viewer capability tokens — kept here too so the API key can eventually be retired.
  const tokenHash = 'sha256$' + (await sha256Hex(secret))
  for (const viewer of doc.users?.viewers ?? []) {
    if (viewer.revokedAt) continue
    if (viewer.tokenHash === tokenHash) {
      const payload = { uid: viewer.id, name: viewer.name, role: 'viewer', exp: Date.now() + SESSION_TTL_SECONDS * 1000 }
      const token = await signSession(env, payload)
      return json({ token, role: 'viewer', name: viewer.name, expiresIn: SESSION_TTL_SECONDS }, 200, env)
    }
  }

  return err(401, 'No matching login', env)
}

// ---------------------------------------------------------------------------
// Drive operations (only the ones the app's bearer-credential path needs)
// ---------------------------------------------------------------------------
const META_FIELDS = 'id,name,headRevisionId,md5Checksum,version,modifiedTime,mimeType,trashed,createdTime'

async function passthroughJson(res, env) {
  const text = await res.text()
  return new Response(text, { status: res.status, headers: { 'Content-Type': 'application/json', ...corsHeaders(env) } })
}

async function opList(env, url) {
  const parent = url.searchParams.get('parent')
  const extraQuery = url.searchParams.get('query') || ''
  const pageSize = url.searchParams.get('pageSize') || '100'
  const pageToken = url.searchParams.get('pageToken')
  const q = `'${parent}' in parents and trashed = false` + (extraQuery ? ' and ' + extraQuery : '')
  const params = new URLSearchParams({ q, fields: 'nextPageToken,files(' + META_FIELDS + ')', pageSize })
  if (pageToken) params.set('pageToken', pageToken)
  return driveFetch(env, `/files?${params.toString()}`)
}

async function opMeta(env, id) {
  return driveFetch(env, `/files/${id}?fields=${META_FIELDS}`)
}

async function opContentGet(env, id) {
  return driveFetch(env, `/files/${id}?alt=media`)
}

async function opContentWrite(env, id, request) {
  const mime = request.headers.get('X-Mime-Type') || 'application/json'
  const body = await request.arrayBuffer()
  return driveFetch(
    env,
    `/files/${id}?uploadType=media&fields=${META_FIELDS}`,
    { method: 'PATCH', headers: { 'Content-Type': mime }, body },
    UPLOAD_API,
  )
}

async function opCreateFolder(env, request) {
  const { name, parentId } = await request.json()
  const body = { name, mimeType: 'application/vnd.google-apps.folder' }
  if (parentId) body.parents = [parentId]
  return driveFetch(env, `/files?fields=${META_FIELDS}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function opCreateFile(env, request) {
  const { name, parentId, content, mimeType } = await request.json()
  const boundary = 'nexusbound' + Math.random().toString(36).slice(2)
  const metadata = JSON.stringify({ name, parents: [parentId], mimeType })
  const bodyText =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n${content}\r\n--${boundary}--`
  return driveFetch(
    env,
    `/files?uploadType=multipart&fields=${META_FIELDS}`,
    { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body: bodyText },
    UPLOAD_API,
  )
}

async function opCopy(env, id, request) {
  const { name, parentId } = await request.json()
  return driveFetch(env, `/files/${id}/copy?fields=${META_FIELDS}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, parents: [parentId] }),
  })
}

// Handles trash / rename / move — Drive's PATCH accepts a body plus
// addParents/removeParents query params in the same call.
async function opPatch(env, id, url, request) {
  const patchBody = await request.json().catch(() => ({}))
  const params = new URLSearchParams({ fields: META_FIELDS })
  const addParent = url.searchParams.get('addParent')
  const removeParent = url.searchParams.get('removeParent')
  if (addParent) params.set('addParents', addParent)
  if (removeParent) params.set('removeParents', removeParent)
  return driveFetch(env, `/files/${id}?${params.toString()}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patchBody),
  })
}

async function opPermission(env, id) {
  return driveFetch(env, `/files/${id}/permissions?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'anyone', role: 'reader' }),
  })
}

async function opUploadSmall(env, request) {
  const form = await request.formData()
  const parentId = form.get('parentId')
  const file = form.get('file')
  if (!(file instanceof File)) throw new Error('Missing file')
  const boundary = 'nexusup' + Math.random().toString(36).slice(2)
  const metadata = JSON.stringify({ name: file.name, parents: [parentId] })
  const head = utf8(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
      `--${boundary}\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`,
  )
  const tail = utf8(`\r\n--${boundary}--`)
  const fileBuf = new Uint8Array(await file.arrayBuffer())
  const combined = new Uint8Array(head.length + fileBuf.length + tail.length)
  combined.set(head, 0)
  combined.set(fileBuf, head.length)
  combined.set(tail, head.length + fileBuf.length)
  return driveFetch(
    env,
    `/files?uploadType=multipart&fields=${META_FIELDS}`,
    { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body: combined },
    UPLOAD_API,
  )
}

// Resumable uploads for large files: init returns an opaque, signed URL
// pointing back at THIS worker, so the browser never sees the real Google
// session URL (or a Google bearer token). PUT chunks are streamed through.
async function opResumableInit(env, request) {
  const { name, parentId, mimeType } = await request.json()
  const res = await driveFetch(
    env,
    `/files?uploadType=resumable&fields=${META_FIELDS}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parents: [parentId], mimeType: mimeType || 'application/octet-stream' }),
    },
    UPLOAD_API,
  )
  if (!res.ok) return passthroughJson(res, env)
  const realUrl = res.headers.get('Location')
  if (!realUrl) return err(502, 'Drive did not return a resumable session URL', env)
  const key = await hmacKey(env)
  const encoded = b64url(utf8(realUrl))
  const sigBuf = await crypto.subtle.sign('HMAC', key, utf8(encoded))
  const sig = b64url(new Uint8Array(sigBuf))
  const proxyUrl = new URL(request.url)
  proxyUrl.pathname = '/drive/upload/resumable'
  proxyUrl.search = `?u=${encoded}&sig=${sig}`
  return json({ url: proxyUrl.toString() }, 200, env)
}

async function opResumablePut(env, url, request) {
  const encoded = url.searchParams.get('u')
  const sig = url.searchParams.get('sig')
  if (!encoded || !sig) return err(400, 'Missing upload target', env)
  const key = await hmacKey(env)
  const valid = await crypto.subtle.verify('HMAC', key, b64urlToBytes(sig), utf8(encoded))
  if (!valid) return err(403, 'Invalid upload signature', env)
  const realUrl = new TextDecoder().decode(b64urlToBytes(encoded))
  const headers = new Headers()
  const contentRange = request.headers.get('Content-Range')
  const contentLength = request.headers.get('Content-Length')
  if (contentRange) headers.set('Content-Range', contentRange)
  if (contentLength) headers.set('Content-Length', contentLength)
  const res = await fetch(realUrl, { method: 'PUT', headers, body: request.body })
  const resHeaders = { ...corsHeaders(env) }
  const range = res.headers.get('Range')
  if (range) resHeaders.Range = range
  const text = res.status === 200 || res.status === 201 ? await res.text() : ''
  return new Response(text, { status: res.status, headers: resHeaders })
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(env) })

    try {
      if (url.pathname === '/session' && request.method === 'POST') {
        return await handleSession(request, env)
      }

      // Resumable PUT carries its own signature, not a session bearer, since
      // large-file chunk requests come from the browser's XHR directly.
      if (url.pathname === '/drive/upload/resumable' && request.method === 'PUT') {
        return await opResumablePut(env, url, request)
      }

      const session = await verifySession(env, (request.headers.get('Authorization') || '').replace(/^Bearer /, ''))
      if (!requireWriter(session)) return err(401, 'Sign in required', env)
      if (!(await stillValid(env, session))) return err(401, 'Session no longer valid — sign in again', env)

      const m = url.pathname.match(/^\/drive\/(.*)$/)
      const sub = m ? m[1] : ''

      let res
      if (sub === 'list' && request.method === 'GET') res = await opList(env, url)
      else if (sub.match(/^meta\/[^/]+$/) && request.method === 'GET') res = await opMeta(env, sub.split('/')[1])
      else if (sub.match(/^content\/[^/]+$/) && request.method === 'GET') res = await opContentGet(env, sub.split('/')[1])
      else if (sub.match(/^content\/[^/]+$/) && request.method === 'PATCH')
        res = await opContentWrite(env, sub.split('/')[1], request)
      else if (sub === 'folders' && request.method === 'POST') res = await opCreateFolder(env, request)
      else if (sub === 'files' && request.method === 'POST') res = await opCreateFile(env, request)
      else if (sub.match(/^files\/[^/]+\/copy$/) && request.method === 'POST') res = await opCopy(env, sub.split('/')[1], request)
      else if (sub.match(/^files\/[^/]+$/) && request.method === 'PATCH')
        res = await opPatch(env, sub.split('/')[1], url, request)
      else if (sub.match(/^permissions\/[^/]+$/) && request.method === 'POST') res = await opPermission(env, sub.split('/')[1])
      else if (sub === 'upload' && request.method === 'POST') res = await opUploadSmall(env, request)
      else if (sub === 'upload/resumable/init' && request.method === 'POST') return await opResumableInit(env, request)
      else return err(404, 'No such route', env)

      return await passthroughJson(res, env)
    } catch (e) {
      return err(500, e instanceof Error ? e.message : 'Worker error', env)
    }
  },
}
