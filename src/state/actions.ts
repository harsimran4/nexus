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
  type NexusDoc,
  type Project,
  type Group,
  type Script,
  type ScriptStatus,
} from '../types/schema'
import { canWrite, canAdmin } from '../auth/session'
import { commit, touch, recordTombstone, appendActivity, flush, writerId } from '../sync/writer'
import { hashPassword, mintToken, passwordPolicyError } from '../auth/hashing'
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
  await moveFile(project.folderId, to, fromFolderId, { mode: 'bearer' }).catch(() => {})
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
      return { ok: false, error: 'Sign in with Google to upload (top bar → Connect Google)' }
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
    appendActivity(doc, 'settings.apiKey', 'settings', {})
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
  await flush()
  return { groups: groups.length, projects: Object.keys(doc.projects).length, scripts: scripts.length }
}
