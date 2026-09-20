// Credential hashing for app-managed logins.
// Preferred: capability tokens — 256-bit random, ONLY sha256(token) stored.
//   256 bits of entropy need no slow KDF; the token IS the secret.
// Passwords: STRETCHED IN THE BROWSER. loginWithSecret derives
//   K = PBKDF2-SHA256(secret, settings.authStretchSalt, 600k) locally and
//   sends K; the doc stores sha256(K) and the Worker only byte-compares
//   hashes (the existing verifyToken path). Rationale: Cloudflare Workers
//   forbid runtime WASM (which killed hash-wasm's argon2id) and cap WebCrypto
//   PBKDF2 at 100k iterations / 10ms CPU — so the OWASP-strength KDF runs
//   client-side, where no cap exists. The salt is public by design (it defeats
//   precomputation, not readers); 600k per guess is what makes attacking the
//   link-readable doc's hashes expensive. Argon2id stays legal in the schema
//   as a legacy kind only — never create new ones.
// No pepper is possible in this architecture: everything is link-readable.

import { randomBytes } from '../util/random'

export function toBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Mint a 256-bit capability token: returns the raw secret (show once) + its stored hash. */
export async function mintToken(): Promise<{ raw: string; hash: string }> {
  const raw = toBase64Url(randomBytes(32))
  return { raw, hash: 'sha256$' + (await sha256Hex(raw)) }
}

export async function verifyToken(raw: string, hash: string): Promise<boolean> {
  return hash === 'sha256$' + (await sha256Hex(raw))
}

// Cloudflare's workerd caps PBKDF2 at 100k — but this runs in the BROWSER,
// which has no such cap, so we use the full OWASP floor for PBKDF2-SHA256.
export const STRETCH_ITERATIONS = 600_000

/** Fresh doc-wide login salt (settings.authStretchSalt). Public by design. */
export function newStretchSalt(): string {
  return toBase64Url(randomBytes(16))
}

/** K = PBKDF2-SHA256(secret, salt, iterations), base64url — sent INSTEAD of the secret. */
export async function stretchSecret(secret: string, saltB64: string, iterations: number): Promise<string> {
  const salt = Uint8Array.from(atob(saltB64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'PBKDF2' }, false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256)
  return toBase64Url(new Uint8Array(bits))
}

/** Stored auth for a password user: sha256 of the browser-stretched secret. */
export async function stretchedAuth(secret: string, saltB64: string): Promise<{ kind: 'token'; hash: string }> {
  const stretched = await stretchSecret(secret, saltB64, STRETCH_ITERATIONS)
  return { kind: 'token', hash: 'sha256$' + (await sha256Hex(stretched)) }
}

/** Length/composition policy: ≥15 chars, or ≥12 with a space (passphrase-style). */
export function passwordPolicyError(pw: string): string | null {
  if (pw.length > 128) return 'Password must be at most 128 characters'
  if (pw.length >= 15) return null
  if (pw.length >= 12 && pw.includes(' ')) return null
  return 'Use at least 15 characters (or 12+ with a space — passphrase style)'
}
