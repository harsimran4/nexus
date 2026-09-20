// Every mutation flows through commit() here. Mutators assert the role FIRST
// (fails before any write UI is offered), mutate + touch() entities, append
// activity, and let the writer handle sync.

import {
  newProjectId,
  newGroupId,
  newScriptId,
  newUserId,
  newViewerId,
} from '../util/id'
import { hlcNow } from '../util/hlc'
import {
  defaultStatus,
  statusBucket,
  type NexusDoc,
  type Project,
  type Group,
  type Script,
  type ScriptStatus,
} from '../types/schema'
import { canWrite, canAdmin } from '../auth/session'
import { commit, touch, recordTombstone, appendActivity, flush, writerId } from '../sync/writer'
import { mintToken, passwordPolicyError, stretchedAuth } from '../auth/hashing'
import { storeGet } from '../sync/store'
import { decodeHlc } from '../util/hlc'
import { DriveError, createFolder, uploadFile, renameFile } from '../drive/client'
import { ensureGroupsFolder, ensureScriptsFolder } from '../drive/bootstrap'
import { sessionRef } from '../sync/identity'

function assertWrite(): void {
  if (!canWrite()) throw new Error('Your login cannot modify content — sign in as an editor or admin')
}

// Late-bound to avoid a circular import at module init.
function sessionModule(): { getSession: () => { appUserId: string } | null } {
  return { getSession: () => sessionRef.getSession?.() ?? null }
}

// ---------------------------------------------------------------------------
// Groups (containers: "Personal", "Client Work" — one Drive folder each)
// ---------------------------------------------------------------------------

export async function createGroup(name: string, description = ''): Promise<string> {
  assertWrite()
  const id = newGroupId()
  commit((doc) => {
    const group: Group = {
      id,
      name,
      description,
      folderId: null,
      createdAt: hlcNow(),
      updatedAt: hlcNow(),
      writerId: 'pending',
      deleted: null,
      archivedAt: null,
    }
    doc.groups[id] = group
    touch('groups', doc.groups[id])
    appendActivity(doc, 'group.create', id, { name })
  })
  void ensureGroupFolder(id).catch(() => {})
  return id
}

/** Create the group's Drive folder (Nexus/groups/<name>/) if missing. */
export async function ensureGroupFolder(groupId: string): Promise<string | null> {
  const { storeGet } = await import('../sync/store')
  const doc = storeGet().doc
  const group = doc?.groups[groupId]
  if (!doc || !group) return null
  if (group.folderId) return group.folderId
  const groupsParentId = await ensureGroupsFolder(doc, { mode: 'bearer' })
  const folder = await createFolder(group.name, groupsParentId, { mode: 'bearer' })
  commit((d) => {
    const g = d.groups[groupId]
    if (g && !g.folderId) {
      g.folderId = folder.id
      touch('groups', g)
      appendActivity(d, 'group.folder', groupId, { folderId: folder.id })
    }
  })
  return folder.id
}

export function renameGroup(groupId: string, name: string): void {
  assertWrite()
  commit((doc) => {
    const g = doc.groups[groupId]
    if (!g) return
    g.name = name
    touch('groups', g)
    appendActivity(doc, 'group.rename', groupId, { name })
  })
  void (async () => {
    const { storeGet } = await import('../sync/store')
    const folderId = storeGet().doc?.groups[groupId]?.folderId
    if (folderId) await renameFile(folderId, name, { mode: 'bearer' }).catch(() => {})
  })()
}

/**
 * Delete a group AND everything inside it: the group folder (with all project
 * subfolders and files) goes to Drive trash, and every project in the group is
 * tombstoned. The UI must show the list first.
 */
export async function deleteGroupCascade(groupId: string): Promise<{ projects: number; folderTrashed: boolean }> {
  assertWrite()
  const { storeGet } = await import('../sync/store')
  const doc = storeGet().doc
  const group = doc?.groups[groupId]
  if (!doc || !group) throw new Error('Group not found')
  const projectsInGroup = Object.values(doc.projects).filter(
    (p) => p.groupId === groupId && p.deleted === null,
  )
  const { trashFile } = await import('../drive/client')
  let folderTrashed = false
  if (group.folderId) {
    await trashFile(group.folderId, { mode: 'bearer' }).catch(() => {})
    folderTrashed = true
  }
  commit((d) => {
    const g = d.groups[groupId]
    if (g) {
      g.deleted = { at: hlcNow(), by: writerId() }
      touch('groups', g)
      recordTombstone(d, 'group', groupId, writerId())
    }
    for (const p of projectsInGroup) {
      const live = d.projects[p.id]
      if (!live || live.deleted) continue
      live.deleted = { at: hlcNow(), by: writerId() }
      touch('projects', live)
      recordTombstone(d, 'project', p.id, writerId())
    }
    appendActivity(d, 'group.delete', groupId, {
      name: group.name,
      projectsTrashed: projectsInGroup.length,
    })
  })
  return { projects: projectsInGroup.length, folderTrashed }
}

