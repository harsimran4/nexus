// Google Identity Services token client (implicit-style, zero backend).
// - Access tokens are ~1h, kept in memory ONLY, never refreshed silently by
//   the library. Re-requesting requires a user gesture (browser rule); the
//   silent prompt:'' attempt works while the Google session cookie lives.
// - The app never pretends background refresh exists: 401s surface the
//   Reconnect chip, which calls requestToken() from that click's gesture.

import { config, missingConfig } from '../config'
import { setGlobalBearer } from '../drive/client'

const GSI_SRC = 'https://accounts.google.com/gsi/client'

type TokenResponse = { access_token?: string; expires_in?: number; error?: string }
type TokenCallback = (resp: TokenResponse) => void

interface TokenClient {
  requestAccessToken: (overrides?: { prompt?: string }) => void
}

let gisPromise: Promise<void> | null = null
let tokenClient: TokenClient | null = null
let accessToken: string | null = null
let expiresAt = 0

const listeners = new Set<(signedIn: boolean) => void>()

function notify(): void {
  for (const fn of listeners) fn(accessToken !== null)
}

export function onTokenChange(fn: (signedIn: boolean) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function isSignedIn(): boolean {
  return accessToken !== null
}

/** True only while the token exists AND has >30s of life left. */
export function isTokenValid(): boolean {
  return accessToken !== null && Date.now() < expiresAt - 30_000
}

export function getBearerToken(): string | null {
  return isTokenValid() ? accessToken : null
}

/** Drop a dead/stale token without revoking it at Google (it's already useless). */
export function clearToken(): void {
  setToken(null, 0)
}

export function tokenTimeLeftMs(): number {
  return accessToken === null ? 0 : Math.max(0, expiresAt - Date.now())
}

function setToken(token: string | null, expiresIn: number): void {
  accessToken = token
  expiresAt = token ? Date.now() + expiresIn * 1000 : 0
  setGlobalBearer(token)
  notify()
}

function loadGis(): Promise<void> {
  if (gisPromise) return gisPromise
  const missing = missingConfig()
  if (missing.length) {
    gisPromise = Promise.reject(new Error(`Missing build config: ${missing.join(', ')} — copy .env.example to .env.local`))
    return gisPromise
  }
  gisPromise = new Promise((resolve, reject) => {
    if (typeof google !== 'undefined' && google.accounts?.oauth2) return resolve()
    const script = document.createElement('script')
    script.src = GSI_SRC
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Failed to load Google Identity Services (offline or blocked?)'))
    document.head.appendChild(script)
  })
  return gisPromise
}

declare global {
  // eslint-disable-next-line no-var
  var google: {
    accounts: {
      oauth2: {
        initTokenClient: (cfg: {
          client_id: string
          scope: string
          callback: TokenCallback
          error_callback?: (err: { type?: string; message?: string }) => void
        }) => TokenClient
        revoke: (token: string, done?: () => void) => void
      }
    }
  }
}

/**
 * Pre-load the GIS script and create the token client at app boot, so a later
 * sign-in click runs requestAccessToken while the browser still counts it as
 * a user gesture. (Loading the script inside the click handler takes long
 * enough for the browser to block the popup.)
 */
export function warmupAuth(): Promise<void> {
  return ensureClient().then(
    () => undefined,
    () => undefined,
  )
}

async function ensureClient(): Promise<TokenClient> {
  if (tokenClient) return tokenClient
  await loadGis()
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: config.clientId,
    scope: config.scopes.join(' '),
    callback: (resp) => {
      if (resp.error) {
        // Wrong account / dismissed consent — leave state untouched.
        return
      }
      if (resp.access_token) setToken(resp.access_token, resp.expires_in ?? 3600)
    },
    error_callback: () => {
      /* popup closed / origin not registered — surfaced by probe failures */
    },
  })
  return tokenClient
}

/**
 * Request a token. MUST be called from a user gesture (click/keydown) for the
 * consent popup to be allowed. silentFirst: prompt:'' reuses the live Google
 * session without a popup when possible. silentOnly: never pop up — used at
 * boot to quietly re-acquire a token when the Google session still lives.
 */
export async function requestToken(opts: { silentFirst?: boolean; silentOnly?: boolean } = {}): Promise<void> {
  await ensureClient()
  const silentAttempt = (timeoutMs: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), timeoutMs)
      const oneShot = google.accounts.oauth2.initTokenClient({
        client_id: config.clientId,
        scope: config.scopes.join(' '),
        callback: (resp) => {
          clearTimeout(timeout)
          if (resp.access_token) {
            setToken(resp.access_token, resp.expires_in ?? 3600)
            resolve(true)
          } else resolve(false)
        },
        error_callback: () => {
          clearTimeout(timeout)
          resolve(false)
        },
      })
      oneShot.requestAccessToken({ prompt: '' })
    })

  if (opts.silentFirst || opts.silentOnly) {
    const got = await silentAttempt(opts.silentOnly ? 8_000 : 15_000)
    if (got) return
    if (opts.silentOnly) throw new Error('No live Google session — sign in manually')
    // No popup fallback here: by now the original user gesture is long gone
    // and the browser blocks the window (GSI_LOGGER "Maybe blocked by the
    // browser?"). Surface a clear message instead — the next direct click
    // opens the popup fine.
    throw new Error('Google session ended — click "Connect Google (studio account)" to sign in again')
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Sign-in timed out')), 120_000)
    const oneShot = google.accounts.oauth2.initTokenClient({
      client_id: config.clientId,
      scope: config.scopes.join(' '),
      callback: (resp) => {
        clearTimeout(timeout)
        if (resp.access_token) {
          setToken(resp.access_token, resp.expires_in ?? 3600)
          resolve()
        } else {
          reject(new Error(resp.error ?? 'Sign-in failed'))
        }
      },
      error_callback: (err) => {
        clearTimeout(timeout)
        reject(new Error(err.message ?? 'Sign-in popup was closed'))
      },
    })
    oneShot.requestAccessToken({})
  })
}

export async function signOut(): Promise<void> {
  if (accessToken) {
    try {
      await loadGis()
      google.accounts.oauth2.revoke(accessToken)
    } catch {
      /* token already dead */
    }
  }
  setToken(null, 0)
}
