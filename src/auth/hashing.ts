// Credential hashing for app-managed logins.
// Preferred: capability tokens — 256-bit random, ONLY sha256(token) stored.
//   256 bits of entropy need no slow KDF; the token IS the secret.
// Optional: typed passwords — Argon2id via hash-wasm (wasm ships base64-inlined
// inside the JS, so the single-file artifact stays single-file), with a
// PBKDF2-SHA256 600k fallback if wasm allocation fails on low-end devices.
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

const PBKDF2_ITERATIONS = 600_000 // OWASP floor for PBKDF2-SHA256
const PBKDF2_ALGO = 'pbkdf2'

export type PasswordHash =
  | { kind: 'argon2id'; hash: string }
  | { kind: 'pbkdf2'; hash: string; salt: string; iterations: number }

function toBase64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = randomBytes(16)
  try {
    const { argon2id } = await import('hash-wasm')
    const phc = await argon2id({
      password,
      salt, // hash-wasm accepts Uint8Array
      parallelism: 1,
      iterations: 3,
      memorySize: 65_536, // KiB = 64 MiB
      hashLength: 32,
      outputType: 'encoded',
    })
    return { kind: 'argon2id', hash: phc }
  } catch {
    // wasm alloc failure (old/low-end devices) → OWASP-floor PBKDF2
    const key = await pbkdf2Bits(password, salt, PBKDF2_ITERATIONS)
    return {
      kind: 'pbkdf2',
      hash: toBase64(new Uint8Array(key)),
      salt: toBase64(salt),
      iterations: PBKDF2_ITERATIONS,
    }
  }
}

async function pbkdf2Bits(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), { name: PBKDF2_ALGO }, false, [
    'deriveBits',
  ])
  return crypto.subtle.deriveBits(
    { name: PBKDF2_ALGO, salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    key,
    256,
  )
}

export async function verifyPassword(password: string, auth: PasswordHash): Promise<boolean> {
  try {
    if (auth.kind === 'argon2id') {
      const { argon2Verify } = await import('hash-wasm')
      return await argon2Verify({ password, hash: auth.hash })
    }
    const salt = fromBase64(auth.salt)
    const key = await pbkdf2Bits(password, salt, auth.iterations)
    return toBase64(new Uint8Array(key)) === auth.hash
  } catch {
    return false
  }
}

/** Length/composition policy: ≥15 chars, or ≥12 with a space (passphrase-style). */
export function passwordPolicyError(pw: string): string | null {
  if (pw.length > 128) return 'Password must be at most 128 characters'
  if (pw.length >= 15) return null
  if (pw.length >= 12 && pw.includes(' ')) return null
  return 'Use at least 15 characters (or 12+ with a space — passphrase style)'
}