// ---------------------------------------------------------------------------
// Projects (the tracked content: one video, one clip — with status and files)
// ---------------------------------------------------------------------------

export async function createProject(fields: {
  groupId: string
  name: string
  description?: string
  labels?: string[]
  assigneeAppId?: string | null
  dueAt?: string | null
  notes?: string
}): Promise<string> {
  assertWrite()
  if (!fields.groupId) throw new Error('A group is required — pick which group this project belongs to')
  const id = newProjectId()
  commit((doc) => {
    const group = doc.groups[fields.groupId]
    if (!group || group.deleted) throw new Error('That group no longer exists — refresh and pick again')
    const project: Project = {
      id,
      groupId: fields.groupId,
      name: fields.name,
      folderId: null,
      status: defaultStatus(doc),
      labels: fields.labels ?? [],
      fileIds: [],
      assigneeAppId: fields.assigneeAppId ?? null,
      dueAt: fields.dueAt ?? null,
      notes: fields.notes ?? fields.description ?? '',
      createdAt: hlcNow(),
      updatedAt: hlcNow(),
      writerId: 'pending',
      deleted: null,
      archivedAt: null,
    }
    doc.projects[id] = project
    touch('projects', doc.projects[id])
    appendActivity(doc, 'project.create', id, { name: fields.name, groupId: fields.groupId })
  })
  void ensureProjectFolder(id).catch(() => {})
  return id
}

/** Project subfolder: Nexus/groups/<Group>/<Project name>/. Created on demand. */
export async function ensureProjectFolder(projectId: string): Promise<string | null> {
  const { storeGet } = await import('../sync/store')
  const doc = storeGet().doc
  const project = doc?.projects[projectId]
  if (!doc || !project) return null
  if (project.folderId) return project.folderId
  const groupFolderId = await ensureGroupFolder(project.groupId)
  if (!groupFolderId) return null
  const folder = await createFolder(project.name, groupFolderId, { mode: 'bearer' })
  commit((d) => {
    const p = d.projects[projectId]
    if (p && !p.folderId) {
      p.folderId = folder.id
      touch('projects', p)
    }
  })
  return folder.id
}

export function updateProject(
  projectId: string,
  fields: Partial<Pick<Project, 'name' | 'groupId' | 'labels' | 'assigneeAppId' | 'dueAt' | 'notes' | 'status'>>,
): void {
  assertWrite()
  let moveToGroup: string | null = null
  let oldGroupFolder: string | null = null
  commit((doc) => {
    const p = doc.projects[projectId]
    if (!p) return
    if (fields.groupId !== undefined && fields.groupId !== p.groupId) {
      const target = doc.groups[fields.groupId]
      if (!target || target.deleted) {
        throw new Error('Target group no longer exists — refresh and pick again')
      }
      moveToGroup = fields.groupId
      oldGroupFolder = doc.groups[p.groupId]?.folderId ?? null
    }
    Object.assign(p, fields)
    touch('projects', p)
    const meaningful = Object.keys(fields).filter((k) => k !== 'notes')
    if (meaningful.length > 0) appendActivity(doc, 'project.update', projectId, { fields: meaningful })
  })
  if (moveToGroup) void moveProjectToGroup(projectId, moveToGroup, oldGroupFolder)
}

