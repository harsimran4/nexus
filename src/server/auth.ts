// Session auth — ported from nexus-worker/src/index.js when the separate
// Worker was absorbed into this app's server functions. HMAC-signed bearer
// tokens, 12h TTL, per-isolate login throttle, PBKDF2 password verification
// against the workspace doc (mirrors src/auth/hashing.ts exactly).

import { env } from 'cloudflare:workers'
import { DOC_KEY, getText } from './s3'
import type { NexusDoc } from '../types/schema'

export const SESSION_TTL_SECONDS = 12 * 60 * 60 // 12h — matches a normal work session

export interface Session {
  uid: string
  name: string
  role: 'admin' | 'editor' | 'viewer'
  epoch?: number
  exp: number
}

// ---------------------------------------------------------------------------
// base64url / HMAC session tokens
// ---------------------------------------------------------------------------
export function b64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function b64urlToBytes(str: string): Uint8Array<ArrayBuffer> {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4))
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
// Uint8Array<ArrayBuffer> (not the ArrayBufferLike default) so the bytes are
// accepted directly by WebCrypto's BufferSource parameters (TS 7 generics).
function utf8(str: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(str) as Uint8Array<ArrayBuffer>
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

export async function signToken(secret: string, payload: Session): Promise<string> {
  const key = await hmacKey(secret)
  const body = b64url(utf8(JSON.stringify(payload)))
  const sigBuf = await crypto.subtle.sign('HMAC', key, utf8(body))
  return body + '.' + b64url(new Uint8Array(sigBuf))
}

export async function verifyToken(secret: string, token: string | null | undefined): Promise<Session | null> {
  if (!token) return null
  const [body, sig] = token.split('.')
  if (!body || !sig) return null
  const key = await hmacKey(secret)
  const ok = await crypto.subtle.verify('HMAC', key, b64urlToBytes(sig), utf8(body))
  if (!ok) return null
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(body))) as Session
    if (!payload.exp || Date.now() > payload.exp) return null
    return payload
  } catch {
    return null
  }
}

export function requireWriter(session: Session | null): boolean {
  return !!session && (session.role === 'admin' || session.role === 'editor')
}

/** Bearer token from the Authorization header (server routes). */
export function bearerFrom(request: Request): string | null {
  return (request.headers.get('Authorization') || '').replace(/^Bearer /, '') || null
}

/** Full writer check for server routes (verify + role + doc re-check). */
export async function requireWriterRequest(request: Request): Promise<Session | null> {
  const session = await verifyToken(env.SESSION_SECRET, bearerFrom(request))
  if (!session || !requireWriter(session)) return null
  if (!(await stillValid(session))) return null
  return session
}

// ---------------------------------------------------------------------------
// Login throttle — best-effort, per isolate (same rationale as the old Worker).
// ---------------------------------------------------------------------------
const LOGIN_WINDOW_MS = 5 * 60 * 1000
const LOGIN_MAX_FAILURES = 10
const loginFailures = new Map<string, { count: number; resetAt: number }>()

export function loginThrottled(ip: string): boolean {
  const now = Date.now()
  const rec = loginFailures.get(ip)
  if (!rec || now > rec.resetAt) {
    loginFailures.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS })
    return false
  }
  rec.count += 1
  if (loginFailures.size > 5000) {
    for (const [k, v] of loginFailures) if (now > v.resetAt) loginFailures.delete(k)
  }
  return rec.count > LOGIN_MAX_FAILURES
}

export function loginForgiven(ip: string): void {
  loginFailures.delete(ip)
}

// ---------------------------------------------------------------------------
// Credential verification — mirrors src/auth/hashing.ts exactly.
// ---------------------------------------------------------------------------
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', utf8(input))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
function toB64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}
export async function verifyStaticToken(raw: string, hash: string): Promise<boolean> {
  return hash === 'sha256$' + (await sha256Hex(raw))
}
async function pbkdf2Bits(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', utf8(password), { name: 'PBKDF2' }, false, ['deriveBits'])
  return crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256)
}
export async function verifyPassword(password: string, auth: { salt: string; hash: string; iterations: number }): Promise<boolean> {
  // pbkdf2 only. Argon2id hashes are legacy and CANNOT be verified here:
  // hash-wasm compiles WASM at runtime, which Workers forbid ("Wasm code
  // generation disallowed by embedder"), and a 64 MiB KDF would also exceed
  // the free plan's 10ms CPU budget. WebCrypto pbkdf2 is native and safe.
  try {
    const salt = fromB64(auth.salt)
    const key = await pbkdf2Bits(password, salt, auth.iterations)
    return toB64(new Uint8Array(key)) === auth.hash
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Doc cache — so a disabled user / password reset takes effect within ~60s of
// every write, instead of only when their 12h token expires.
// ---------------------------------------------------------------------------
let cachedDoc: NexusDoc | null = null
let cachedDocAt = 0

export async function loadNexusDoc(): Promise<NexusDoc> {
  const raw = await getText(DOC_KEY)
  return JSON.parse(raw) as NexusDoc
}

export async function getCachedDoc(): Promise<NexusDoc | null> {
  if (cachedDoc && Date.now() - cachedDocAt < 60_000) return cachedDoc
  try {
    cachedDoc = await loadNexusDoc()
    cachedDocAt = Date.now()
  } catch {
    return cachedDoc // stale copy is better than locking everyone out
  }
  return cachedDoc
}

export function invalidateDocCache(): void {
  cachedDoc = null
  cachedDocAt = 0
}

export async function stillValid(session: Session): Promise<boolean> {
  if (session.role === 'viewer') return true // viewer writes are never allowed anyway
  const doc = await getCachedDoc()
  if (!doc) return true // storage hiccup — don't lock everyone out over a transient failure
  const user = (doc.users?.app ?? []).find((u) => u.id === session.uid)
  if (!user || user.disabled) return false
  if ((user.sessionEpoch ?? 0) !== (session.epoch ?? 0)) return false
  return true
}
