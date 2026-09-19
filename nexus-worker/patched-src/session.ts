// App-managed sessions on top of the master doc.
// - Editors/admins: the secret is now verified by the Worker (it fetches
//   nexus.json with its own Google credential and checks the hash there).
//   Success returns a short-lived signed session token, stored the same way
//   the old Google bearer used to be (setGlobalBearer) — every Drive write
//   in drive/client.ts already reads it from there via `{ mode: 'bearer' }`.
// - Viewers: unchanged — the capability token is still checked locally
//   against the doc already loaded via the API key.

import { sha256Hex } from './hashing'
import type { NexusDoc, Role } from '../types/schema'
import { storeGet, useStore } from '../sync/store'
import { sessionRef } from '../sync/identity'
import { setGlobalBearer } from '../drive/client'

const WORKER = (import.meta.env.VITE_NEXUS_WORKER_URL ?? '').replace(/\/$/, '')
const SESSION_KEY = 'nexus.session'
const VIEWER_KEY = 'nexus.viewerToken'
const WORKER_TOKEN_KEY = 'nexus.workerToken' // sessionStorage — dies with the tab, same lifetime as before

export interface Session {
  appUserId: string
  name: string
  role: Role
}

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

async function loginWithSecret(secret: string): Promise<{ ok: true; session: Session } | { ok: false; error: string }> {
  const doc = storeGet().doc
  if (!doc) return { ok: false, error: 'Workspace not loaded yet — try again in a moment' }
  const trimmed = secret.trim()
  if (!trimmed) return { ok: false, error: 'Enter your access token or password' }

  // Editors/admins: ask the Worker (it owns the real verification now).
  if (WORKER) {
    try {
      const res = await fetch(`${WORKER}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: trimmed }),
      })
      if (res.ok) {
        const data = (await res.json()) as { token: string; role: Role; name: string }
        if (data.role !== 'viewer') {
          setGlobalBearer(data.token)
          try {
            sessionStorage.setItem(WORKER_TOKEN_KEY, data.token)
          } catch {
            /* ignore */
          }
          const session: Session = { appUserId: `worker:${data.name}`, name: data.name, role: data.role }
          writeSession(session)
          useStore.setState({ session })
          return { ok: true, session }
        }
        // Worker also recognizes viewer tokens; fall through to the shared
        // local viewer path so behaviour (localStorage key, revocation checks
        // on poll) stays exactly as it was.
      }
    } catch {
      // Worker unreachable — surface this clearly rather than silently
      // falling back to a mode that can't actually write to Drive.
      return { ok: false, error: 'Could not reach the Nexus server — check your connection and try again' }
    }
  }

  // Viewer capability tokens (unchanged local check).
  const tokenHash = 'sha256$' + (await sha256Hex(trimmed))
  for (const viewer of doc.users.viewers) {
    if (viewer.revokedAt) continue
    if (viewer.tokenHash === tokenHash) {
      try {
        localStorage.setItem(VIEWER_KEY, trimmed)
      } catch {
        /* ignore */
      }
      const session: Session = { appUserId: viewer.id, name: viewer.name, role: 'viewer' }
      useStore.setState({ session })
      return { ok: true, session }
    }
  }

  return { ok: false, error: 'No matching login — check the token/password, or ask an admin' }
}

function writeSession(session: Session): void {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session))
  } catch {
    /* ignore */
  }
}

export async function loginWithSecretPublic(secret: string): Promise<{ ok: true; session: Session } | { ok: false; error: string }> {
  return loginWithSecret(secret)
}
export { loginWithSecret }

/** Restore the session at boot: re-check the worker token / viewer token are still valid. */
export async function restoreSession(): Promise<void> {
  const storedWorkerToken = readJson<string>(sessionStorage, WORKER_TOKEN_KEY) ?? sessionStorage.getItem(WORKER_TOKEN_KEY)
  const stored = readJson<Session>(sessionStorage, SESSION_KEY)
  if (storedWorkerToken && stored) {
    // Optimistic restore — the Worker enforces the real check on every write;
    // an expired/invalid token simply fails on the next call and the UI
    // surfaces "sign in required" the same way a dead Google token used to.
    setGlobalBearer(storedWorkerToken)
    useStore.setState({ session: stored })
    return
  }
  await verifyViewer()
}

export async function reverifySessions(): Promise<void> {
  await verifyViewer()
}

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
    try {
      localStorage.removeItem(VIEWER_KEY)
    } catch {
      /* ignore */
    }
    if (storeGet().session?.role === 'viewer') useStore.setState({ session: null })
  }
}

export function logout(): void {
  useStore.setState({ session: null })
  try {
    sessionStorage.removeItem(SESSION_KEY)
    sessionStorage.removeItem(WORKER_TOKEN_KEY)
  } catch {
    /* ignore */
  }
  setGlobalBearer(null)
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