/** Move a project (its Drive subfolder + all files) into another group. */
export async function moveProjectToGroup(
  projectId: string,
  toGroupId: string,
  fromFolderId: string | null,
): Promise<void> {
  const { storeGet } = await import('../sync/store')
  const doc = storeGet().doc
  const project = doc?.projects[projectId]
  if (!doc || !project || !project.folderId) return
  const to = await ensureGroupFolder(toGroupId)
  if (!to) return
  const { moveFile } = await import('../drive/client')
  try {
    await moveFile(project.folderId, to, fromFolderId, { mode: 'bearer' })
  } catch (e) {
    // Metadata already says the new group; the Drive folder didn't follow.
    // Record the divergence instead of swallowing it.
    commit((d) => {
      appendActivity(d, 'project.moveFailed', projectId, {
        to: toGroupId,
        reason: e instanceof Error ? e.message : 'Drive move failed',
      })
    })
  }
}

export function setProjectStatus(projectId: string, status: string): void {
  assertWrite()
  commit((doc) => {
    const p = doc.projects[projectId]
    if (!p) return
    const from = p.status
    p.status = status
    touch('projects', p)
    appendActivity(doc, 'project.status', projectId, { from, to: status })
  })
}

export function updateProjectMeta(
  projectId: string,
  fields: Partial<Pick<Project, 'name' | 'labels' | 'assigneeAppId' | 'dueAt' | 'notes'>>,
): void {
  updateProject(projectId, fields)
}

/** Upload a file into the project's own Drive subfolder, then link it. */
export async function uploadToProject(
  projectId: string,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<{ ok: true; fileId: string } | { ok: false; error: string }> {
  const { storeGet } = await import('../sync/store')
  const doc = storeGet().doc
  const project = doc?.projects[projectId]
  if (!doc || !project) return { ok: false, error: 'Project not found' }
  try {
    const folderId = await ensureProjectFolder(projectId)
    if (!folderId) return { ok: false, error: 'Group folder not ready — try again in a few seconds' }
    const meta = await uploadFile(folderId, file, { mode: 'bearer' }, onProgress)
    commit((d) => {
      const p = d.projects[projectId]
      if (!p) return
      p.fileIds = [...new Set([...p.fileIds, meta.id])]
      touch('projects', p)
      appendActivity(d, 'project.attach', projectId, { fileId: meta.id, fileName: file.name })
    })
    return { ok: true, fileId: meta.id }
  } catch (e) {
    if (e instanceof DriveError && e.kind === 'auth')
      return { ok: false, error: 'Your session expired — sign in again to upload' }
    if (e instanceof DriveError) return { ok: false, error: `${e.message} — ${e.kind}` }
    return { ok: false, error: e instanceof Error ? e.message : 'Upload failed' }
  }
}

/** Remove a file from a project — optionally trashing it on Drive (30-day
 *  recovery). Unlinking alone leaves the file where it is on Drive. */
export async function removeProjectFile(
  projectId: string,
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
    const p = doc.projects[projectId]
    if (!p) return
    p.fileIds = p.fileIds.filter((f) => f !== fileId)
    touch('projects', p)
    appendActivity(doc, opts.trashInDrive ? 'project.file.delete' : 'project.detach', projectId, { fileId })
  })
  return { ok: true }
}

/**
 * Delete a project: its Drive subfolder (with all files) moves to Drive trash
 * (30-day recovery) and the metadata is tombstoned. The UI shows the list first.
 */
export async function deleteProjectCascade(projectId: string): Promise<{ files: number; folderTrashed: boolean }> {
  assertWrite()
  const { storeGet } = await import('../sync/store')
  const doc = storeGet().doc
  const project = doc?.projects[projectId]
  if (!doc || !project) throw new Error('Project not found')
  const { trashFile } = await import('../drive/client')
  let folderTrashed = false
  for (const f of project.fileIds) await trashFile(f, { mode: 'bearer' }).catch(() => {})
  if (project.folderId) {
    await trashFile(project.folderId, { mode: 'bearer' }).catch(() => {})
    folderTrashed = true
  }
  commit((d) => {
    const p = d.projects[projectId]
    if (p) {
      p.deleted = { at: hlcNow(), by: writerId() }
      touch('projects', p)
      recordTombstone(d, 'project', projectId, writerId())
    }
    appendActivity(d, 'project.delete', projectId, {
      name: project.name,
      filesTrashed: project.fileIds.length,
    })
  })
  return { files: project.fileIds.length, folderTrashed }
}

// ---------------------------------------------------------------------------
// Scripts — bodies live as markdown files in scripts/; metadata in the master.
// ---------------------------------------------------------------------------

