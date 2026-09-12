// Boot sequence: origin check → workspace-ID resolution chain (URL ?t= →
// localStorage → baked config) → initial doc read (key path, or bearer when
// already signed in) → session restore → poller → draft-recovery check.

import { config } from './config'
import { getMeta, readFile, setGlobalApiKey, DriveError } from './drive/client'
import { findWorkspace } from './drive/bootstrap'
import { parseDoc } from './types/schema'
import { storeGet, useStore } from './sync/store'
import { rememberIds, recallIds, loadDraft } from './sync/drafts'
import { restoreSession } from './auth/session'
import { startPolling } from './sync/poller'
import { installPagehideFlush, applyRemoteIfChanged } from './sync/writer'
import { originCheck } from './diagnostics/health'

export interface BootParams {
  viewerToken: string | null
  rootIdParam: string | null
}

export function parseBootParams(): BootParams {
  // Login links carry ?vw=<token>&t=<rootId> inside the hash:
  //   https://host/#/login?vw=...&t=...
  const hash = location.hash
  const qIndex = hash.indexOf('?')
  const params = new URLSearchParams(qIndex >= 0 ? hash.slice(qIndex + 1) : '')
  // Also accept plain query params before the hash (some link generators).
  if (!params.get('t')) {
    const top = new URLSearchParams(location.search)
    const t = top.get('t')
    const vw = top.get('vw')
    return { viewerToken: params.get('vw') ?? vw, rootIdParam: params.get('t') ?? t }
  }
  return { viewerToken: params.get('vw'), rootIdParam: params.get('t') }
}

export async function boot(): Promise<void> {
  const store = storeGet()
  const blocked = originCheck()
  if (blocked) {
    store.setStatus('blocked', blocked.message)
    store.setBootError(blocked.fix)
    return
  }
  if (!config.apiKey) {
    store.setStatus('blocked', 'Build config incomplete')
    store.setBootError(
      'No API key configured. Copy .env.example to .env.local, fill VITE_NEXUS_API_KEY (and VITE_NEXUS_CLIENT_ID), then rebuild.',
    )
    return
  }
  setGlobalApiKey(config.apiKey)

  const params = parseBootParams()
  if (params.rootIdParam) rememberIds({ rootFolderId: params.rootIdParam, nexusFileId: recallIds()?.nexusFileId ?? '' })

  // Resolve workspace IDs: URL param → lastGoodIds → baked config.
  let rootId = params.rootIdParam ?? recallIds()?.rootFolderId ?? config.rootFolderId
  let nexusId = recallIds()?.nexusFileId || config.nexusFileId

  try {
    if (!nexusId && rootId) {
      const ws = await findWorkspace(rootId, { mode: 'key', apiKey: effectiveKey() })
      if (ws?.nexusFileId) nexusId = ws.nexusFileId
    }
    if (!nexusId) {
      // Maybe the visitor is a signed-in editor whose workspace isn't key-visible.
      store.setStatus('needsInit')
      return
    }

    const cred = { mode: 'key' as const, apiKey: effectiveKey() }
    try {
      await getMeta(nexusId, cred)
    } catch (e) {
      if (e instanceof DriveError && (e.kind === 'notFound' || e.kind === 'permission') && rootId === '') {
        store.setStatus('needsInit')
        return
      }
      // fall through — applyRemoteIfChanged will classify (corrupt/blocked/etc.)
    }

    // Prime the doc from the key path (or bearer when present — tokenClient
    // sets it after sign-in, which on a reload means we read via bearer here).
    const result = await initialRead(nexusId)
    if (result === 'corrupt') return
    if (result === 'none') {
      store.setStatus('needsInit')
      return
    }

    const doc = storeGet().doc
    if (doc) {
      if (doc.ids.rootFolderId) rootId = doc.ids.rootFolderId
      rememberIds({ rootFolderId: rootId, nexusFileId: nexusId })
      startPolling(nexusId)
    }
    installPagehideFlush()
    restoreSession()
    const draft = await checkBootDraft()
    if (draft) useStore.setState({ bootError: `__draft_recovery__${draft.savedAt}` })
    if (storeGet().status === 'booting') storeGet().setStatus('ok')
  } catch (e) {
    store.setStatus('blocked', e instanceof Error ? e.message : 'Boot failed')
    store.setBootError(e instanceof Error ? e.message : 'Unknown boot failure')
  }
}

function effectiveKey(): string {
  return storeGet().doc?.settings.api.keyOverride ?? config.apiKey
}

async function initialRead(nexusId: string): Promise<'ok' | 'corrupt' | 'none'> {
  const store = storeGet()
  const cred = { mode: 'key' as const, apiKey: effectiveKey() }
  try {
    const raw = await readFile(nexusId, cred)
    const parsed = parseDoc(raw)
    if (!parsed.ok) {
      store.setStatus('corrupt', 'The workspace file on Drive is not valid nexus.json')
      store.setBootError('Ask an admin to restore from a snapshot (Admin → Maintenance). The corrupt copy was kept.')
      return 'corrupt'
    }
    if (parsed.doc.schema > config.maxKnownSchema) {
      store.setDoc(parsed.doc)
      store.setLastReadViaKey(true)
      store.setStatus('readOnly', `Written by a newer Nexus (schema ${parsed.doc.schema}) — update the app`)
      return 'ok'
    }
    parsed.doc.ids.nexusFileId = parsed.doc.ids.nexusFileId || nexusId
    store.setDoc(parsed.doc)
    store.setLastReadViaKey(true)
    store.markSynced()
    store.setStatus('ok')
    return 'ok'
  } catch (e) {
    if (e instanceof DriveError) {
      if (e.kind === 'notFound' || e.kind === 'permission') {
        store.setStatus('needsInit')
        return 'none'
      }
      if (e.kind === 'downloadRestricted') {
        store.setStatus('blocked', 'Drive "Viewers can\'t download" is ON')
        store.setBootError('An admin must turn off "Viewers can\'t download" in the Drive folder\'s sharing settings — it blocks all viewer reads.')
        return 'corrupt'
      }
    }
    throw e
  }
}

async function checkBootDraft(): Promise<{ savedAt: string } | null> {
  const { checkDraftRecovery } = await import('./sync/writer')
  const draft = await loadDraft()
  if (!draft) return null
  return checkDraftRecovery()
}

/** Used by the poller/applyRemote path once signed in (bearer reads for editors). */
export async function refreshViaBearer(nexusId: string): Promise<void> {
  await applyRemoteIfChanged(nexusId, { mode: 'auto' })
}
