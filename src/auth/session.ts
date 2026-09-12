// App-managed sessions on top of the master doc.
// - Editors/admins: sign in with the secret (token or password) the admin
//   issued; identity lives in sessionStorage (dies with the tab). Sessions are
//   bound to the user's credential epoch — a reset bumps it and every active
//   session for that user is signed out on its next check.
// - Viewers: the minted capability token is the identity — kept in
//   localStorage (possession IS the identity) and re-verified against
//   users.viewers on every poll so revocation lands within one cycle.
// Roles are re-derived from the live doc on every check, so disabling a user
// takes effect immediately.

import { sha256Hex, verifyToken, verifyPassword, type PasswordHash } from './hashing'
import type { NexusDoc, Role } from '../types/schema'
import { storeGet, useStore } from '../sync/store'
import { sessionRef } from '../sync/identity'
import { clearToken } from './tokenClient'

export interface Session {
  appUserId: string
  name: string
  role: Role
}

const SESSION_KEY = 'nexus.session'
const VIEWER_KEY = 'nexus.viewerToken'

// writer.ts reads this for activity attribution.
export function getSession(): Session | null {
  return storeGet().session
}
sessionRef.getSession = getSession

function readJson<T>(store: Storage, key: string): T | null {
  try {
    const raw = store.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function writeSession(appUserId: string, authEpoch: number): void {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ appUserId, authEpoch }))
  } catch {
    /* ignore */
  }
}

async function loginWithSecret(
  secret: string,
): Promise<{ ok: true; session: Session } | { ok: false; error: string }> {
  const doc = storeGet().doc
  if (!doc) return { ok: false, error: 'Workspace not loaded yet — try again in a moment' }
  const trimmed = secret.trim()
  if (!trimmed) return { ok: false, error: 'Enter your access token or password' }

  const tokenHash = 'sha256$' + (await sha256Hex(trimmed))

  // App users first (tokens or passwords).
  for (const user of doc.users.app) {
    if (user.disabled) continue
    if (user.auth.kind === 'token' && (await verifyToken(trimmed, user.auth.hash))) {
      return grant(user, trimmed)
    }
    if (user.auth.kind !== 'token' && (await verifyPassword(trimmed, user.auth as PasswordHash))) {
      return grant(user, trimmed)
    }
  }

  // Viewer capability tokens.
  for (const viewer of doc.users.viewers) {
    if (viewer.revokedAt) continue
    if (viewer.tokenHash === tokenHash) {
      try {
        localStorage.setItem(VIEWER_KEY, trimmed)
      } catch {
        /* ignore */
      }
      useStore.setState({
        session: { appUserId: viewer.id, name: viewer.name, role: 'viewer' },
      })
      return {
        ok: true,
        session: { appUserId: viewer.id, name: viewer.name, role: 'viewer' },
      }
    }
  }

  return { ok: false, error: 'No matching login — check the token/password, or ask an admin' }
}

/** Bind the session to the credential generation so resets sign sessions out. */
async function grant(
  user: NexusDoc['users']['app'][number],
  _secret: string,
): Promise<{ ok: true; session: Session }> {
  writeSession(user.id, user.sessionEpoch ?? 0)
  useStore.setState({ session: { appUserId: user.id, name: user.name, role: user.role } })
  return { ok: true, session: { appUserId: user.id, name: user.name, role: user.role } }
}

export async function loginWithSecretPublic(
  secret: string,
): Promise<{ ok: true; session: Session } | { ok: false; error: string }> {
  return loginWithSecret(secret)
}
export { loginWithSecret }

/** Restore the session at boot (editors from sessionStorage, viewers from their token). */
export async function restoreSession(): Promise<void> {
  const stored = readJson<{ appUserId: string; authEpoch?: number }>(sessionStorage, SESSION_KEY)
  if (stored) {
    await rederiveEditor(stored.appUserId, stored.authEpoch ?? 0)
    if (storeGet().session) return
  }
  await verifyViewer()
}

/** Poller hook: re-derive editor sessions + re-verify viewer tokens. */
export async function reverifySessions(): Promise<void> {
  const stored = readJson<{ appUserId: string; authEpoch?: number }>(sessionStorage, SESSION_KEY)
  if (stored) {
    await rederiveEditor(stored.appUserId, stored.authEpoch ?? 0)
    if (storeGet().session) return
  }
  await verifyViewer()
}

/** Editor sessions: user must still exist, be enabled, and be on the same credential epoch. */
async function rederiveEditor(appUserId: string, authEpoch: number): Promise<void> {
  const doc = storeGet().doc
  if (!doc) return
  const user = doc.users.app.find((u) => u.id === appUserId)
  if (!user || user.disabled || (user.sessionEpoch ?? 0) !== authEpoch) {
    logout()
  } else {
    useStore.setState({ session: { appUserId: user.id, name: user.name, role: user.role } })
  }
}

/** Viewer sessions: the stored token must still hash to a non-revoked viewer. */
async function verifyViewer(): Promise<void> {
  const doc = storeGet().doc
  let token: string | null = null
  try {
    token = localStorage.getItem(VIEWER_KEY)
  } catch {
    token = null
  }
  if (!token || !doc) return
  const hash = 'sha256$' + (await sha256Hex(token))
  const viewer = doc.users.viewers.find((v) => v.tokenHash === hash)
  if (viewer && !viewer.revokedAt) {
    useStore.setState({ session: { appUserId: viewer.id, name: viewer.name, role: 'viewer' } })
  } else {
    // Revoked or removed — clear the session and the stored token.
    try {
      localStorage.removeItem(VIEWER_KEY)
    } catch {
      /* ignore */
    }
    useStore.setState({ session: null })
  }
}

export function logout(): void {
  useStore.setState({ session: null })
  try {
    sessionStorage.removeItem(SESSION_KEY)
  } catch {
    /* ignore */
  }
  // Do NOT clear VIEWER_KEY — signing out of an editor session shouldn't
  // drop a viewer token on a shared machine; logout-then-login is explicit.
  clearToken()
  // Drop this session's unsynced edits: they were attributed to the signing-out
  // user and must not be written under whoever signs in next. The IndexedDB
  // draft keeps them recoverable.
  void import('../sync/writer').then((w) => w.discardPendingForLogout())
}

export function currentSession(): Session | null {
  return storeGet().session
}

export function canWrite(): boolean {
  const role = storeGet().session?.role
  return role === 'admin' || role === 'editor'
}

export function canAdmin(): boolean {
  return storeGet().session?.role === 'admin'
}

export function viewerLoginRequired(doc: NexusDoc): boolean {
  return doc.settings.privacy.requireViewerLogin && currentSession() === null
}
