// Peer awareness without a server: poll the workspace file's tokens every N ms
// and on focus/visibility. No push webhooks exist for a backend-less app.
// The poller never writes — it reconciles read state only (the writer
// reconciles its own conflicts during commit).

import { hasBearer } from '../drive/client'
import { storeGet } from './store'
import { applyRemoteIfChanged } from './writer'
import { reverifySessions } from '../auth/session'
import { sweepAutoArchive } from '../state/actions'

let timer: ReturnType<typeof setInterval> | null = null

export function startPolling(nexusId: string): void {
  if (timer) clearInterval(timer)
  const tick = () => void pollOnce(nexusId)
  timer = setInterval(tick, storeGet().doc?.settings.sync.pollMs ?? 10_000)
  window.addEventListener('focus', tick)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') tick()
  })
}

export function stopPolling(): void {
  if (timer) clearInterval(timer)
  timer = null
}

async function pollOnce(nexusId: string): Promise<void> {
  const store = storeGet()
  if (!store.doc || store.status === 'booting' || store.status === 'needsInit' || store.status === 'corrupt') return
  const cred = { mode: hasBearer() ? ('auto' as const) : ('key' as const) }
  // applyRemoteIfChanged does the single cheap files.get per tick itself.
  await applyRemoteIfChanged(nexusId, cred)
  sweepAutoArchive()
  await reverifySessions()
}
