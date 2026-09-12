// App-managed sessions on top of the master doc.
// - Editors/admins: sign in with the secret (token or password) the admin
//   issued; identity lives in sessionStorage (dies with the tab).
// - Viewers: the minted capability token is the identity — kept in
//   localStorage (possession IS the identity) and re-verified against
//   users.viewers on every poll so revocation lands within one cycle.
// Roles are re-derived from the live doc on every check, so disabling a user
// takes effect immediately.

import { sha256Hex, verifyToken, verifyPassword, type PasswordHash } from './hashing'
import type { NexusDoc, Role } from '../types/schema'
import { storeGet, useStore } from '../sync/store'
import { sessionRef } from '../sync/identity'

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

export async function loginWithSecret(secret: string): Promise<{ ok: true; session: Session } | { ok: false; error: string }> {
  const doc = storeGet().doc
  if (!doc) return { ok: false, error: 'Workspace not loaded yet — try again in a moment' }
  const trimmed = secret.trim()
  if (!trimmed) return { ok: false, error: 'Enter your access token or password' }

  const tokenHash = 'sha256$' + (await sha256Hex(trimmed))

  // App users first (tokens or passwords).
  for (const user of doc.users.app) {
    if (user.disabled) continue
    if (user.auth.kind === 'token' && (await verifyToken(trimmed, user.auth.hash))) {
      return grant({ appUserId: user.id, name: user.name, role: user.role }, null)
    }
    if (user.auth.kind !== 'token' && (await verifyPassword(trimmed, user.auth as PasswordHash))) {
      return grant({ appUserId: user.id, name: user.name, role: user.role }, null)
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
      return grant({ appUserId: viewer.id, name: viewer.name, role: 'viewer' }, trimmed)
    }
  }

  return { ok: false, error: 'No matching login — check the token/password, or ask an admin' }
}

async function grant(session: Session, viewerToken: string | null): Promise<{ ok: true; session: Session }> {
  useStore.setState({ session })
  try {
    if (viewerToken) sessionStorage.removeItem(SESSION_KEY)
    else sessionStorage.setItem(SESSION_KEY, JSON.stringify({ appUserId: session.appUserId }))
  } catch {
    /* ignore */
  }
  return { ok: true, session }
}

export function restoreSession(): void {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (raw) {
      const { appUserId } = JSON.parse(raw) as { appUserId: string }
      rederive(appUserId)
      return
    }
  } catch {
    /* ignore */
  }
  reverifyViewerSession()
}

/** Re-derive the session from the CURRENT doc — called on every poll. */
export function rederiveSession(): void {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (raw) {
      const { appUserId } = JSON.parse(raw) as { appUserId: string }
      rederive(appUserId)
      return
    }
  } catch {
    /* ignore */
  }
  reverifyViewerSession()
}

function rederive(appUserId: string): void {
  const doc = storeGet().doc
  if (!doc) return
  const user = doc.users.app.find((u) => u.id === appUserId)
  if (!user || user.disabled) {
    logout()
    return
  }
  useStore.setState({ session: { appUserId: user.id, name: user.name, role: user.role } })
}

/** Poller hook: viewer tokens re-verified; revoked/disabled sessions cleared. */
export function reverifyViewerSession(): void {
  rederiveSession()
}

export function logout(): void {
  useStore.setState({ session: null })
  try {
    sessionStorage.removeItem(SESSION_KEY)
    localStorage.removeItem(VIEWER_KEY)
  } catch {
    /* ignore */
  }
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
