// The ONLY write path. Algorithm (see plan):
//   commit() → debounce → verify-token-then-write → on remote change:
//   download → parse/validate → merge → re-assert pending entities with fresh
//   stamps (self-heal) → retry, max 5 → still failing: banner, edits queued.
// Fail-safe rules: ambiguous change tokens = changed (never write blind);
// corrupt remote = quarantine + blocked; newer schema = readOnly; no token =
// reconnect (queued, never dropped).

import { config } from '../config'
import { DriveError, backoffRetry, getMeta, readFile, writeFileJson, copyFile } from '../drive/client'
import { emptyDoc, parseDoc, type NexusDoc } from '../types/schema'
import { hlcNow, observeHlc } from '../util/hlc'
import { mergeRemote, gcTombstones } from './merge'
import { loadDraft, clearDraft, saveDraft } from './drafts'
import { storeGet, useStore } from './store'
import { ensureSnapshotsFolder } from '../drive/bootstrap'
import { getBearerToken } from '../auth/tokenClient'
import { writerId, sessionActor, sessionRef } from './identity'

const MAX_ATTEMPTS = 5
const KEEPALIVE_MAX_BYTES = 60_000 // verified fetch keepalive cap: 64KiB body

type EntityMapName = 'projects' | 'items' | 'scripts'
export { writerId }

/** Stamp an entity after mutating it — call INSIDE your commit mutator. */
export function touch(map: EntityMapName, entity: { updatedAt: string; writerId: string } & Record<string, unknown>): void {
  entity.updatedAt = hlcNow()
  entity.writerId = writerId()
  scratch.set(entity.id as string, { map, entity: structuredClone(entity) })
}

/** Append a deletion marker + tombstone (deletes never remove keys). */
export function recordTombstone(doc: NexusDoc, type: 'project' | 'item' | 'script', id: string, by: string): void {
  const at = hlcNow()
  doc.tombstones = [...doc.tombstones.filter((t) => !(t.type === type && t.id === id)), { type, id, at, by }]
}

export function appendActivity(
  doc: NexusDoc,
  verb: string,
  ref: string,
  meta: Record<string, unknown> = {},
  actor?: string,
): void {
  doc.activity = [
    ...doc.activity,
    { at: hlcNow(), actor: actor ?? sessionActor(), verb, ref, meta },
  ].slice(-1500)
}

// ---------------------------------------------------------------------------
// Pending-edit tracking
// ---------------------------------------------------------------------------

const scratch = new Map<string, { map: EntityMapName; entity: Record<string, unknown> }>()

export function pendingCount(): number {
  return scratch.size
}

function reassertPending(doc: NexusDoc): void {
  for (const { map, entity } of scratch.values()) {
    const fresh = { ...entity, updatedAt: hlcNow(), writerId: writerId() } as Record<string, unknown>
    if (fresh.deleted) fresh.deleted = { at: fresh.updatedAt as string, by: fresh.writerId as string }
    doc[map] = { ...doc[map], [String(fresh.id)]: fresh as never }
  }
}

function applyMerged(doc: NexusDoc): void {
  observeHlc(doc.updatedAt)
  reassertPending(doc)
  useStore.getState().setDoc(gcTombstones(doc, doc.settings.sync.tombstoneGcDays, Date.now()))
}

// ---------------------------------------------------------------------------
// commit() — the public entry point for every mutation
// ---------------------------------------------------------------------------

let mutex: Promise<unknown> = Promise.resolve()
let saveTimer: ReturnType<typeof setTimeout> | null = null

/** Apply a mutation to the doc, mirror to IndexedDB, schedule a save. */
export function commit(mut: (doc: NexusDoc) => void): void {
  const store = storeGet()
  if (!store.doc) throw new Error('commit() before boot')
  if (store.status === 'readOnly' || store.status === 'corrupt' || store.status === 'blocked') {
    // Refuse, loudly, but don't lose the queue: mutations are simply not applied.
    throw new Error(`Workspace is ${store.status} — writes are disabled`)
  }
  const doc = structuredClone(store.doc)
  mut(doc)
  doc.updatedAt = hlcNow()
  store.setDoc(doc)
  void saveDraft(doc)
  store.setPending(scratch.size)
  scheduleSave()
}

