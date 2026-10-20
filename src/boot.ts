// Boot sequence: origin check → P6 cached snapshot (instant paint of the
// last good state) → network read (D1 snapshot at stage 3, else the bucket
// doc) → pollers → hub → session restore. One bucket IS the workspace: there
// are no workspace-id params to resolve anymore.
//
// P6 failure posture: if the network read fails but a cached snapshot was
// painted, the app STAYS UP on that snapshot labelled 'offline' (self-heals
// on the next successful read — the poller clears the label). Without a
// cache, boot fails loudly exactly as before.

import { config } from './config'
import { readFile, DriveError } from './drive/client'
import { gatewayNoteDoc } from './sync/gateway'
import { loadBootSnapshot, putBootSnapshot, clearBootSnapshot } from './sync/bootCache'
import { DOC_KEY } from './server/keys'
import { parseDoc } from './types/schema'
import { storeGet } from './sync/store'
import { restoreSession } from './auth/session'
import { startPolling } from './sync/poller'
import { startHub } from './sync/hubClient'
import { originCheck } from './diagnostics/health'
import { getScopedSession, bootScoped, refreshScoped, startScopedRefresh } from './sync/scoped'

// Set when a cached snapshot was painted, so a failed revalidation can say
// HOW stale the view is ("showing as of …").
let cachedAt: string | null = null

export async function boot(): Promise<void> {
  // P8: a scoped share session owns this tab — every doc read goes through
  // the scoped fn and NOTHING else runs (no public read, no boot cache, no
  // poller/hub, no session restore). Without this divert, a reload of
  // /project/<id> would run the normal boot and paint the whole workspace.
  if (getScopedSession()) {
    await bootScoped()
    return
  }
  const store = storeGet()
  const blocked = originCheck()
  if (blocked) {
    store.setStatus('blocked', blocked.message)
    store.setBootError(blocked.fix)
    return
  }

  try {
    await renderCachedSnapshot()

    let result: 'ok' | 'corrupt' | 'none'
    try {
      result = await initialRead()
    } catch (e) {
      // Network dead (or the fns route unreachable). With a cached snapshot
      // on screen, stay on it — labelled; without one, fail loudly as before.
      if (!storeGet().doc) throw e
      storeGet().setStatus('offline', `Showing your workspace as of ${fmtTime(cachedAt)} — edits are kept and will sync`)
      return
    }
    if (result === 'corrupt') return
    if (result === 'none') {
      // The workspace is genuinely gone/reset — a stale render must not
      // survive as a ghost workspace (and must not accept queued writes).
      await clearBootSnapshot()
      return
    }

    if (storeGet().doc) {
      startPolling(DOC_KEY)
      startHub(DOC_KEY) // P5 live push — a hub outage just leaves the poller
    }
    await restoreSession()
    if (storeGet().status === 'booting') storeGet().setStatus('ok')
  } catch (e) {
    store.setStatus('blocked', e instanceof Error ? e.message : 'Boot failed')
    store.setBootError(e instanceof Error ? e.message : 'Unknown boot failure')
  }
}

/** Retry the network read in place (the Offline pill). A success flips the
 *  status back; a failure keeps the labelled stale view. */
export async function revalidateBoot(): Promise<void> {
  // A scoped session revalidates through the scoped fn — initialRead()'s
  // public fallback would pull the whole workspace into the tab.
  const scoped = getScopedSession()
  if (scoped) {
    await refreshScoped(scoped)
    startScopedRefresh()
    return
  }
  try {
    const result = await initialRead()
    if (result === 'ok') {
      storeGet().setStatus('ok')
      return
    }
    if (result === 'none') await clearBootSnapshot()
  } catch {
    storeGet().setStatus('offline', `Still offline — showing your workspace as of ${fmtTime(cachedAt)}`)
  }
}

async function renderCachedSnapshot(): Promise<void> {
  const store = storeGet()
  const snap = await loadBootSnapshot()
  if (!snap) return
  const parsed = parseDoc(snap.raw)
  if (!parsed.ok || parsed.doc.schema > config.maxKnownSchema) return
  cachedAt = snap.at
  store.setDoc(parsed.doc)
  gatewayNoteDoc(parsed.doc)
  store.setStatus('ok')
}

function fmtTime(iso: string | null): string {
  if (!iso) return 'your last sync'
  try {
    return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return 'your last sync'
  }
}

async function initialRead(): Promise<'ok' | 'corrupt' | 'none'> {
  const store = storeGet()
  // STAGE 3: boot from the D1 snapshot (one batched read = one consistent
  // view). Below stage 3 (or without a binding) the fn answers without raw
  // and we read the bucket doc as always — one probe, no flags.
  try {
    const { bootstrapFn } = await import('./server/fns')
    const boot = await bootstrapFn({})
    if (boot.ok && boot.data.raw) {
      const parsed = parseDoc(boot.data.raw)
      if (parsed.ok && parsed.doc.schema <= config.maxKnownSchema) {
        store.setDoc(parsed.doc)
        gatewayNoteDoc(parsed.doc)
        store.markSynced()
        store.setStatus('ok')
        void putBootSnapshot(boot.data.raw)
        return 'ok'
      }
    }
    // stage < 3, no binding, or regen issue -> legacy bucket read below
  } catch {
    /* fall through to the bucket read */
  }
  try {
    const raw = await readFile(DOC_KEY)
    const parsed = parseDoc(raw)
    if (!parsed.ok) {
      store.setStatus('needsReset', 'The workspace file in storage is not readable by this version of Nexus')
      store.setBootError(
        'The database in storage was written by an older/different format. ' +
          'Use the setup below to write a fresh database (the files already in the bucket stay where they are).',
      )
      return 'corrupt'
    }
    if (parsed.doc.schema > config.maxKnownSchema) {
      store.setDoc(parsed.doc)
      store.setStatus('readOnly', `Written by a newer Nexus (schema ${parsed.doc.schema}) — update the app`)
      return 'ok'
    }
    store.setDoc(parsed.doc)
    gatewayNoteDoc(parsed.doc)
    store.markSynced()
    store.setStatus('ok')
    void putBootSnapshot(raw)
    return 'ok'
  } catch (e) {
    if (e instanceof DriveError && (e.kind === 'notFound' || e.kind === 'permission')) {
      store.setStatus('needsInit')
      return 'none'
    }
    throw e
  }
}
