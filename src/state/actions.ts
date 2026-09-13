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
import { DriveError, createFolder, uploadFile, renameFile } from '../drive/client'
import { ensureProjectsFolder, ensureScriptsFolder, ensureUnsortedFolder } from '../drive/bootstrap'
import { sessionRef } from '../sync/identity'

function assertWrite(): void {
  if (!canWrite()) throw new Error('Your login cannot modify content — sign in as an editor or admin')
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function createProject(
  name: string,
  opts: { description?: string; labels?: string[] } = {},
): Promise<string> {
  assertWrite()
  const id = newProjectId()
  const description = opts.description ?? ''
  const labels = opts.labels ?? []
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
  // (Silently swallowed here — the App-level retry re-runs it on Google connect.)
  void ensureProjectFolder(id).catch(() => {})
  return id
}

/** Create the project's Drive folder if missing — inside the workspace's
 *  projects/ system folder. Returns its id, or null when it can't be created
 *  right now (caller decides whether that's fatal). */
export async function ensureProjectFolder(projectId: string): Promise<string | null> {
  const { storeGet } = await import('../sync/store')
  const doc = storeGet().doc
  const project = doc?.projects[projectId]
  if (!doc || !project) return null
  if (project.folderId) return project.folderId
  const projectsParentId = await ensureProjectsFolder(doc, { mode: 'bearer' })
  const folder = await createFolder(project.name, projectsParentId, { mode: 'bearer' })
  commit((d) => {
    const p = d.projects[projectId]
    if (p && !p.folderId) {
      p.folderId = folder.id
      touch('projects', p)
    }
  })
  return folder.id
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
  // Keep the Drive folder name in sync (best-effort; metadata already renamed).
  void (async () => {
    const { storeGet } = await import('../sync/store')
    const folderId = storeGet().doc?.projects[projectId]?.folderId
    if (folderId) {
      await renameFile(folderId, name, { mode: 'bearer' }).catch(() => {})
    }
  })()
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
  let movedToProject: string | null = null
  commit((doc) => {
    const item = doc.items[itemId]
    if (!item) return
    if (fields.projectId !== undefined && fields.projectId !== item.projectId && item.fileIds.length > 0) {
      movedToProject = fields.projectId // files slide into the project folder
    }
    Object.assign(item, fields)
    touch('items', item)
    // Notes are content, not workflow events — don't log them (typing used to
    // flood the feed with one entry per keystroke).
    const meaningful = Object.keys(fields).filter((k) => k !== 'notes')
    if (meaningful.length > 0) appendActivity(doc, 'item.update', itemId, { fields: meaningful })
  })
  if (movedToProject) void moveItemFilesToProject(itemId, movedToProject)
}

/** Best-effort: move an item's Drive files into its project folder. */
async function moveItemFilesToProject(itemId: string, projectId: string): Promise<void> {
  const { storeGet } = await import('../sync/store')
  const doc = storeGet().doc
  const item = doc?.items[itemId]
  if (!doc || !item || item.fileIds.length === 0) return
  const target = await ensureProjectFolder(projectId)
  if (!target) return
  const { moveFile } = await import('../drive/client')
  for (const fileId of item.fileIds) {
    await moveFile(fileId, target, null, { mode: 'bearer' }).catch(() => {})
  }
}

/**
 * Delete a project AND its Drive content. Destructive-but-recoverable:
 * the folder and every file move to Drive trash (30-day recovery), and the
 * metadata is tombstoned. The UI must show the caller the list first.
 */
export async function deleteProjectCascade(
  projectId: string,
): Promise<{ files: number; folder: string | null }> {
  assertWrite()
  const { storeGet } = await import('../sync/store')
  const doc = storeGet().doc
  const project = doc?.projects[projectId]
  if (!doc || !project) throw new Error('Project not found')
  const items = Object.values(doc.items).filter(
    (i) => i.projectId === projectId && i.deleted === null,
  )
  const fileIds = [...new Set(items.flatMap((i) => i.fileIds))]

  // Drive-side first (each best-effort; a missed file stays findable via sweep).
  const { trashFile } = await import('../drive/client')
  for (const f of fileIds) await trashFile(f, { mode: 'bearer' }).catch(() => {})
  if (project.folderId) await trashFile(project.folderId, { mode: 'bearer' }).catch(() => {})

  commit((d) => {
    const p = d.projects[projectId]
    if (p) {
      p.deleted = { at: hlcNow(), by: writerId() }
      touch('projects', p)
      recordTombstone(d, 'project', projectId, writerId())
    }
    for (const item of items) {
      const live = d.items[item.id]
      if (!live || live.deleted) continue
      live.deleted = { at: hlcNow(), by: writerId() }
      touch('items', live)
      recordTombstone(d, 'item', item.id, writerId())
    }
    appendActivity(d, 'project.delete', projectId, {
      name: project.name,
      filesTrashed: fileIds.length,
      itemsTrashed: items.length,
    })
  })
  return { files: fileIds.length, folder: project.folderId }
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

/** Remove a file from an item — optionally trashing it on Drive (30-day
 *  recovery). Unlinking alone leaves the file where it is on Drive. */
export async function removeItemFile(
  itemId: string,
  fileId: string,
  opts: { trashInDrive?: boolean } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  assertWrite()
  if (opts.trashInDrive) {
    const { trashFile } = await import('../drive/client')
    try {
      await trashFile(fileId, { mode: 'bearer' })
    } catch (e) {
      if (e instanceof DriveError && e.kind === 'notFound') {
        // Already gone from Drive — still unlink it below.
      } else if (e instanceof DriveError) {
        return { ok: false, error: `${e.message} — ${e.kind}` }
      } else {
        return { ok: false, error: e instanceof Error ? e.message : 'Drive delete failed' }
      }
    }
  }
  commit((doc) => {
    const it = doc.items[itemId]
    if (!it) return
    it.fileIds = it.fileIds.filter((f) => f !== fileId)
    touch('items', it)
    appendActivity(doc, opts.trashInDrive ? 'item.file.delete' : 'item.detach', itemId, { fileId })
  })
  return { ok: true }
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

/** Upload a file into the item's project folder (creating it if missing);
 *  project-less items go to Unsorted/. Then link it. */
export async function uploadToItem(
  itemId: string,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<{ ok: true; fileId: string } | { ok: false; error: string }> {
  const { storeGet } = await import('../sync/store')
  const doc = storeGet().doc
  const item = doc?.items[itemId]
  if (!doc || !item) return { ok: false, error: 'Item not found' }
  try {
    let folderId: string | null
    if (item.projectId != null) {
      // Never upload flat: make sure the project's Drive folder exists first.
      folderId = await ensureProjectFolder(item.projectId)
      if (!folderId) return { ok: false, error: 'Project not found — re-open this item and try again' }
    } else {
      folderId = await ensureUnsortedFolder(doc, { mode: 'bearer' })
    }
    if (!folderId) return { ok: false, error: 'Workspace folder not set — finish setup first' }
    const meta = await uploadFile(folderId, file, { mode: 'bearer' }, onProgress)
    attachFiles(itemId, [meta.id])
    return { ok: true, fileId: meta.id }
  } catch (e) {
    if (e instanceof DriveError && e.kind === 'auth') return { ok: false, error: 'Sign in with Google to upload (top bar → Connect Google)' }
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
      storage: { type: 'md', fileId: '' }, // .md file created lazily on first edit
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

/**
 * Save a script's body to its markdown file in scripts/ (creating the file on
 * first edit). Metadata stays in nexus.json; the text lives on Drive where it
 * gets its own revision history and never bloats the master file.
 */
export async function saveScriptBody(id: string, body: string): Promise<{ ok: true } | { ok: false; error: string }> {
  assertWrite()
  const { storeGet } = await import('../sync/store')
  const doc = storeGet().doc
  const script = doc?.scripts[id]
  if (!doc || !script) return { ok: false, error: 'Script not found' }
  try {
    const scriptsFolderId = await ensureScriptsFolder(doc, { mode: 'bearer' })
    const { createTextFile, writeFileText } = await import('../drive/client')
    if (script.storage.type === 'md' && script.storage.fileId) {
      await writeFileText(script.storage.fileId, body, { mode: 'bearer' })
    } else {
      const created = await createTextFile(`${id}.md`, scriptsFolderId, body, 'text/markdown', { mode: 'bearer' })
      commit((d) => {
        const s = d.scripts[id]
        if (!s) return
        s.storage = { type: 'md', fileId: created.id }
        touch('scripts', s)
      })
    }
    return { ok: true }
  } catch (e) {
    if (e instanceof DriveError && e.kind === 'auth')
      return { ok: false, error: 'Sign in with Google to save scripts (top bar → Connect Google)' }
    if (e instanceof DriveError) return { ok: false, error: `${e.message} — ${e.kind}` }
    return { ok: false, error: e instanceof Error ? e.message : 'Save failed' }
  }
}

/** Read a script's body from its markdown file (null when not yet on file). */
export async function readScriptBody(id: string): Promise<string | null> {
  const { storeGet } = await import('../sync/store')
  const doc = storeGet().doc
  const script = doc?.scripts[id]
  if (!doc || !script) return null
  if (script.storage.type === 'inline') return script.storage.body
  if (script.storage.type !== 'md' || !script.storage.fileId) return ''
  const { readFile } = await import('../drive/client')
  try {
    return await readFile(script.storage.fileId, { mode: 'auto' })
  } catch {
    return null
  }
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
    if (script.storage.type !== 'md') return
    try {
      const scriptsFolderId = await ensureScriptsFolder(doc, { mode: 'bearer' })
      const { createTextFile } = await import('../drive/client')
      const body = await readScriptBody(id)
      if (body === null) return
      const copy = await createTextFile(`${id}-${status}.md`, scriptsFolderId, body, 'text/markdown', {
        mode: 'bearer',
      })
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