export function createScript(fields: { title: string; projectId?: string | null }): string {
  assertWrite()
  const id = newScriptId()
  commit((doc) => {
    const script: Script = {
      id,
      title: fields.title,
      storage: { type: 'md', fileId: '' }, // .md file created lazily on first save
      projectId: fields.projectId ?? null,
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

export function updateScript(id: string, fields: Partial<Pick<Script, 'title' | 'projectId'>>): void {
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
 * first save). Metadata stays in nexus.json; the text lives on Drive where it
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
      return { ok: false, error: 'Your session expired — sign in again to save scripts' }
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
    if (script.storage.type !== 'md' || !script.storage.fileId) return
    try {
      const scriptsFolderId = await ensureScriptsFolder(doc, { mode: 'bearer' })
      const body = await readScriptBody(id)
      if (body === null) return
      const { createTextFile } = await import('../drive/client')
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
// Admin: app users, viewer tokens, settings, workspace reset
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
    const salt = storeGet().doc?.settings.authStretchSalt
    if (!salt) throw new Error('Workspace predates stretched logins — ask an admin to re-save this login')
    auth = await stretchedAuth(secret, salt)
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
  const me = sessionModule().getSession()
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

/** Change a user's role after creation. Demoting the last active admin is refused. */
export function changeUserRole(userId: string, role: 'admin' | 'editor' | 'viewer'): void {
  assertAdmin()
  const me = sessionModule().getSession()
  if (me?.appUserId === userId) {
    throw new Error('You cannot change your own role — ask another admin')
  }
  commit((doc) => {
    const user = doc.users.app.find((u) => u.id === userId)
    if (!user) return
    if (user.role === role) return
    if (user.role === 'admin' && role !== 'admin') {
      const otherAdmins = doc.users.app.filter((u) => u.role === 'admin' && !u.disabled && u.id !== userId)
      if (otherAdmins.length === 0) throw new Error('Cannot demote the last active admin')
    }
    user.role = role
    user.updatedAt = hlcNow()
    user.writerId = writerId()
    appendActivity(doc, 'user.role', userId, { name: user.name, role })
  })
}

/** Remove a user entirely. Tombstoned so stale peers don't resurrect them. */
export function deleteUser(userId: string): void {
  assertAdmin()
  const me = sessionModule().getSession()
  if (me?.appUserId === userId) {
    throw new Error('You cannot delete your own account — ask another admin')
  }
  commit((doc) => {
    const user = doc.users.app.find((u) => u.id === userId)
    if (!user) return
    if (user.role === 'admin') {
      const otherAdmins = doc.users.app.filter((u) => u.role === 'admin' && !u.disabled && u.id !== userId)
      if (otherAdmins.length === 0) throw new Error('Cannot delete the last active admin')
    }
    doc.users.app = doc.users.app.filter((u) => u.id !== userId)
    recordTombstone(doc, 'user', userId, writerId())
    appendActivity(doc, 'user.delete', userId, { name: user.name })
  })
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
    const salt = storeGet().doc?.settings.authStretchSalt
    if (!salt) throw new Error('Workspace predates stretched logins — ask an admin to re-save this login')
    auth = await stretchedAuth(secret, salt)
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
    appendActivity(doc, 'settings.apiKey', 'settings', {})
  })
}

/**
 * Adopt a snapshot as the current doc. Keeps our write identity and a bumped
 * rev, then primes `base` with the remote's current tokens so the next flush
 * takes the unchanged fast path and overwrites Drive with exactly this
 * content. The snapshot itself stays on Drive as the pre-restore backup.
 */
export async function restoreSnapshot(fileId: string): Promise<void> {
  assertAdmin()
  const { readFile, getMeta } = await import('../drive/client')
  const { parseDoc } = await import('../types/schema')
  const store = storeGet()
  const nexusId = store.doc?.ids.nexusFileId
  if (!nexusId) throw new Error('Workspace file id unknown')
  const raw = await readFile(fileId, { mode: 'auto' })
  const parsed = parseDoc(raw)
  if (!parsed.ok) throw new Error('That snapshot is not a readable nexus.json')
  const restored: NexusDoc = {
    ...parsed.doc,
    rev: (store.doc?.rev ?? 0) + 1,
    writerId: writerId(),
    updatedAt: hlcNow(),
  }
  // Safety net: the pre-restore state becomes its own snapshot copy first, so
  // a restore is itself reversible.
  try {
    const currentRaw = await readFile(nexusId, { mode: 'auto' })
    if (currentRaw !== raw) {
      const { ensureSnapshotsFolder } = await import('../drive/bootstrap')
      const { copyFile } = await import('../drive/client')
      const snapshotsFolderId = store.doc ? await ensureSnapshotsFolder(store.doc, { mode: 'bearer' }) : null
      if (snapshotsFolderId) {
        const backup = await copyFile(
          nexusId,
          `pre-restore-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`,
          snapshotsFolderId,
          { mode: 'bearer' },
        )
        restored.snapshots = [
          ...restored.snapshots,
          { fileId: backup.id, rev: store.doc?.rev ?? 0, at: new Date().toISOString(), by: writerId(), note: 'pre-restore' },
        ]
      }
    }
  } catch {
    /* best-effort — restore proceeds without the extra copy */
  }
  const meta = await getMeta(nexusId, { mode: 'auto' })
  store.setDoc(restored)
  store.setBase({ headRevisionId: meta.headRevisionId, md5Checksum: meta.md5Checksum, version: meta.version })
  const ok = await flush()
  if (!ok) throw new Error('Restore could not be written — your changes are staged; try again in a moment')
}

export function unarchiveProject(projectId: string): void {
  assertWrite()
  commit((doc) => {
    const p = doc.projects[projectId]
    if (!p) return
    p.archivedAt = null
    touch('projects', p)
    appendActivity(doc, 'project.unarchive', projectId, { name: p.name })
  })
}

let lastArchiveSweep = 0
/**
 * Move projects sitting in a done-bucket stage untouched past
 * settings.workflow.archiveDoneAfterDays into the Archive. The schema fields
 * existed with no writer before this. Runs at most once per ~20h per tab.
 */
export function sweepAutoArchive(): void {
  const doc = storeGet().doc
  if (!doc) return
  const days = doc.settings.workflow.archiveDoneAfterDays
  const now = Date.now()
  if (!days || now - lastArchiveSweep < 20 * 3600 * 1000) return
  lastArchiveSweep = now
  const cutoffMs = now - days * 86400000
  const stale = Object.values(doc.projects).filter(
    (p) =>
      p.deleted === null &&
      p.archivedAt === null &&
      statusBucket(doc, p.status) === 'done' &&
      decodeHlc(p.updatedAt).ms < cutoffMs,
  )
  if (stale.length === 0) return
  commit((d) => {
    for (const p of stale) {
      const e = d.projects[p.id]
      if (!e || e.deleted !== null || e.archivedAt !== null) continue
      e.archivedAt = new Date().toISOString()
      touch('projects', e)
      appendActivity(d, 'project.archive', p.id, { name: e.name })
    }
  })
}

/**
 * Wipe all content data (groups, projects, scripts, activity, tombstones) and
 * trash their Drive files. Users, settings and workspace ids are KEPT so the
 * admin login still works. Intended for starting over while testing.
 */
export async function resetWorkspaceData(): Promise<{ groups: number; projects: number; scripts: number }> {
  assertAdmin()
  const { storeGet } = await import('../sync/store')
  const doc = storeGet().doc
  if (!doc) throw new Error('Workspace not loaded')
  const groups = Object.values(doc.groups)
  const scripts = Object.values(doc.scripts)

  // Drive-side: trash group folders (contain all project files) + script files.
  const { trashFile } = await import('../drive/client')
  for (const g of groups) {
    if (g.folderId) await trashFile(g.folderId, { mode: 'bearer' }).catch(() => {})
  }
  for (const s of scripts) {
    if (s.storage.type === 'md' && s.storage.fileId) {
      await trashFile(s.storage.fileId, { mode: 'bearer' }).catch(() => {})
    }
  }

  commit((d) => {
    d.groups = {}
    d.projects = {}
    d.scripts = {}
    d.tombstones = []
    d.activity = [{ at: hlcNow(), actor: sessionRef.getSession?.()?.appUserId ?? 'system', verb: 'workspace.reset', ref: 'workspace', meta: {} }]
    d.snapshots = []
    d.rev = d.rev + 1
  })
  const { clearAllPending } = await import('../sync/writer')
  clearAllPending() // wiped entities must not re-assert from the scratch set
  await flush()
  return { groups: groups.length, projects: Object.keys(doc.projects).length, scripts: scripts.length }
}