function scheduleSave(): void {
  const debounceMs = storeGet().doc?.settings.sync.debounceMs ?? 2500
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void performSave('debounce'), debounceMs)
}

/** Skip the debounce window and save now (used by "Retry now" and hooks). */
export async function flush(): Promise<boolean> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  return performSave('flush')
}

// ---------------------------------------------------------------------------
// performSave() — verify-token-then-write with rebase/retry
// ---------------------------------------------------------------------------

async function performSave(trigger: string): Promise<boolean> {
  if (scratch.size === 0) return true // nothing pending — the free no-op guard
  const current = mutex
  let release: (v: unknown) => void = () => {}
  mutex = new Promise((r) => (release = r))
  await current.catch(() => {})
  try {
    return await saveLoop()
  } finally {
    release(undefined)
    void trigger
  }
}

async function saveLoop(): Promise<boolean> {
  const store = storeGet()
  const nexusId = store.doc?.ids.nexusFileId ?? ''
  if (!nexusId) return false
  const cred = { mode: 'bearer' as const }

  if (tokenUnavailable()) {
    store.setStatus('reconnect', 'Sign in with Google to continue writing')
    return false
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const meta = await backoffRetry(() => getMeta(nexusId, cred), { retries: 2 })

      const unchanged =
        (store.base.headRevisionId !== undefined && meta.headRevisionId === store.base.headRevisionId) ||
        (store.base.version !== undefined && meta.version === store.base.version)

      // Ambiguous tokens (all undefined) = treat as changed — never write blind.
      const tokensKnown = meta.headRevisionId !== undefined || meta.version !== undefined

      if (tokensKnown && unchanged) {
        await writeWholeDoc(nexusId, cred)
        return true
      }

      // Remote moved (or tokens unknown) — rebase.
      const remoteRaw = await backoffRetry(() => readFile(nexusId, cred), { retries: 2 })
      const parsed = parseDoc(remoteRaw)
      if (!parsed.ok) {
        await quarantine(nexusId, remoteRaw, cred)
        store.setStatus('corrupt', 'The workspace file on Drive is not valid nexus.json — it was quarantined')
        return false
      }
      if (parsed.doc.schema > config.maxKnownSchema) {
        store.setDoc(parsed.doc) // show newer content, read-only
        store.setStatus('readOnly', `Written by a newer Nexus (schema ${parsed.doc.schema} > ${config.maxKnownSchema}) — update the app`)
        return false
      }
      const { merged } = mergeRemote({ local: storeGet().doc ?? emptyDoc(), remote: parsed.doc })
      applyMerged(merged)
      store.setBase({ headRevisionId: meta.headRevisionId, md5Checksum: meta.md5Checksum, version: meta.version })
      // loop → next pass should take the unchanged fast path unless raced again
    } catch (err) {
      if (err instanceof DriveError) {
        if (err.kind === 'auth') {
          store.setStatus('reconnect', 'Google session expired — click Reconnect to continue')
          return false
        }
        if (err.kind === 'notFound') {
          store.setStatus('blocked', 'Workspace file not found with your Google account — re-run setup or check sign-in')
          return false
        }
        // rateLimit/network already retried by backoffRetry; give up for now — edits stay queued
        store.setStatus('queued', 'Drive is busy or offline — changes are saved locally and will retry')
        return false
      }
      throw err
    }
  }

  store.setStatus(
    'queued',
    `Could not sync after ${MAX_ATTEMPTS} attempts — your changes are kept. [Retry] or export a backup from the banner.`,
  )
  return false
}

