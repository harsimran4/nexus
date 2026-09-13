// Boot sequence: origin check → workspace-ID resolution chain (URL ?t= →
// localStorage → baked config) → initial doc read (key path, or bearer when
// already signed in) → session restore → poller → draft-recovery check.

import { config } from './config'
import { readFile, setGlobalApiKey, DriveError } from './drive/client'
import { findWorkspace } from './drive/bootstrap'
import { parseDoc } from './types/schema'
import { storeGet } from './sync/store'
import { rememberIds, recallIds, loadDraft } from './sync/drafts'
import { restoreSession } from './auth/session'
import { startPolling } from './sync/poller'
import { isSignedIn, requestToken } from './auth/tokenClient'
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
  // Pre-load Google Identity Services so the first sign-in click opens its
  // popup while the browser still honors the user gesture.
  void import('./auth/tokenClient').then((t) => t.warmupAuth())

  const params = parseBootParams()
  if (params.rootIdParam) rememberIds({ rootFolderId: params.rootIdParam, nexusFileId: recallIds()?.nexusFileId ?? '' })

  // Resolve workspace IDs. The BAKED config id wins over browser memory:
  // localStorage survives across deploys and can point at a stale (pre-reset)
  // database, which then fails the new-format parse and dead-ends in setup.
  let rootId = params.rootIdParam ?? recallIds()?.rootFolderId ?? config.rootFolderId
  let nexusId = config.nexusFileId || recallIds()?.nexusFileId || ''

  try {
    // Quietly try to reuse a live Google session so returning editors read via
    // bearer immediately (never pops up — 8s cap so boot never hangs).
    if (!isSignedIn()) {
      await requestToken({ silentOnly: true }).catch(() => {})
    }

    if (!nexusId && rootId) {
      const ws = await findWorkspace(rootId, { mode: 'key', apiKey: effectiveKey() })
      if (ws?.nexusFileId) nexusId = ws.nexusFileId
    }
    if (!nexusId) {
      // Maybe the visitor is a signed-in editor whose workspace isn't key-visible.
      store.setStatus('needsInit')
      return
    }

    // Prime the doc: bearer when we have one (editors), else the API key.
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
    await restoreSession()
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
  const cred: Parameters<typeof readFile>[1] = isSignedIn()
    ? { mode: 'auto' }
    : { mode: 'key', apiKey: effectiveKey() }
  try {
    let raw: string
    try {
      raw = await readFile(nexusId, cred)
    } catch (e) {
      // A network/CORS TypeError on the key path almost always means the API
      // key's HTTP-referrer restriction doesn't include this origin (Google
      // answers such rejections without CORS headers, so fetch can't see them).
      if (e instanceof DriveError && e.kind === 'network') {
        throw new Error(
          'The API key rejected this origin. In Google Cloud Console → Credentials → API key → Website restrictions, add: ' +
            location.origin + '/* — then reload.',
        )
      }
      throw e
    }
    const parsed = parseDoc(raw)
    if (!parsed.ok) {
      store.setStatus('needsReset', 'The workspace file on Drive is not readable by this version of Nexus')
      store.setBootError(
        'The database on Drive was written by an older/different format. ' +
          'Use the setup below — Nexus will reuse your existing Drive folder and write a fresh database into it (the old file goes to Drive trash).',
      )
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

/** Re-check for an unconfirmed draft at boot time (App shows the recovery modal). */
export async function checkBootDraft(): Promise<{ savedAt: string } | null> {
  const draft = await loadDraft()
  if (!draft) return null
  return { savedAt: draft.savedAt }
}
