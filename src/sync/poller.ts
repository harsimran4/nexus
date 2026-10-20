// Peer awareness: the P5 hub pushes {rev} on every confirmed write; this
// poller is the FALLBACK (dead socket, pre-hub tab) and the home of the
// periodic duties (auto-archive sweep, session re-verification). It never
// writes — it reconciles read state only (the writer reconciles its own
// conflicts during commit).

import { storeGet } from './store'
import { applyRemoteIfChanged } from './writer'
import { reverifySessions } from '../auth/session'
import { sweepAutoArchive } from '../state/actions'

let timer: ReturnType<typeof setInterval> | null = null

export function startPolling(nexusId: string): void {
  if (timer) clearInterval(timer)
  const tick = () => void pollOnce(nexusId)
  // Push makes the interval a backstop, not the update path — 30s is plenty.
  timer = setInterval(tick, storeGet().doc?.settings.sync.pollMs ?? 30_000)
  window.addEventListener('focus', tick)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') tick()
  })
}

export function stopPolling(): void {
  if (timer) clearInterval(timer)
  timer = null
}

/** One poll pass — the hub's push handler reuses this exact path (coalesced
 *  there; never more than one in-flight pass per tab matters here anyway:
 *  applyRemoteIfChanged's meta check makes repeat passes near-free). */
export function pollNow(nexusId: string): void {
  void pollOnce(nexusId)
}

async function pollOnce(nexusId: string): Promise<void> {
  const store = storeGet()
  if (!store.doc || store.status === 'booting' || store.status === 'needsInit' || store.status === 'corrupt') return
  // applyRemoteIfChanged does the single cheap meta read per tick itself.
  const applied = await applyRemoteIfChanged(nexusId)
  // P6: a successful read is proof the connection is back — clear the
  // offline label without waiting for the next write.
  if (applied === 'applied' && storeGet().status === 'offline') storeGet().setStatus('ok', null)
  sweepAutoArchive()
  await reverifySessions()
}