function tokenUnavailable(): boolean {
  return getBearerToken() === null
}

async function writeWholeDoc(nexusId: string, cred: { mode: 'bearer' }): Promise<void> {
  const store = storeGet()
  const current = store.doc ?? emptyDoc()
  // Bump rev + stamp the write itself so local rev always equals remote rev.
  const doc: NexusDoc = { ...current, rev: current.rev + 1, writerId: writerId(), updatedAt: hlcNow() }
  store.setDoc(doc)
  const body = serialize(doc)
  const resp = await backoffRetry(() => writeFileJson(nexusId, body, cred), { retries: 2 })
  // Our entities are now confirmed remote — drop them from the scratch set.
  scratch.clear()
  store.setPending(0)
  store.setBase({
    headRevisionId: resp.headRevisionId,
    md5Checksum: resp.md5Checksum,
    version: resp.version,
  })
  store.setStatus('ok', null)
  store.markSynced()
  await clearDraft()
  void snapshotHook(nexusId, cred)
}

export function serialize(doc: NexusDoc): string {
  return JSON.stringify(doc)
}

/** Fire-and-forget daily snapshot (max one per UTC day, rides the next save's meta). */
const snapshotMemo = new Set<string>()
async function snapshotHook(nexusId: string, cred: { mode: 'bearer' }): Promise<void> {
  const doc = storeGet().doc
  if (!doc || snapshotMemo.has(nexusId)) return
  const today = new Date().toISOString().slice(0, 10)
  if (doc.snapshots.some((s) => s.note.startsWith(today))) return
  snapshotMemo.add(nexusId)
  try {
    const snapshotsFolderId = await ensureSnapshotsFolder(doc.ids.rootFolderId, cred)
    const copy = await copyFile(nexusId, `nexus-${today}.json`, snapshotsFolderId, cred)
    commitQuiet((d) => {
      d.snapshots = [
        ...d.snapshots,
        { fileId: copy.id, rev: d.rev, at: new Date().toISOString(), by: writerId(), note: today },
      ].slice(-60)
    })
  } catch {
    snapshotMemo.delete(nexusId) // retried after the next successful write
  }
}

/** Update the doc without creating pending edits (cosmetic/derived state). */
export function commitQuiet(mut: (doc: NexusDoc) => void): void {
  const store = storeGet()
  if (!store.doc) return
  const doc = structuredClone(store.doc)
  mut(doc)
  doc.updatedAt = hlcNow()
  store.setDoc(doc)
  scheduleSave()
}

// ---------------------------------------------------------------------------
// Remote application (shared with the poller)
// ---------------------------------------------------------------------------

/** Merge a freshly-read remote doc into local state. Returns false on corrupt/newer-schema. */
export async function applyRemoteIfChanged(
  nexusId: string,
  cred: { mode: 'bearer' | 'key' | 'auto' },
): Promise<'unchanged' | 'applied' | 'corrupt' | 'newerSchema'> {
  const store = storeGet()
  let meta
  try {
    meta = await getMeta(nexusId, cred)
  } catch {
    return 'unchanged'
  }
  const changed =
    meta.headRevisionId !== store.base.headRevisionId ||
    meta.version !== store.base.version ||
    (meta.md5Checksum !== undefined && meta.md5Checksum !== store.base.md5Checksum && store.base.md5Checksum !== undefined)
  if (!changed && store.base.headRevisionId !== undefined) return 'unchanged'

  let raw: string
  try {
    raw = await readFile(nexusId, cred)
  } catch (e) {
    if (e instanceof DriveError && e.kind === 'downloadRestricted') {
      store.setStatus('queued', 'Drive "Viewers can\'t download" is ON — an admin must turn it off for viewers to read content')
    }
    return 'unchanged'
  }
  const parsed = parseDoc(raw)
  if (!parsed.ok) {
    if (cred.mode !== 'key') await quarantine(nexusId, raw, { mode: 'bearer' })
    store.setStatus('corrupt', 'The workspace file on Drive is not valid nexus.json — it was quarantined')
    return 'corrupt'
  }
  if (parsed.doc.schema > config.maxKnownSchema) {
    store.setDoc(parsed.doc)
    store.setStatus('readOnly', `Written by a newer Nexus (schema ${parsed.doc.schema}) — update the app`)
    store.setBase({ headRevisionId: meta.headRevisionId, md5Checksum: meta.md5Checksum, version: meta.version })
    return 'newerSchema'
  }
  const { merged } = mergeRemote({ local: storeGet().doc ?? emptyDoc(), remote: parsed.doc })
  applyMerged(merged)
  store.setBase({ headRevisionId: meta.headRevisionId, md5Checksum: meta.md5Checksum, version: meta.version })
  store.markSynced()
  if (storeGet().status !== 'ok' && storeGet().status !== 'saving') store.setStatus('ok', null)
  return 'applied'
}

