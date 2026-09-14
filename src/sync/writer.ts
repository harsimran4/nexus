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
import { getBearerToken, clearToken, isTokenValid } from '../auth/tokenClient'
import { relayConfigured, getRelayTicket, clearRelayTicket, relayWriteDoc } from '../auth/relay'
import { canWrite } from '../auth/session'
import { writerId, sessionActor } from './identity'

const MAX_ATTEMPTS = 5

type EntityMapName = 'groups' | 'projects' | 'scripts'
export { writerId }

/** Stamp an entity after mutating it — call INSIDE your commit mutator. */
export function touch(map: EntityMapName, entity: { updatedAt: string; writerId: string } & Record<string, unknown>): void {
  entity.updatedAt = hlcNow()
  entity.writerId = writerId()
  scratch.set(entity.id as string, { map, entity: structuredClone(entity) })
}

/** Append a deletion marker + tombstone (deletes never remove keys). */
export function recordTombstone(doc: NexusDoc, type: 'group' | 'project' | 'script', id: string, by: string): void {
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
    const target = doc[map] as Record<string, unknown>
    target[String(fresh.id)] = fresh
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
  const nexusId = storeGet().doc?.ids.nexusFileId ?? ''
  if (!nexusId) return false
  const cred = { mode: 'bearer' as const }

  // Write-path choice: the direct Google bearer when the tab has one (admins,
  // picker-connected editors); the write relay when there's a Nexus ticket and
  // no Google (relay-configured deploys — editors never touch Google). No
  // Google AND no ticket → reconnect.
  const viaRelay = tokenUnavailable() && relayConfigured() && getRelayTicket() !== null
  if (tokenUnavailable() && !viaRelay) {
    storeGet().setStatus(
      'reconnect',
      relayConfigured()
        ? 'Sign in again to continue writing — your write session is missing or expired'
        : 'Sign in with Google to continue writing',
    )
    return false
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (viaRelay) {
      const store = storeGet()
      const res = await relayWriteDoc(store.doc!, store.base.version)
      if (res.ok) {
        scratch.clear()
        store.setPending(0)
        store.setBase({ version: res.version, md5Checksum: res.md5Checksum })
        store.setStatus('ok', null)
        store.markSynced()
        await clearDraft()
        if (isTokenValid()) void snapshotHook(nexusId, cred)
        return true
      }
      if (res.kind === 'auth') {
        clearRelayTicket()
        storeGet().setStatus('reconnect', 'Your write session expired — sign in again to continue writing')
        return false
      }
      if (res.kind === 'conflict') {
        // Same rebase contract as the direct path: merge remote, loop, and the
        // next pass should write clean against the version the server named.
        const parsed = parseDoc(res.remote)
        if (!parsed.ok) {
          storeGet().setStatus('corrupt', 'The workspace file on Drive is not valid nexus.json — it was quarantined')
          return false
        }
        if (parsed.doc.schema > config.maxKnownSchema) {
          store.setDoc(parsed.doc) // show newer content, read-only
          store.setStatus('readOnly', `Written by a newer Nexus (schema ${parsed.doc.schema} > ${config.maxKnownSchema}) — update the app`)
          return false
        }
        const { merged } = mergeRemote({ local: storeGet().doc ?? emptyDoc(), remote: parsed.doc })
        applyMerged(merged)
        continue
      }
      storeGet().setStatus('queued', `Relay write failed (${res.message}) — changes are saved locally and will retry`)
      return false
    }
    try {
      // Fresh state EVERY iteration: after a rebase the doc/base have changed
      // and a stale snapshot would re-merge forever or write pre-merge state.
      const store = storeGet()
      const base = store.base
      const meta = await backoffRetry(() => getMeta(nexusId, cred), { retries: 2 })

      const unchanged =
        (base.headRevisionId !== undefined && meta.headRevisionId === base.headRevisionId) ||
        (base.version !== undefined && meta.version === base.version)

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
          clearToken() // drop the dead token — un-hides "Connect Google" immediately
          storeGet().setStatus('reconnect', 'Google session expired — click Reconnect to continue')
          return false
        }
        if (err.kind === 'notFound') {
          // drive.file scope: the signed-in Google account can't see this
          // workspace's file. Classic editor case — their own account, folder
          // not connected yet. Offer the picker connect instead of dead-ending.
          storeGet().setNeedConnect(true)
          storeGet().setStatus(
            'blocked',
            "Google can't see the workspace from the signed-in account — connect the Nexus Root folder shared with you",
          )
          return false
        }
        if (err.kind === 'permission') {
          // Bearer write refused: the folder is likely shared view-only with
          // this account (or Drive-side sharing is restricted).
          storeGet().setStatus(
            'blocked',
            'Drive refused the write — the Nexus Root folder may be shared with your Google account view-only. Ask the studio to share it as Editor.',
          )
          return false
        }
        // rateLimit/network already retried by backoffRetry; give up for now — edits stay queued
        storeGet().setStatus('queued', 'Drive is busy or offline — changes are saved locally and will retry')
        return false
      }
      throw err
    }
  }

  storeGet().setStatus(
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
    const snapshotsFolderId = await ensureSnapshotsFolder(doc, cred)
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
  // Only show "Synced" when nothing is actually pending — a successful read
  // must never mask unsynced local edits (they'd look lost until the next
  // failed write).
  if (scratch.size === 0) {
    if (storeGet().status !== 'ok' && storeGet().status !== 'saving') storeGet().setStatus('ok', null)
  } else if (storeGet().status === 'queued' || storeGet().status === 'reconnect') {
    if (getBearerToken() !== null) void flush() // reads work again — retry the pending writes now
  }
  return 'applied'
}

