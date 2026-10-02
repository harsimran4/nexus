// Boot sequence: origin check → initial doc read (public /files route —
// anonymous, viewer and editor share the same path) → poller → session
// restore. One bucket IS the workspace: there are no workspace-id params to
// resolve anymore.

import { config } from './config'
import { readFile, DriveError } from './drive/client'
import { DOC_KEY } from './server/keys'
import { parseDoc } from './types/schema'
import { storeGet } from './sync/store'
import { restoreSession } from './auth/session'
import { startPolling } from './sync/poller'
import { originCheck } from './diagnostics/health'

export async function boot(): Promise<void> {
  const store = storeGet()
  const blocked = originCheck()
  if (blocked) {
    store.setStatus('blocked', blocked.message)
    store.setBootError(blocked.fix)
    return
  }

  try {
    const result = await initialRead()
    if (result === 'corrupt') return
    if (result === 'none') return

    if (storeGet().doc) startPolling(DOC_KEY)
    await restoreSession()
    if (storeGet().status === 'booting') storeGet().setStatus('ok')
  } catch (e) {
    store.setStatus('blocked', e instanceof Error ? e.message : 'Boot failed')
    store.setBootError(e instanceof Error ? e.message : 'Unknown boot failure')
  }
}

async function initialRead(): Promise<'ok' | 'corrupt' | 'none'> {
  const store = storeGet()
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
    store.markSynced()
    store.setStatus('ok')
    return 'ok'
  } catch (e) {
    if (e instanceof DriveError && (e.kind === 'notFound' || e.kind === 'permission')) {
      store.setStatus('needsInit')
      return 'none'
    }
    throw e
  }
}
