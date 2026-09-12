// Every mutation in the app flows through commit() here. Mutators assert the
// role FIRST (fails before any write UI effect), mutate + touch() entities,
// append activity, and let the writer handle sync.

import {
  newItemId,
  newProjectId,
  newScriptId,
  newUserId,
  newViewerId,
} from '../util/id'
import { hlcNow } from '../util/hlc'
import { defaultStatus, type Item, type ItemKind, type NexusDoc, type Project, type Script, type ScriptStatus } from '../types/schema'
import { canWrite, canAdmin } from '../auth/session'
import { commit, touch, recordTombstone, appendActivity, flush, writerId } from '../sync/writer'
import { hashPassword, mintToken, passwordPolicyError } from '../auth/hashing'
import { DriveError, createFolder, uploadFile } from '../drive/client'
import { ensureSnapshotsFolder } from '../drive/bootstrap'
import { sessionRef } from '../sync/identity'

function assertWrite(): void {
  if (!canWrite()) throw new Error('Your login cannot modify content — sign in as an editor or admin')
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function createProject(name: string, labels: string[] = [], description = ''): Promise<string> {
  assertWrite()
  const id = newProjectId()
  commit((doc) => {
    const project: Project = {
      id,
      name,
      description,
      folderId: null,
      labels,
      createdAt: hlcNow(),
      updatedAt: hlcNow(),
      writerId: 'pending',
      deleted: null,
      archivedAt: null,
    }
    doc.projects[id] = project
    touch('projects', doc.projects[id])
    appendActivity(doc, 'project.create', id, { name })
  })
  // Drive folder creation is async + metadata lands on the next save.
  void ensureProjectFolder(id)
  return id
}

async function ensureProjectFolder(projectId: string): Promise<void> {
  const { storeGet } = await import('../sync/store')
  const doc = storeGet().doc
  const project = doc?.projects[projectId]
  const rootId = doc?.ids.rootFolderId
  if (!project || !rootId || project.folderId) return
  try {
    const folder = await createFolder(project.name, rootId, { mode: 'bearer' })
    commit((d) => {
      const p = d.projects[projectId]
      if (p && !p.folderId) {
        p.folderId = folder.id
        touch('projects', p)
      }
    })
  } catch (e) {
    if (e instanceof DriveError && e.kind === 'auth') return // Reconnect chip handles it; retried on next rename/edit
    return
  }
}

export function renameProject(projectId: string, name: string): void {
  assertWrite()
  commit((doc) => {
    const p = doc.projects[projectId]
    if (!p) return
    p.name = name
    touch('projects', p)
    appendActivity(doc, 'project.rename', projectId, { name })
  })
}

export function deleteProject(projectId: string): void {
  assertWrite()
  commit((doc) => {
    const p = doc.projects[projectId]
    if (!p) return
    p.deleted = { at: hlcNow(), by: writerId() }
    touch('projects', p)
    recordTombstone(doc, 'project', projectId, writerId())
    appendActivity(doc, 'project.delete', projectId, { name: p.name })
  })
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export function createItem(fields: {
  title: string
  projectId: string | null
  kind?: ItemKind
  labels?: string[]
  assigneeAppId?: string | null
  dueAt?: string | null
  notes?: string
  fileIds?: string[]
}): string {
  assertWrite()
  const id = newItemId()
  commit((doc) => {
    const item: Item = {
      id,
      projectId: fields.projectId,
      title: fields.title,
      kind: fields.kind ?? 'video',
      status: defaultStatus(doc),
      labels: fields.labels ?? [],
      fileIds: fields.fileIds ?? [],
      assigneeAppId: fields.assigneeAppId ?? null,
      dueAt: fields.dueAt ?? null,
      notes: fields.notes ?? '',
      createdAt: hlcNow(),
      updatedAt: hlcNow(),
      writerId: 'pending',
      deleted: null,
      archivedAt: null,
    }
    doc.items[id] = item
    touch('items', doc.items[id])
    appendActivity(doc, 'item.create', id, { title: fields.title, projectId: fields.projectId })
  })
  return id
}

export function setItemStatus(itemId: string, status: string): void {
  assertWrite()
  commit((doc) => {
    const item = doc.items[itemId]
    if (!item) return
    const from = item.status
    item.status = status
    touch('items', item)
    appendActivity(doc, 'item.status', itemId, { from, to: status })
  })
}

export function updateItem(itemId: string, fields: Partial<Pick<Item, 'title' | 'projectId' | 'kind' | 'labels' | 'assigneeAppId' | 'dueAt' | 'notes'>>): void {
  assertWrite()
  commit((doc) => {
    const item = doc.items[itemId]
    if (!item) return
    Object.assign(item, fields)
    touch('items', item)
    // Notes are content, not workflow events — don't log them (typing used to
    // flood the feed with one entry per keystroke).
    const meaningful = Object.keys(fields).filter((k) => k !== 'notes')
    if (meaningful.length > 0) appendActivity(doc, 'item.update', itemId, { fields: meaningful })
  })
}

export function attachFiles(itemId: string, fileIds: string[]): void {
  assertWrite()
  commit((doc) => {
    const item = doc.items[itemId]
    if (!item) return
    item.fileIds = [...new Set([...item.fileIds, ...fileIds])]
    touch('items', item)
    appendActivity(doc, 'item.attach', itemId, { fileIds })
  })
}

export function deleteItem(itemId: string): void {
  assertWrite()
  commit((doc) => {
    const item = doc.items[itemId]
    if (!item) return
    item.deleted = { at: hlcNow(), by: writerId() }
    touch('items', item)
    recordTombstone(doc, 'item', itemId, writerId())
    appendActivity(doc, 'item.delete', itemId, { title: item.title })
  })
}

/** Upload a file into the item's project folder, then link it. */
export async function uploadToItem(
  itemId: string,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<{ ok: true; fileId: string } | { ok: false; error: string }> {
  const { storeGet } = await import('../sync/store')
  const doc = storeGet().doc
  const item = doc?.items[itemId]
  if (!doc || !item) return { ok: false, error: 'Item not found' }
  const folderId =
    item.projectId != null ? doc.projects[item.projectId]?.folderId ?? null : doc.ids.rootFolderId
  if (!folderId) return { ok: false, error: 'Project folder not ready yet — try again in a few seconds' }
  try {
    const meta = await uploadFile(folderId, file, { mode: 'bearer' }, onProgress)
    attachFiles(itemId, [meta.id])
    return { ok: true, fileId: meta.id }
  } catch (e) {
    if (e instanceof DriveError && e.kind === 'auth') return { ok: false, error: 'Sign in with Google to upload' }
    if (e instanceof DriveError) return { ok: false, error: `${e.message} — ${e.kind}` }
    return { ok: false, error: e instanceof Error ? e.message : 'Upload failed' }
  }
}

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

export function createScript(fields: {
  title: string
  projectId?: string | null
  itemId?: string | null
  body?: string
}): string {
  assertWrite()
  const id = newScriptId()
  commit((doc) => {
    const script: Script = {
      id,
      title: fields.title,
      storage: { type: 'inline', body: fields.body ?? '' },
      projectId: fields.projectId ?? null,
      itemId: fields.itemId ?? null,
      status: 'draft',
      copies: [],
      createdAt: hlcNow(),
      updatedAt: hlcNow(),
      writerId: 'pending',
      deleted: null,
      archivedAt: null,
    }
    doc.scripts[id] = script
    touch('scripts', doc.scripts[id])
    appendActivity(doc, 'script.create', id, { title: fields.title })
  })
  return id
}

export function updateScript(id: string, fields: Partial<Pick<Script, 'title' | 'projectId' | 'itemId'>>): void {
  assertWrite()
  commit((doc) => {
    const s = doc.scripts[id]
    if (!s) return
    Object.assign(s, fields)
    touch('scripts', s)
  })
}

export function setScriptBody(id: string, body: string): void {
  assertWrite()
  commit((doc) => {
    const s = doc.scripts[id]
    if (!s) return
    s.storage = { type: 'inline', body }
    touch('scripts', s)
  })
}

export async function setScriptStatus(id: string, status: ScriptStatus): Promise<void> {
  assertWrite()
  commit((doc) => {
    const s = doc.scripts[id]
    if (!s) return
    s.status = status
    touch('scripts', s)
    appendActivity(doc, 'script.status', id, { to: status })
  })
  // Milestone copies at review/final give restore points finer than daily snapshots.
  if (status === 'review' || status === 'final') {
    await flush()
    const { storeGet } = await import('../sync/store')
    const doc = storeGet().doc
    const script = doc?.scripts[id]
    if (!doc || !script) return
    if (script.storage.type !== 'inline') return
    try {
      const snapshotsFolderId = await ensureSnapshotsFolder(doc.ids.rootFolderId, { mode: 'bearer' })
      const { createTextFile } = await import('../drive/client')
      const copy = await createTextFile(
        `${id}-${status}.md`,
        snapshotsFolderId,
        script.storage.body,
        'text/markdown',
        { mode: 'bearer' },
      )
      commit((d) => {
        const s = d.scripts[id]
        if (!s) return
        s.copies = [...s.copies, { fileId: copy.id, label: status, at: hlcNow() }].slice(-5)
        touch('scripts', s)
      })
    } catch {
      /* milestone copies are best-effort */
    }
  }
}

export function deleteScript(id: string): void {
  assertWrite()
  commit((doc) => {
    const s = doc.scripts[id]
    if (!s) return
    s.deleted = { at: hlcNow(), by: writerId() }
    touch('scripts', s)
    recordTombstone(doc, 'script', id, writerId())
    appendActivity(doc, 'script.delete', id, { title: s.title })
  })
}

// ---------------------------------------------------------------------------
// Admin: app users, viewer tokens, settings
// ---------------------------------------------------------------------------

export function assertAdmin(): void {
  if (!canAdmin()) throw new Error('Admin login required')
}

export async function createAppUser(
  name: string,
  role: 'admin' | 'editor' | 'viewer',
  secret?: string,
): Promise<{ raw: string }> {
  assertAdmin()
  let auth: NexusDoc['users']['app'][number]['auth']
  let raw: string
  if (secret === undefined) {
    const minted = await mintToken()
    auth = { kind: 'token', hash: minted.hash }
    raw = minted.raw
  } else {
    const policyError = passwordPolicyError(secret)
    if (policyError) throw new Error(policyError)
    const hashed = await hashPassword(secret)
    auth =
      hashed.kind === 'pbkdf2'
        ? { kind: 'pbkdf2', hash: hashed.hash, salt: hashed.salt, iterations: hashed.iterations }
        : { kind: 'argon2id', hash: hashed.hash }
    raw = secret
  }
  const id = newUserId()
  commit((doc) => {
    doc.users.app = [
      ...doc.users.app,
      {
        id,
        name,
        role,
        disabled: false,
        auth,
        createdAt: hlcNow(),
        createdBy: 'pending',
        updatedAt: hlcNow(),
        writerId: writerId(),
      },
    ]
    appendActivity(doc, 'user.create', id, { name, role })
  })
  return { raw }
}

export function setUserDisabled(userId: string, disabled: boolean): void {
  assertAdmin()
  const { getSession } = sessionModule()
  const me = getSession()
  if (disabled && me?.appUserId === userId) {
    throw new Error('You cannot disable your own account — ask another admin')
  }
  commit((doc) => {
    const user = doc.users.app.find((u) => u.id === userId)
    if (!user) return
    if (disabled && user.role === 'admin') {
      const activeAdmins = doc.users.app.filter((u) => u.role === 'admin' && !u.disabled && u.id !== userId)
      if (activeAdmins.length === 0) {
        throw new Error('Cannot disable the last active admin')
      }
    }
    user.disabled = disabled
    user.updatedAt = hlcNow()
    user.writerId = writerId()
    appendActivity(doc, disabled ? 'user.disable' : 'user.enable', userId, { name: user.name })
  })
}

// Late-bound to avoid a circular import at module init.
function sessionModule(): { getSession: () => { appUserId: string } | null } {
  return { getSession: () => sessionRef.getSession?.() ?? null }
}

export async function resetUserPassword(userId: string, secret: string | undefined): Promise<{ raw: string }> {
  assertAdmin()
  let auth: NexusDoc['users']['app'][number]['auth']
  let raw: string
  if (secret === undefined) {
    const minted = await mintToken()
    auth = { kind: 'token', hash: minted.hash }
    raw = minted.raw
  } else {
    const policyError = passwordPolicyError(secret)
    if (policyError) throw new Error(policyError)
    const hashed = await hashPassword(secret)
    auth =
      hashed.kind === 'pbkdf2'
        ? { kind: 'pbkdf2', hash: hashed.hash, salt: hashed.salt, iterations: hashed.iterations }
        : { kind: 'argon2id', hash: hashed.hash }
    raw = secret
  }
  commit((doc) => {
    const user = doc.users.app.find((u) => u.id === userId)
    if (!user) return
    user.auth = auth
    // Kick every active session for this user — they re-sign-in with the new secret.
    user.sessionEpoch = (user.sessionEpoch ?? 0) + 1
    user.updatedAt = hlcNow()
    user.writerId = writerId()
    appendActivity(doc, 'user.reset', userId, { name: user.name })
  })
  return { raw }
}

export async function mintViewerToken(name: string, note = ''): Promise<{ raw: string; id: string }> {
  assertAdmin()
  const { raw, hash } = await mintToken()
  const id = newViewerId()
  commit((doc) => {
    doc.users.viewers = [
      ...doc.users.viewers,
      {
        id, name, tokenHash: hash, createdAt: hlcNow(), createdBy: 'pending',
        revokedAt: null, note, updatedAt: hlcNow(), writerId: writerId(),
      },
    ]
    appendActivity(doc, 'viewer.create', id, { name })
  })
  return { raw, id }
}

export function revokeViewer(viewerId: string): void {
  assertAdmin()
  commit((doc) => {
    const v = doc.users.viewers.find((x) => x.id === viewerId)
    if (!v || v.revokedAt) return
    v.revokedAt = hlcNow()
    v.updatedAt = hlcNow()
    v.writerId = writerId()
    appendActivity(doc, 'viewer.revoke', viewerId, { name: v.name })
  })
}

export function updateSettings(mut: (s: NexusDoc['settings']) => void): void {
  assertAdmin()
  commit((doc) => {
    mut(doc.settings)
    doc.settings.updatedAt = hlcNow()
    doc.settings.writerId = writerId()
    appendActivity(doc, 'settings.update', 'settings', {})
  })
}

export function setApiKeyOverride(key: string | null): void {
  assertAdmin()
  commit((doc) => {
    doc.settings.api.keyOverride = key
    doc.settings.updatedAt = hlcNow()
    doc.settings.writerId = writerId()
    appendActivity(doc, 'settings.apiKey', 'settings', { set: key !== null })
  })
}