async function quarantine(nexusId: string, raw: string, cred: { mode: 'bearer' }): Promise<void> {
  try {
    const doc = storeGet().doc
    const rootId = doc?.ids.rootFolderId ?? ''
    if (!rootId) return
    const snapshotsFolderId = doc ? await ensureSnapshotsFolder(doc, cred) : null
    if (!snapshotsFolderId) return
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
  if (!canWrite()) throw new Error('Sign in with your Nexus login to re-commit changes')
  if (store.status === 'readOnly' || store.status === 'corrupt' || store.status === 'blocked') {
    throw new Error(`Workspace is ${store.status} — writes are disabled`)
  }
  // NO blanket re-assertion: the draft's entities carry their true edit-time
  // stamps, so the LWW merge keeps genuine lost edits AND lets concurrent
  // remote edits (newer stamps) win. Re-stamping everything would clobber peers.
  const { merged } = mergeRemote({ local: draftDoc, remote: store.doc })
  merged.writerId = writerId()
  merged.updatedAt = hlcNow()
  useStore.getState().setDoc(merged)
  store.setPending(0)
  const ok = await flush()
  if (ok) await clearDraft() // a failed flush keeps the draft for another try
}

export async function discardDraft(): Promise<void> {
  await clearDraft()
}

/** Signing out: drop this session's unsynced edits so they can't be written
 *  under the next login. The IndexedDB draft still has them for recovery. */
export function discardPendingForLogout(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  scratch.clear()
  storeGet().setPending(0)
}

let pagehideInstalled = false
/**
 * REMOVED by review: the keepalive PATCH was a blind whole-file write — a tab
 * closing while a peer committed would silently roll that peer's write back
 * (Drive v3 never rejects a PATCH). The IndexedDB draft covers tab-close
 * recovery safely: nothing writes blind to the shared file.
 */
export function installPagehideFlush(): void {
  if (pagehideInstalled) return
  pagehideInstalled = true
  window.addEventListener('pagehide', () => {
    if (scratch.size === 0) return
    const doc = storeGet().doc
    if (doc) void saveDraft(doc) // best-effort: the draft is the recovery path now
  })
}