async function quarantine(nexusId: string, raw: string, cred: { mode: 'bearer' }): Promise<void> {
  try {
    const doc = storeGet().doc
    const rootId = doc?.ids.rootFolderId ?? ''
    if (!rootId) return
    const snapshotsFolderId = await ensureSnapshotsFolder(rootId, cred)
    await createCorruptCopy(snapshotsFolderId, raw, cred)
  } catch {
    void nexusId // quarantine is best-effort; the raw bytes are also mirrored to IndexedDB
  }
}

async function createCorruptCopy(folderId: string, raw: string, cred: { mode: 'bearer' }): Promise<void> {
  const { createJsonFile } = await import('../drive/client')
  await createJsonFile(`corrupt-${Date.now()}.json`, folderId, raw, cred)
}

// ---------------------------------------------------------------------------
// Boot recovery + pagehide flush
// ---------------------------------------------------------------------------

export async function checkDraftRecovery(): Promise<{ savedAt: string } | null> {
  // A draft existing at boot means a debounced write never confirmed
  // (clearDraft runs only after a successful write).
  const draft = await loadDraft()
  if (!draft) return null
  return { savedAt: draft.savedAt }
}

/** Re-commit a recovered draft (user chose "Review & re-commit"). */
export async function recommitDraft(draftDoc: NexusDoc): Promise<void> {
  const store = storeGet()
  if (!store.doc) return
  const { merged } = mergeRemote({ local: draftDoc, remote: store.doc })
  merged.writerId = writerId()
  merged.updatedAt = hlcNow()
  // Everything in the draft counts as pending — the user explicitly re-asserted it.
  for (const map of ['projects', 'items', 'scripts'] as const) {
    for (const [id, entity] of Object.entries(draftDoc[map])) {
      if (!entity.deleted) scratch.set(id, { map, entity: structuredClone(entity) })
    }
  }
  applyMerged(merged)
  store.setPending(scratch.size)
  await clearDraft()
  await flush()
}

export async function discardDraft(): Promise<void> {
  await clearDraft()
}

let pagehideInstalled = false
export function installPagehideFlush(): void {
  if (pagehideInstalled) return
  pagehideInstalled = true
  window.addEventListener('pagehide', () => {
    if (scratch.size === 0) return
    const doc = storeGet().doc
    if (!doc) return
    const nexusId = doc.ids.nexusFileId
    if (getBearerToken() === null || !nexusId) return
    const bodyDoc: NexusDoc = { ...doc, rev: doc.rev + 1, writerId: writerId(), updatedAt: hlcNow() }
    const body = serialize(bodyDoc)
    if (body.length <= KEEPALIVE_MAX_BYTES) {
      try {
        void writeFileJson(nexusId, body, { mode: 'bearer' }, { keepalive: true })
      } catch {
        /* keepalive can still fail under connection pressure — IndexedDB has the draft */
      }
    }
  })
}
