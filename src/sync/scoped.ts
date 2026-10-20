// P8 — the scoped share-link session, as a FIRST-CLASS client mode.
//
// The share page (/share/<token>) receives a doc subset that contains ONLY the
// scoped project — the server filter is the enforcement. But a subset in the
// store is not a mode: without the state below, a RELOAD of /project/<id>
// runs the normal boot, which falls back to the public doc read and paints
// the whole workspace (and any P6 cached snapshot from an earlier full
// session repaints instantly). So a scoped session persists device-locally
// and diverts EVERY doc-reading path:
//
//   boot()          → bootScoped() — never the public read, never the boot
//                     cache, never the poller or hub (the scoped refresh
//                     below IS the poll), never restoreSession.
//   revalidateBoot  → refreshScoped() — the Offline pill re-reads through
//                     the scoped fn, never initialRead().
//
// The whole-workspace share flavor (scope = '') does NOT engage this mode —
// its answer is the full doc, byte-identical to what the public read already
// serves, so the normal (anonymous) flow is correct for it.

import { config } from '../config'
import { parseDoc } from '../types/schema'
import { storeGet, useStore } from './store'
import { originCheck } from '../diagnostics/health'

const SCOPED_KEY = 'nexus.scopedSession'

export interface ScopedSession {
  token: string
  projectId: string
  viewerId: string
  viewerName: string
}

export function getScopedSession(): ScopedSession | null {
  try {
    const raw = localStorage.getItem(SCOPED_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as ScopedSession
    return typeof s.token === 'string' && typeof s.projectId === 'string' && s.projectId !== '' ? s : null
  } catch {
    return null
  }
}

export function setScopedSession(s: ScopedSession): void {
  try {
    localStorage.setItem(SCOPED_KEY, JSON.stringify(s))
  } catch {
    /* ignore — in-memory session still works for this tab */
  }
}

export function clearScopedSession(): void {
  try {
    localStorage.removeItem(SCOPED_KEY)
  } catch {
    /* ignore */
  }
  stopScopedRefresh()
}

// ---------------------------------------------------------------------------
// The scoped refresh — the ONLY read path a scoped tab ever uses.
// ---------------------------------------------------------------------------

let timer: ReturnType<typeof setInterval> | null = null

/** One round: the scoped fn answers the subset (or refuses). A network
 *  failure with a subset already on screen degrades to the offline label —
 *  exactly the P6 posture, minus the boot cache. */
export async function refreshScoped(s: ScopedSession): Promise<void> {
  const store = storeGet()
  try {
    const { scopedBootstrapFn } = await import('../server/fns')
    const res = await scopedBootstrapFn({ data: { token: s.token } })
    if (!res.ok) {
      // Revoked or the project is gone: the link is dead — say so and stop
      // refreshing. (Clear the session so the next reload behaves like any
      // anonymous visit instead of re-entering a dead mode. The subset stays
      // on screen under a blocked banner — the viewer already had it.)
      clearScopedSession()
      store.setStatus('blocked', res.message)
      store.setBootError(res.message)
      return
    }
    const parsed = parseDoc(res.data.raw)
    if (!parsed.ok || parsed.doc.schema > config.maxKnownSchema) {
      store.setStatus('readOnly', 'This link served content this version cannot read — update the app')
      return
    }
    store.setDoc(parsed.doc)
    useStore.setState({
      session: { appUserId: res.data.viewerId, name: res.data.viewerName, role: 'viewer', scope: res.data.projectId ?? '' },
    })
    store.markSynced()
    store.setStatus('ok')
  } catch {
    if (storeGet().doc) {
      storeGet().setStatus('offline', 'Can’t reach the server — showing the shared project as last received')
    } else {
      storeGet().setStatus('blocked', 'Could not reach the server — reopen the share link in a moment')
    }
  }
}

/** Boot path for a persisted scoped session. Deliberately does NOT touch the
 *  P6 boot cache (a snapshot from an earlier full session must never paint
 *  here), the public doc read, the poller, the hub, or session restore. */
export async function bootScoped(): Promise<void> {
  const s = getScopedSession()
  if (!s) return
  const store = storeGet()
  const blocked = originCheck()
  if (blocked) {
    store.setStatus('blocked', blocked.message)
    store.setBootError(blocked.fix)
    return
  }
  await refreshScoped(s)
  startScopedRefresh()
}

/** The scoped tab's pulse (survives route changes — the share PAGE's own
 *  interval dies with the component, this one doesn't). */
export function startScopedRefresh(): void {
  const s = getScopedSession()
  if (!s) return
  stopScopedRefresh()
  timer = setInterval(() => {
    const cur = getScopedSession()
    if (cur) void refreshScoped(cur)
  }, 30_000)
}

export function stopScopedRefresh(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
