// Every mutation flows through commit() here. Mutators assert the role FIRST
// (fails before any write UI is offered), mutate + touch() entities, append
// activity, and let the writer handle sync.

import {
  newProjectId,
  newGroupId,
  newScriptId,
  newUserId,
  newViewerId,
  newMediaSectionId,
  newUploadLinkId,
  newRefId,
  newCommentId,
  newBeatId,
  newSceneId,
  newShotId,
  newStoryLinkId,
  uid,
} from '../util/id'
import { hlcNow } from '../util/hlc'
import { thumbKeyFor } from '../util/media'
import { nextSort, moveSorts, bySort } from '../util/storyOrder'
import {
  defaultStatus,
  statusBucket,
  type NexusDoc,
  type Project,
  type Group,
  type Script,
  type ScriptStatus,
  type ScriptBrief,
  type ScriptAct,
  type Beat,
  type Scene,
  type Shot,
  type StoryLink,
  type StoryLinkKind,
  type StoryRel,
  type UploadLink,
  type Ref,
  type Comment,
  BRIEF_EMPTY,
  DEFAULT_ACTS,
} from '../types/schema'
import { canWrite, canAdmin } from '../auth/session'
import { commit, touch, recordTombstone, appendActivity, flush, markContentDirty, writerId } from '../sync/writer'
import { mintToken, passwordPolicyError, stretchedAuth } from '../auth/hashing'
import { storeGet } from '../sync/store'
import { decodeHlc } from '../util/hlc'
import { DriveError, createFolder, uploadFile } from '../drive/client'
import { SYSTEM_PREFIXES } from '../types/storage'
import { sessionRef, sessionActor } from '../sync/identity'

/** Deterministic storage keys: group = groups/<groupId>/, project lives
 *  inside its group. Names are doc-only — keys never change on rename. */
function groupPrefix(groupId: string): string {
  return SYSTEM_PREFIXES.groups + groupId + '/'
}

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

export async function createGroup(name: string, description = '', color = ''): Promise<string> {
  assertWrite()
  const id = newGroupId()
  commit((doc) => {
    const group: Group = {
      id,
      name,
      description,
      folderId: null,
      color,
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

/** Create the group's storage prefix (groups/<groupId>/) if missing. */
export async function ensureGroupFolder(groupId: string): Promise<string | null> {
  const { storeGet } = await import('../sync/store')
  const doc = storeGet().doc
  const group = doc?.groups[groupId]
  if (!doc || !group) return null
  if (group.folderId) return group.folderId
  const prefix = groupPrefix(groupId)
  const folder = await createFolder(group.name, null, prefix)
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
  // Folder names live in the doc — the storage prefix (groups/<id>/) never
  // changes, so there is nothing to rename on the storage side.
}

export function setGroupColor(groupId: string, color: string): void {
  assertWrite()
  commit((doc) => {
    const g = doc.groups[groupId]
    if (!g) return
    g.color = color
    touch('groups', g)
    appendActivity(doc, 'group.color', groupId, { color })
  })
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
    await trashFile(group.folderId).catch(() => {})
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
  status?: string
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
      status: fields.status ?? defaultStatus(doc),
      labels: fields.labels ?? [],
      approved: null,
      fileIds: [],
      mediaSections: [],
      mediaSectionOf: {},
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

/** Project prefix: groups/<groupId>/<projectId>/ — created on demand. */
export async function ensureProjectFolder(projectId: string): Promise<string | null> {
  const { storeGet } = await import('../sync/store')
  const doc = storeGet().doc
  const project = doc?.projects[projectId]
  if (!doc || !project) return null
  if (project.folderId) return project.folderId
  const parent = await ensureGroupFolder(project.groupId)
  if (!parent) return null
  const prefix = parent + projectId + '/'
  const folder = await createFolder(project.name, null, prefix)
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
  commit((doc) => {
    const p = doc.projects[projectId]
    if (!p) return
    if (fields.groupId !== undefined && fields.groupId !== p.groupId) {
      const target = doc.groups[fields.groupId]
      if (!target || target.deleted) {
        throw new Error('Target group no longer exists — refresh and pick again')
      }
      moveToGroup = fields.groupId
    }
    Object.assign(p, fields)
    touch('projects', p)
    const meaningful = Object.keys(fields).filter((k) => k !== 'notes')
    if (meaningful.length > 0) appendActivity(doc, 'project.update', projectId, { fields: meaningful })
  })
  if (moveToGroup) void moveProjectToGroup(projectId, moveToGroup)
}

/** Move a project (its storage prefix and every file key in it) into another
 *  group. Keys embed the path, so the doc's fileIds/mediaSectionOf are
 *  rewritten in the same commit as the new prefix. */
export async function moveProjectToGroup(projectId: string, toGroupId: string): Promise<void> {
  const { storeGet } = await import('../sync/store')
  const doc = storeGet().doc
  const project = doc?.projects[projectId]
  if (!doc || !project || !project.folderId) return
  const fromPrefix = project.folderId
  const parent = await ensureGroupFolder(toGroupId)
  if (!parent) return
  const toPrefix = parent + projectId + '/'
  if (toPrefix === fromPrefix) return
  const { movePrefix } = await import('../drive/client')
  try {
    await movePrefix(fromPrefix, toPrefix)
  } catch (e) {
    // Metadata already says the new group; the files didn't follow.
    // Record the divergence instead of swallowing it.
    commit((d) => {
      appendActivity(d, 'project.moveFailed', projectId, {
        to: toGroupId,
        reason: e instanceof Error ? e.message : 'Move failed',
      })
    })
    return
  }
  commit((d) => {
    const p = d.projects[projectId]
    if (!p) return
    const rekey = (f: string): string => (f.startsWith(fromPrefix) ? toPrefix + f.slice(fromPrefix.length) : f)
    p.folderId = toPrefix
    p.fileIds = p.fileIds.map(rekey)
    const sectionOf: typeof p.mediaSectionOf = {}
    for (const [f, s] of Object.entries(p.mediaSectionOf)) sectionOf[rekey(f)] = s
    p.mediaSectionOf = sectionOf
    touch('projects', p)
    appendActivity(d, 'project.move', projectId, { to: toGroupId })
  })
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

// ---------------------------------------------------------------------------
// Media sections — app-only groupings over the project's flat Drive folder.
// A fileId with no mediaSectionOf entry is "Unsorted".
// ---------------------------------------------------------------------------

export function addMediaSection(projectId: string, name: string): string | null {
  assertWrite()
  const clean = name.trim()
  if (!clean) return null
  const id = newMediaSectionId()
  commit((doc) => {
    const p = doc.projects[projectId]
    if (!p) return
    p.mediaSections = [...p.mediaSections, { id, name: clean }]
    touch('projects', p)
    appendActivity(doc, 'project.section.create', projectId, { name: clean })
  })
  return id
}

export function renameMediaSection(projectId: string, sectionId: string, name: string): void {
  assertWrite()
  const clean = name.trim()
  if (!clean) return
  commit((doc) => {
    const p = doc.projects[projectId]
    const section = p?.mediaSections.find((s) => s.id === sectionId)
    if (!p || !section) return
    section.name = clean
    touch('projects', p)
    appendActivity(doc, 'project.section.rename', projectId, { section: sectionId, name: clean })
  })
}

/** Delete a section; its files become Unsorted (assignments cleared in the
 *  same commit, so a peer can never see a dangling section reference). */
export function removeMediaSection(projectId: string, sectionId: string): void {
  assertWrite()
  commit((doc) => {
    const p = doc.projects[projectId]
    const section = p?.mediaSections.find((s) => s.id === sectionId)
    if (!p || !section) return
    p.mediaSections = p.mediaSections.filter((s) => s.id !== sectionId)
    let filesUnsorted = 0
    for (const f of Object.keys(p.mediaSectionOf)) {
      if (p.mediaSectionOf[f] === sectionId) {
        delete p.mediaSectionOf[f]
        filesUnsorted++
      }
    }
    touch('projects', p)
    appendActivity(doc, 'project.section.delete', projectId, { name: section.name, filesUnsorted })
  })
}

/** Bulk (re-)assign files to a section; null moves them to Unsorted. Inputs
 *  are filtered to files the project still holds, so a stale selection from
 *  another view can never resurrect entries. */
export function moveMediaToSection(projectId: string, fileIds: string[], sectionId: string | null): void {
  assertWrite()
  commit((doc) => {
    const p = doc.projects[projectId]
    if (!p) return
    const known = new Set(p.fileIds)
    const sectionExists = sectionId !== null && p.mediaSections.some((s) => s.id === sectionId)
    let moved = 0
    for (const f of fileIds) {
      if (!known.has(f)) continue
      if (sectionId === null || !sectionExists) delete p.mediaSectionOf[f]
      else p.mediaSectionOf[f] = sectionId
      moved++
    }
    if (moved === 0) return
    touch('projects', p)
    appendActivity(doc, 'project.media.move', projectId, { files: moved, to: sectionExists ? sectionId : null })
  })
}

/** Reorder sections by one slot (mediaSections order IS the display order).
 *  Doc-only array swap — storage prefixes don't encode section order, and the
 *  LWW merge applies to the whole array, so a concurrent rename of a sibling
 *  section resolves last-writer-wins without corruption. */
export function reorderMediaSections(projectId: string, sectionId: string, dir: -1 | 1): void {
  assertWrite()
  commit((doc) => {
    const p = doc.projects[projectId]
    if (!p) return
    const i = p.mediaSections.findIndex((s) => s.id === sectionId)
    const j = i + dir
    if (i === -1 || j < 0 || j >= p.mediaSections.length) return
    const next = [...p.mediaSections]
    ;[next[i], next[j]] = [next[j], next[i]]
    p.mediaSections = next
    touch('projects', p)
  })
}

/** Upload a file into the project's own Drive subfolder, then link it.
 *  `opts.signal` cancels the transfer — the batch store aborts it. */
export async function uploadToProject(
  projectId: string,
  file: File,
  onProgress?: (pct: number) => void,
  opts: { sectionId?: string | null; signal?: AbortSignal } = {},
): Promise<{ ok: true; fileId: string } | { ok: false; error: string }> {
  const { storeGet } = await import('../sync/store')
  const doc = storeGet().doc
  const project = doc?.projects[projectId]
  if (!doc || !project) return { ok: false, error: 'Project not found' }
  try {
    const folderId = await ensureProjectFolder(projectId)
    if (!folderId) return { ok: false, error: 'Project folder not ready — try again in a few seconds' }
    // projectId/sectionId ride along so the SERVER links the file into the
    // doc at completion — the commit below is only instant UI feedback; the
    // sync kernel's replay/discard/re-assert behaviors can roll a client-side
    // link back after a successful upload (files kept vanishing from Media).
    const meta = await uploadFile(folderId, file, onProgress, { projectId, sectionId: opts.sectionId ?? null, signal: opts.signal })
    // The project may have MOVED to another group while the bytes were in
    // flight — the object sits under the old prefix and the doc already
    // references the new one. Copy the object across, then link the copy.
    let linked = meta
    let movedDuringUpload = false
    const pNow = storeGet().doc?.projects[projectId]
    if (pNow?.folderId && !meta.id.startsWith(pNow.folderId)) {
      const { copyFile, trashFile } = await import('../drive/client')
      const nameSegment = meta.id.slice(meta.id.indexOf('__') + 2)
      const moved = await copyFile(meta.id, nameSegment, pNow.folderId)
      await trashFile(meta.id).catch(() => {})
      linked = moved
      movedDuringUpload = true
    }
    commit((d) => {
      const p = d.projects[projectId]
      if (!p) return
      p.fileIds = [...new Set([...p.fileIds, linked.id])]
      // The server linked the PRE-move key at completion (it saw the old
      // folderId); that object was copied to the new prefix and trashed at
      // the old one — strip the ghost in the same commit that adds the copy.
      if (movedDuringUpload) {
        p.fileIds = p.fileIds.filter((f) => f !== meta.id)
        delete p.mediaSectionOf[meta.id]
      }
      // Assign the upload's section in the same commit as the link — atomic,
      // and skipped if that section was deleted while the upload was in flight.
      if (opts.sectionId && p.mediaSections.some((s) => s.id === opts.sectionId)) {
        p.mediaSectionOf[linked.id] = opts.sectionId
      }
      touch('projects', p)
      appendActivity(d, 'project.attach', projectId, { fileId: linked.id, fileName: file.name, sectionId: opts.sectionId ?? null })
    })
    return { ok: true, fileId: linked.id }
  } catch (e) {
    // A cancel is user intent, not a failure — one clean line, no kind suffix.
    if (e instanceof DriveError && e.aborted) return { ok: false, error: 'Upload cancelled' }
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
    const { trashFile, getMeta } = await import('../drive/client')
    try {
      await trashFile(fileId)
      const thumb = thumbKeyFor(fileId)
      if (thumb) await trashFile(thumb).catch(() => {}) // generated poster — optional
    } catch (e) {
      if (e instanceof DriveError && e.kind === 'notFound') {
        // Already gone from storage — still unlink it below.
      } else if (e instanceof DriveError) {
        // Ghost links (a server link that raced a move/copy) point at keys
        // that no longer exist but surface as api errors, not notFound —
        // verify before failing the unlink, an already-gone object unlinks.
        const still = await getMeta(fileId).catch((m) => (m instanceof DriveError && m.kind === 'notFound' ? null : undefined))
        if (still !== null) return { ok: false, error: `${e.message} — ${e.kind}` }
      } else {
        return { ok: false, error: e instanceof Error ? e.message : 'Delete failed' }
      }
    }
  }
  commit((doc) => {
    const p = doc.projects[projectId]
    if (!p) return
    p.fileIds = p.fileIds.filter((f) => f !== fileId)
    delete p.mediaSectionOf[fileId]
    touch('projects', p)
    appendActivity(doc, opts.trashInDrive ? 'project.file.delete' : 'project.detach', projectId, { fileId })
  })
  return { ok: true }
}

/**
 * Delete a project: metadata only — the files STAY in the bucket so Archive
 * → Restore brings everything back intact. Purge (from the Archive) is what
 * moves the bytes to trash/. The UI shows the list first.
 */
export async function deleteProjectCascade(projectId: string): Promise<{ files: number; folderTrashed: boolean }> {
  assertWrite()
  const { storeGet } = await import('../sync/store')
  const doc = storeGet().doc
  const project = doc?.projects[projectId]
  if (!doc || !project) throw new Error('Project not found')
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
  return { files: project.fileIds.length, folderTrashed: false }
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
      acts: [],
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
    const changed = (Object.keys(fields) as (keyof typeof fields)[]).filter(
      (k) => s[k as keyof Script] !== fields[k],
    )
    Object.assign(s, fields)
    touch('scripts', s)
    if (changed.length > 0) appendActivity(doc, 'script.update', id, { fields: changed })
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
    const { createTextFile, writeFileText } = await import('../drive/client')
    if (script.storage.type === 'md' && script.storage.fileId) {
      await writeFileText(script.storage.fileId, body, 'text/markdown')
    } else {
      const created = await createTextFile(`${id}.md`, SYSTEM_PREFIXES.scripts, body, 'text/markdown')
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
    return await readFile(script.storage.fileId)
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
      const body = await readScriptBody(id)
      if (body === null) return
      const { createTextFile } = await import('../drive/client')
      const copy = await createTextFile(`${id}-${status}.md`, SYSTEM_PREFIXES.scripts, body, 'text/markdown')
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
    // Story children ride along — each tombstoned so GC sweeps their rows
    // (wireDiff's deleted-scripts block deletes them child-first).
    const roots = Object.values(doc.beats)
      .filter((b) => b.scriptId === id && !b.deleted)
      .map((b) => ({ kind: 'beat' as const, id: b.id }))
    const counts = cascadeStoryDelete(doc, roots)
    doc.storyLinks = (doc.storyLinks ?? []).map((l) =>
      !l.deleted && l.scriptId === id
        ? { ...l, deleted: { at: hlcNow(), by: writerId() }, updatedAt: hlcNow(), writerId: writerId() }
        : l,
    )
    appendActivity(doc, 'script.delete', id, { title: s.title, ...counts })
  })
}

/** Restore a soft-deleted script (Archive → Scripts). Fresh stamps so the
 *  restore beats the tombstone on merge; its story structure stays deleted —
 *  those entities were tombstoned individually with the script. */
export function restoreScript(id: string): void {
  assertWrite()
  commit((doc) => {
    const s = doc.scripts[id]
    if (!s) return
    s.deleted = null
    touch('scripts', s)
    appendActivity(doc, 'script.restore', id, { title: s.title })
  })
}

// ---------------------------------------------------------------------------
// Story structure — the connected creative system inside a script. Beats /
// scenes / shots are record-map entities (per-key LWW + touch() re-assert);
// story links are a top-level array (refs model: entry-level stamps, NEVER
// touch()). Sibling order is a per-entity `sort` int — never a parent-carried
// id array, which two concurrent writers would clobber.
// ---------------------------------------------------------------------------

type StoryKind = 'beat' | 'scene' | 'shot'

function storyMap(d: NexusDoc, kind: StoryKind): Record<string, Beat | Scene | Shot> {
  return kind === 'beat' ? d.beats : kind === 'scene' ? d.scenes : d.shots
}

function touchStory(kind: StoryKind, e: Beat | Scene | Shot): void {
  if (kind === 'beat') touch('beats', e as Beat)
  else if (kind === 'scene') touch('scenes', e as Scene)
  else touch('shots', e as Shot)
}

function storyLabel(e: Beat | Scene | Shot, kind: StoryKind): string {
  const text = kind === 'shot' ? (e as Shot).caption : (e as Beat | Scene).title
  return text?.trim() || `Untitled ${kind}`
}

/** Depth-first soft-delete of the root story entities and everything under
 *  them (beat → scenes → their shots + the beat's own shots), plus every
 *  story link touching a removed id. Logs NOTHING — the caller appends ONE
 *  activity event carrying these counts. Tombstones each removed entity. */
function cascadeStoryDelete(d: NexusDoc, roots: { kind: StoryKind; id: string }[]): { beats: number; scenes: number; shots: number; links: number } {
  const counts = { beats: 0, scenes: 0, shots: 0, links: 0 }
  const removed = new Set<string>()
  const visit = (kind: StoryKind, eid: string): void => {
    const e = storyMap(d, kind)[eid]
    if (!e || e.deleted) return
    e.deleted = { at: hlcNow(), by: writerId() }
    touchStory(kind, e)
    recordTombstone(d, kind, eid, writerId())
    counts[`${kind}s` as 'beats' | 'scenes' | 'shots']++
    removed.add(eid)
    if (kind === 'beat') {
      for (const s of Object.values(d.scenes)) if (s.beatId === eid && !s.deleted) visit('scene', s.id)
      for (const s of Object.values(d.shots)) if (s.beatId === eid && !s.deleted) visit('shot', s.id)
    }
    if (kind === 'scene') {
      for (const s of Object.values(d.shots)) if (s.sceneId === eid && !s.deleted) visit('shot', s.id)
    }
  }
  for (const r of roots) visit(r.kind, r.id)
  if (removed.size > 0) {
    d.storyLinks = (d.storyLinks ?? []).map((l) => {
      if (l.deleted || !(removed.has(l.fromId) || removed.has(l.toId))) return l
      counts.links++
      return { ...l, deleted: { at: hlcNow(), by: writerId() }, updatedAt: hlcNow(), writerId: writerId() }
    })
  }
  return counts
}

// --- Creative Brief (embedded on the script; rides D1 scripts.extra) -------

export function updateScriptBrief(scriptId: string, patch: Partial<ScriptBrief>): void {
  assertWrite()
  commit((d) => {
    const s = d.scripts[scriptId]
    if (!s) return
    const next = { ...BRIEF_EMPTY, ...(s.brief ?? {}), ...trimBrief(patch) }
    // Absent-by-default: an all-empty brief deletes the key entirely, so a
    // never-briefed script never grows a default-filled object (the same
    // shadow-diff discipline as viewer.scope).
    if (Object.values(next).every((v) => v === '')) delete s.brief
    else s.brief = next
    touch('scripts', s)
    appendActivity(d, 'script.brief', scriptId, { title: s.title })
  })
}

const BRIEF_MAX = 5000
function trimBrief(patch: Partial<ScriptBrief>): Partial<ScriptBrief> {
  const out: Partial<ScriptBrief> = {}
  for (const [k, v] of Object.entries(patch)) if (typeof v === 'string') out[k as keyof ScriptBrief] = v.slice(0, BRIEF_MAX)
  return out
}

// --- Acts (embedded array on the script, like mediaSections) ----------------

/** Seed Opening/Middle/Ending — idempotent, DETERMINISTIC ids so two tabs
 *  seeding concurrently merge to the identical trio. Quiet: no activity. */
export function seedDefaultActs(scriptId: string): void {
  assertWrite()
  commit((d) => {
    const s = d.scripts[scriptId]
    if (!s || s.acts.length > 0) return
    s.acts = DEFAULT_ACTS.map((a) => ({ ...a }))
    touch('scripts', s)
  })
}

export function addAct(scriptId: string, name: string): string | null {
  assertWrite()
  const clean = name.trim()
  if (!clean) return null
  const id = uid('act')
  commit((d) => {
    const s = d.scripts[scriptId]
    if (!s) return
    s.acts = [...s.acts, { id, name: clean.slice(0, 120) }]
    touch('scripts', s)
    appendActivity(d, 'script.act.add', scriptId, { title: s.title, name: clean })
  })
  return id
}

export function renameAct(scriptId: string, actId: string, name: string): void {
  assertWrite()
  const clean = name.trim()
  if (!clean) return
  commit((d) => {
    const s = d.scripts[scriptId]
    if (!s) return
    const act = s.acts.find((a) => a.id === actId)
    if (!act) return
    act.name = clean.slice(0, 120)
    touch('scripts', s)
    appendActivity(d, 'script.act.rename', scriptId, { title: s.title, name: clean })
  })
}

/** Remove an act; its beats move to the NEIGHBOURING act (previous, else
 *  next). Refuses the last remaining act — a stray click must never cascade
 *  every beat away. Returns 'moved' | 'refused-last-act'. */
export function removeAct(scriptId: string, actId: string): 'moved' | 'refused-last-act' {
  assertWrite()
  let result: 'moved' | 'refused-last-act' = 'refused-last-act'
  commit((d) => {
    const s = d.scripts[scriptId]
    if (!s) return
    const idx = s.acts.findIndex((a) => a.id === actId)
    if (idx === -1) return
    if (s.acts.length === 1) return
    const neighbour = s.acts[idx - 1] ?? s.acts[idx + 1]
    const removed = s.acts[idx]!
    s.acts = s.acts.filter((a) => a.id !== actId)
    for (const b of Object.values(d.beats)) {
      if (b.actId === actId && !b.deleted) {
        b.actId = neighbour!.id
        touch('beats', b)
      }
    }
    touch('scripts', s)
    appendActivity(d, 'script.act.remove', scriptId, { title: s.title, name: removed.name })
    result = 'moved'
  })
  return result
}

/** Reorder acts by ±1 — quiet (cosmetic churn, like folder bookkeeping). */
export function reorderActs(scriptId: string, actId: string, dir: -1 | 1): void {
  assertWrite()
  commit((d) => {
    const s = d.scripts[scriptId]
    if (!s) return
    const idx = s.acts.findIndex((a) => a.id === actId)
    const to = idx + dir
    if (idx === -1 || to < 0 || to >= s.acts.length) return
    const acts: ScriptAct[] = [...s.acts]
    const [moved] = acts.splice(idx, 1)
    acts.splice(to, 0, moved!)
    s.acts = acts
    touch('scripts', s)
  })
}

// --- Beats -------------------------------------------------------------------

export function addBeat(scriptId: string, actId: string, fields?: Partial<Pick<Beat, 'title' | 'summary'>>): string | null {
  assertWrite()
  const script = storeGet().doc?.scripts[scriptId]
  if (!script || script.deleted) return null
  if (!script.acts.some((a) => a.id === actId)) return null
  const id = newBeatId()
  commit((d) => {
    const siblings = Object.values(d.beats).filter((b) => b.scriptId === scriptId && b.actId === actId && !b.deleted)
    const beat: Beat = {
      id,
      scriptId,
      actId,
      title: fields?.title ?? '',
      summary: fields?.summary ?? '',
      purpose: '',
      bridge: '',
      sort: nextSort(bySort(siblings)),
      createdAt: hlcNow(),
      updatedAt: hlcNow(),
      writerId: 'pending',
      deleted: null,
      archivedAt: null,
    }
    d.beats[id] = beat
    touch('beats', d.beats[id] as Beat)
    appendActivity(d, 'beat.create', scriptId, { kind: 'beat', label: storyLabel(beat, 'beat') })
  })
  return id
}

export function updateBeat(beatId: string, fields: Partial<Pick<Beat, 'title' | 'summary' | 'purpose' | 'bridge'>>): void {
  assertWrite()
  commit((d) => {
    const b = d.beats[beatId]
    if (!b || b.deleted) return
    Object.assign(b, fields)
    touch('beats', b)
    appendActivity(d, 'beat.update', b.scriptId, { kind: 'beat', label: storyLabel(b, 'beat') })
  })
}

/** Move a beat to (toActId, toIndex) — reparent + reorder in one commit.
 *  Sibling rewrites are per-entity sort keys (util/storyOrder), so two
 *  writers reordering the same act converge deterministically instead of
 *  clobbering. Logs only when the act changed; same-act drags stay quiet. */
export function moveBeat(beatId: string, toActId: string, toIndex: number): void {
  assertWrite()
  commit((d) => {
    const b = d.beats[beatId]
    if (!b || b.deleted) return
    const s = d.scripts[b.scriptId]
    if (!s || !s.acts.some((a) => a.id === toActId)) return
    const dest = Object.values(d.beats).filter((x) => x.scriptId === b.scriptId && x.actId === toActId && !x.deleted)
    const sorts = moveSorts(dest, beatId, toIndex)
    const actChanged = b.actId !== toActId
    b.actId = toActId
    for (const [eid, sort] of Object.entries(sorts)) {
      const e = d.beats[eid]
      if (!e) continue
      e.sort = sort
      touch('beats', e)
    }
    touch('beats', b)
    if (actChanged) appendActivity(d, 'beat.move', b.scriptId, { kind: 'beat', label: storyLabel(b, 'beat'), to: s.acts.find((a) => a.id === toActId)?.name })
  })
}

export function deleteBeat(beatId: string): void {
  assertWrite()
  commit((d) => {
    const b = d.beats[beatId]
    if (!b || b.deleted) return
    const scriptId = b.scriptId
    const label = storyLabel(b, 'beat')
    const counts = cascadeStoryDelete(d, [{ kind: 'beat', id: beatId }])
    appendActivity(d, 'beat.delete', scriptId, { kind: 'beat', label, ...counts })
  })
}

// --- Scenes ------------------------------------------------------------------

export function addScene(scriptId: string, beatId: string, fields?: Partial<Pick<Scene, 'title' | 'action' | 'location'>>): string | null {
  assertWrite()
  const beat = storeGet().doc?.beats[beatId]
  if (!beat || beat.deleted || beat.scriptId !== scriptId) return null
  const id = newSceneId()
  commit((d) => {
    const siblings = Object.values(d.scenes).filter((x) => x.beatId === beatId && !x.deleted)
    const scene: Scene = {
      id,
      scriptId,
      beatId,
      title: fields?.title ?? '',
      action: fields?.action ?? '',
      location: fields?.location ?? '',
      sort: nextSort(bySort(siblings)),
      createdAt: hlcNow(),
      updatedAt: hlcNow(),
      writerId: 'pending',
      deleted: null,
      archivedAt: null,
    }
    d.scenes[id] = scene
    touch('scenes', d.scenes[id] as Scene)
    appendActivity(d, 'scene.create', scriptId, { kind: 'scene', label: storyLabel(scene, 'scene') })
  })
  return id
}

export function updateScene(sceneId: string, fields: Partial<Pick<Scene, 'title' | 'action' | 'location'>>): void {
  assertWrite()
  commit((d) => {
    const s = d.scenes[sceneId]
    if (!s || s.deleted) return
    Object.assign(s, fields)
    touch('scenes', s)
    appendActivity(d, 'scene.update', s.scriptId, { kind: 'scene', label: storyLabel(s, 'scene') })
  })
}

/** Move a scene to another beat (+ index). Logs only when the beat changed. */
export function moveScene(sceneId: string, toBeatId: string, toIndex: number): void {
  assertWrite()
  commit((d) => {
    const s = d.scenes[sceneId]
    if (!s || s.deleted) return
    const destBeat = d.beats[toBeatId]
    if (!destBeat || destBeat.deleted || destBeat.scriptId !== s.scriptId) return
    const dest = Object.values(d.scenes).filter((x) => x.beatId === toBeatId && !x.deleted)
    const sorts = moveSorts(dest, sceneId, toIndex)
    const beatChanged = s.beatId !== toBeatId
    s.beatId = toBeatId
    for (const [eid, sort] of Object.entries(sorts)) {
      const e = d.scenes[eid]
      if (!e) continue
      e.sort = sort
      touch('scenes', e)
    }
    touch('scenes', s)
    if (beatChanged) appendActivity(d, 'scene.move', s.scriptId, { kind: 'scene', label: storyLabel(s, 'scene'), to: destBeat.title || 'Untitled beat' })
  })
}

export function deleteScene(sceneId: string): void {
  assertWrite()
  commit((d) => {
    const s = d.scenes[sceneId]
    if (!s || s.deleted) return
    const scriptId = s.scriptId
    const label = storyLabel(s, 'scene')
    const counts = cascadeStoryDelete(d, [{ kind: 'scene', id: sceneId }])
    appendActivity(d, 'scene.delete', scriptId, { kind: 'scene', label, ...counts })
  })
}

// --- Shots (on a scene OR directly on a beat — exactly one parent) -----------

export function addShot(scriptId: string, parent: { sceneId: string } | { beatId: string }, fields?: Partial<Pick<Shot, 'caption' | 'shotSize' | 'cameraMove'>>): string | null {
  assertWrite()
  const doc = storeGet().doc
  if (!doc) return null
  const sceneId = 'sceneId' in parent ? parent.sceneId : null
  const beatId = 'beatId' in parent ? parent.beatId : null
  if (sceneId) {
    const scene = doc.scenes[sceneId]
    if (!scene || scene.deleted || scene.scriptId !== scriptId) return null
  } else if (beatId) {
    const beat = doc.beats[beatId]
    if (!beat || beat.deleted || beat.scriptId !== scriptId) return null
  } else {
    return null
  }
  const id = newShotId()
  commit((d) => {
    const siblings = Object.values(d.shots).filter(
      (x) => !x.deleted && (sceneId ? x.sceneId === sceneId : x.beatId === beatId),
    )
    const shot: Shot = {
      id,
      scriptId,
      sceneId,
      beatId,
      caption: fields?.caption ?? '',
      shotSize: fields?.shotSize ?? '',
      cameraMove: fields?.cameraMove ?? '',
      composition: '',
      lighting: '',
      sound: '',
      sort: nextSort(bySort(siblings)),
      createdAt: hlcNow(),
      updatedAt: hlcNow(),
      writerId: 'pending',
      deleted: null,
      archivedAt: null,
    }
    d.shots[id] = shot
    touch('shots', d.shots[id] as Shot)
    appendActivity(d, 'shot.create', scriptId, { kind: 'shot', label: storyLabel(shot, 'shot') })
  })
  return id
}

export function updateShot(shotId: string, fields: Partial<Pick<Shot, 'caption' | 'shotSize' | 'cameraMove' | 'composition' | 'lighting' | 'sound' | 'durationSec'>>): void {
  assertWrite()
  commit((d) => {
    const s = d.shots[shotId]
    if (!s || s.deleted) return
    Object.assign(s, fields)
    touch('shots', s)
    appendActivity(d, 'shot.update', s.scriptId, { kind: 'shot', label: storyLabel(s, 'shot') })
  })
}

/** Point a shot's storyboard at a project file (a fileIds storage key). */
export function attachShotStoryboard(shotId: string, fileKey: string): { ok: true } | { ok: false; error: string } {
  assertWrite()
  const doc = storeGet().doc
  const shot = doc?.shots[shotId]
  if (!doc || !shot || shot.deleted) return { ok: false, error: 'Shot not found' }
  const script = doc.scripts[shot.scriptId]
  if (!script?.projectId) return { ok: false, error: 'Link this script to a project first — storyboards live in its media' }
  const project = doc.projects[script.projectId]
  if (!project || project.deleted) return { ok: false, error: 'The linked project no longer exists' }
  if (!project.fileIds.includes(fileKey)) return { ok: false, error: 'That file is not in the linked project’s media' }
  commit((d) => {
    const s = d.shots[shotId]
    if (!s || s.deleted) return
    s.storyboardFileKey = fileKey
    touch('shots', s)
    appendActivity(d, 'shot.update', s.scriptId, { kind: 'shot', label: storyLabel(s, 'shot'), fields: ['storyboard'] })
  })
  return { ok: true }
}

export function detachShotStoryboard(shotId: string): void {
  assertWrite()
  commit((d) => {
    const s = d.shots[shotId]
    if (!s || s.deleted || s.storyboardFileKey === undefined) return
    delete s.storyboardFileKey
    touch('shots', s)
    appendActivity(d, 'shot.update', s.scriptId, { kind: 'shot', label: storyLabel(s, 'shot'), fields: ['storyboard'] })
  })
}

/** Move a shot between parents (scene ↔ beat or within one) — enforces the
 *  exactly-one-parent rule. Logs only when the parent changed. */
export function moveShot(shotId: string, toParent: { sceneId: string } | { beatId: string }, toIndex: number): void {
  assertWrite()
  commit((d) => {
    const s = d.shots[shotId]
    if (!s || s.deleted) return
    const toScene = 'sceneId' in toParent ? toParent.sceneId : null
    const toBeat = 'beatId' in toParent ? toParent.beatId : null
    if (toScene) {
      const scene = d.scenes[toScene]
      if (!scene || scene.deleted || scene.scriptId !== s.scriptId) return
    } else if (toBeat) {
      const beat = d.beats[toBeat]
      if (!beat || beat.deleted || beat.scriptId !== s.scriptId) return
    } else {
      return
    }
    const dest = Object.values(d.shots).filter((x) => !x.deleted && (toScene ? x.sceneId === toScene : x.beatId === toBeat))
    const sorts = moveSorts(dest, shotId, toIndex)
    const changed = s.sceneId !== toScene || s.beatId !== toBeat
    s.sceneId = toScene
    s.beatId = toBeat
    for (const [eid, sort] of Object.entries(sorts)) {
      const e = d.shots[eid]
      if (!e) continue
      e.sort = sort
      touch('shots', e)
    }
    touch('shots', s)
    if (changed) appendActivity(d, 'shot.move', s.scriptId, { kind: 'shot', label: storyLabel(s, 'shot') })
  })
}

export function deleteShot(shotId: string): void {
  assertWrite()
  commit((d) => {
    const s = d.shots[shotId]
    if (!s || s.deleted) return
    const scriptId = s.scriptId
    const label = storyLabel(s, 'shot')
    const counts = cascadeStoryDelete(d, [{ kind: 'shot', id: shotId }])
    appendActivity(d, 'shot.delete', scriptId, { kind: 'shot', label, ...counts })
  })
}

// --- Story links (inspiration + relations — the refs array model) ------------

/** Create a relation between two story elements. Endpoints: 'script' = the
 *  brief / whole-script concept, 'ref' = a doc.refs entry, else a beat /
 *  scene / shot of this script. Rejects an exact live duplicate. */
export function createStoryLink(f: {
  scriptId: string
  from: { kind: StoryLinkKind; id: string }
  to: { kind: StoryLinkKind; id: string }
  rel: StoryRel
  note?: string
}): string {
  assertWrite()
  const doc = storeGet().doc
  if (!doc?.scripts[f.scriptId] || doc.scripts[f.scriptId]!.deleted) throw new Error('Script not found')
  const endpointScript = (kind: StoryLinkKind, id: string): boolean => {
    if (kind === 'script') return id === f.scriptId
    if (kind === 'ref') return (doc.refs ?? []).some((r) => r.id === id && !r.deleted)
    const map = storyMap(doc, kind)
    const e = map[id] as Beat | Scene | Shot | undefined
    return !!e && !e.deleted && e.scriptId === f.scriptId
  }
  if (!endpointScript(f.from.kind, f.from.id) || !endpointScript(f.to.kind, f.to.id)) {
    throw new Error('One end of that link no longer exists')
  }
  const dup = (doc.storyLinks ?? []).some(
    (l) => !l.deleted && l.scriptId === f.scriptId && l.fromKind === f.from.kind && l.fromId === f.from.id && l.toKind === f.to.kind && l.toId === f.to.id && l.rel === f.rel,
  )
  if (dup) throw new Error('That link already exists')
  const id = newStoryLinkId()
  commit((d) => {
    const link: StoryLink = {
      id,
      scriptId: f.scriptId,
      fromKind: f.from.kind,
      fromId: f.from.id,
      toKind: f.to.kind,
      toId: f.to.id,
      rel: f.rel,
      note: (f.note ?? '').slice(0, 500),
      createdAt: hlcNow(),
      updatedAt: hlcNow(),
      writerId: writerId(),
      deleted: null,
    }
    d.storyLinks = [...(d.storyLinks ?? []), link]
    appendActivity(d, 'story.link', f.scriptId, { rel: f.rel })
  })
  return id
}

export function updateStoryLink(linkId: string, fields: { note?: string }): boolean {
  assertWrite()
  let changed = false
  commit((d) => {
    const l = (d.storyLinks ?? []).find((x) => x.id === linkId)
    if (!l || l.deleted) return
    if (fields.note !== undefined) l.note = fields.note.slice(0, 500)
    l.updatedAt = hlcNow()
    l.writerId = writerId()
    changed = true
  })
  return changed
}

export function deleteStoryLink(linkId: string): boolean {
  assertWrite()
  let changed = false
  commit((d) => {
    const l = (d.storyLinks ?? []).find((x) => x.id === linkId)
    if (!l || l.deleted) return
    l.deleted = { at: hlcNow(), by: writerId() }
    l.updatedAt = hlcNow() // LWW: the delete must beat any in-flight older edit
    l.writerId = writerId()
    appendActivity(d, 'story.unlink', l.scriptId, { rel: l.rel })
    changed = true
  })
  return changed
}

// --- Story Graph positions (cosmetic — commit + touch, NO activity) ----------

export function setNodePos(kind: 'beat' | 'scene' | 'shot', id: string, pos: { x: number; y: number } | null): void {
  assertWrite()
  commit((d) => {
    const e = storyMap(d, kind)[id] as Beat | Scene | Shot | undefined
    if (!e || e.deleted) return
    if (pos) {
      if (e.pos && e.pos.x === pos.x && e.pos.y === pos.y) return
      e.pos = { x: pos.x, y: pos.y }
    } else {
      if (!e.pos) return
      delete e.pos
    }
    touchStory(kind, e)
  })
}

/** A ref's graph position — refs are array entries (entry-level LWW stamps,
 *  never touch()). */
export function setRefPos(refId: string, pos: { x: number; y: number } | null): void {
  assertWrite()
  commit((d) => {
    const r = (d.refs ?? []).find((x) => x.id === refId)
    if (!r || r.deleted) return
    if (pos) {
      if (r.pos && r.pos.x === pos.x && r.pos.y === pos.y) return
      r.pos = { x: pos.x, y: pos.y }
    } else {
      if (!r.pos) return
      delete r.pos
    }
    r.updatedAt = hlcNow()
    r.writerId = writerId()
  })
}

// ---------------------------------------------------------------------------
// References — saved external links per project. Top-level doc.refs array
// (uploadLinks model): entries carry their own updatedAt/writerId LWW stamps
// and are merged per-entry in sync/merge.ts. NEVER touch() an entry — touch()
// indexes the scratch set by EntityMapName and reassertPending writes
// doc[map][id], a Record write that would corrupt an array. Soft delete +
// entry-level LWW makes tombstones unnecessary, same as uploadLinks'
// revokedAt.
// ---------------------------------------------------------------------------

const REF_URL_MAX = 2048
const REF_TEXT_MAX = 300

const cleanRefUrl = (raw: string): string => {
  const url = raw.trim().slice(0, REF_URL_MAX)
  if (!/^https?:\/\//i.test(url)) throw new Error('The link must start with http:// or https://')
  return url
}

export function createRef(fields: { projectId: string; url: string; title?: string; note?: string }): string {
  assertWrite()
  const url = cleanRefUrl(fields.url)
  const project = storeGet().doc?.projects[fields.projectId]
  if (!project || project.deleted) throw new Error('Project not found')
  const id = newRefId()
  commit((d) => {
    const ref: Ref = {
      id,
      projectId: fields.projectId,
      url,
      title: (fields.title ?? '').trim().slice(0, REF_TEXT_MAX),
      note: (fields.note ?? '').trim().slice(0, 2000),
      createdAt: hlcNow(),
      updatedAt: hlcNow(),
      writerId: writerId(),
      deleted: null,
    }
    d.refs = [...(d.refs ?? []), ref]
    appendActivity(d, 'ref.create', fields.projectId, { refId: id, title: ref.title || ref.url })
  })
  return id
}

export function updateRef(id: string, fields: { url?: string; title?: string; note?: string }): boolean {
  assertWrite()
  let changed = false
  commit((d) => {
    const r = d.refs?.find((x) => x.id === id)
    if (!r || r.deleted) return
    if (fields.url !== undefined) r.url = cleanRefUrl(fields.url)
    if (fields.title !== undefined) r.title = fields.title.trim().slice(0, REF_TEXT_MAX)
    if (fields.note !== undefined) r.note = fields.note.trim().slice(0, 2000)
    r.updatedAt = hlcNow()
    r.writerId = writerId()
    appendActivity(d, 'ref.update', r.projectId ?? id, { refId: id, title: r.title || r.url })
    changed = true
  })
  return changed
}

export function deleteRef(id: string): boolean {
  assertWrite()
  let changed = false
  commit((d) => {
    const r = d.refs?.find((x) => x.id === id)
    if (!r || r.deleted) return
    r.deleted = { at: hlcNow(), by: writerId() }
    r.updatedAt = hlcNow() // LWW: the delete must beat any in-flight older edit
    r.writerId = writerId()
    appendActivity(d, 'ref.delete', r.projectId ?? id, { refId: id, title: r.title || r.url })
    changed = true
  })
  return changed
}

// ---------------------------------------------------------------------------
// P7 — project discussion + approvals
// ---------------------------------------------------------------------------

const COMMENT_MAX = 4000

/** Post a comment on a project. Viewers can READ the thread but not write —
 *  comments are writer-only, same as every other mutation. */
export function createComment(projectId: string, body: string): string {
  assertWrite()
  const text = body.trim().slice(0, COMMENT_MAX)
  if (!text) throw new Error('Write something first')
  const project = storeGet().doc?.projects[projectId]
  if (!project || project.deleted) throw new Error('Project not found')
  const id = newCommentId()
  commit((d) => {
    const comment: Comment = {
      id,
      projectId,
      body: text,
      by: sessionActor(),
      createdAt: hlcNow(),
      updatedAt: hlcNow(),
      writerId: writerId(),
      deleted: null,
    }
    d.comments = [...(d.comments ?? []), comment]
    appendActivity(d, 'project.comment', projectId, { commentId: id, excerpt: text.slice(0, 80) })
  })
  return id
}

/** Soft-delete a comment (author or admin — enforced in the UI; the kernel
 *  treats it as an ordinary soft delete). */
export function deleteComment(id: string): boolean {
  assertWrite()
  let changed = false
  commit((d) => {
    const c = d.comments?.find((x) => x.id === id)
    if (!c || c.deleted) return
    c.deleted = { at: hlcNow(), by: writerId() }
    c.updatedAt = hlcNow() // LWW: the delete must beat any in-flight older edit
    c.writerId = writerId()
    appendActivity(d, 'project.comment-delete', c.projectId, { commentId: id })
    changed = true
  })
  return changed
}

/** Approve / unapprove a project — the single-slot LWW field. */
export function setProjectApproval(projectId: string, approved: boolean): void {
  assertWrite()
  commit((d) => {
    const p = d.projects[projectId]
    if (!p || p.deleted) throw new Error('Project not found')
    p.approved = approved ? { at: hlcNow(), by: sessionActor() } : null
    touch('projects', p)
    appendActivity(d, approved ? 'project.approve' : 'project.unapprove', projectId, {
      name: p.name,
      approvedBy: sessionActor(),
    })
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
): Promise<{ raw: string; synced: boolean }> {
  assertAdmin()
  let auth: NexusDoc['users']['app'][number]['auth']
  let raw: string
  const salt = storeGet().doc?.settings.authStretchSalt
  if (!salt) throw new Error('Workspace predates stretched logins — ask an admin to re-save this login')
  if (secret === undefined) {
    const minted = await mintToken()
    // Tokens stretch too: loginWithSecret stretches whatever is typed, so the
    // stored hash must be sha256(stretch(raw)) — same protocol as passwords.
    auth = await stretchedAuth(minted.raw, salt)
    raw = minted.raw
  } else {
    const policyError = passwordPolicyError(secret)
    if (policyError) throw new Error(policyError)
    auth = await stretchedAuth(secret, salt)
    raw = secret
  }
  const id = newUserId()
  const by = sessionModule().getSession()?.appUserId ?? 'pending'
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
        createdBy: by,
        updatedAt: hlcNow(),
        writerId: writerId(),
      },
    ]
    appendActivity(doc, 'user.create', id, { name, role })
  })
  // User creation must not sit in the debounce window — a refresh there loses
  // the account (and its secret). Write through now.
  const synced = await flush()
  return { raw, synced }
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
    // Kick active sessions: the signed token carries the OLD role, and
    // stillValid only re-checks existence/disabled/epoch — without the bump
    // a demoted editor would keep write access until their 12h token died.
    user.sessionEpoch = (user.sessionEpoch ?? 0) + 1
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

export async function resetUserPassword(userId: string, secret: string | undefined): Promise<{ raw: string; synced: boolean }> {
  assertAdmin()
  let auth: NexusDoc['users']['app'][number]['auth']
  let raw: string
  const salt = storeGet().doc?.settings.authStretchSalt
  if (!salt) throw new Error('Workspace predates stretched logins — ask an admin to re-save this login')
  if (secret === undefined) {
    const minted = await mintToken()
    auth = await stretchedAuth(minted.raw, salt)
    raw = minted.raw
  } else {
    const policyError = passwordPolicyError(secret)
    if (policyError) throw new Error(policyError)
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
  // Same as creation: the new secret must reach Drive before it's shown.
  const synced = await flush()
  return { raw, synced }
}

export async function mintViewerToken(name: string, note = '', scope = ''): Promise<{ raw: string; id: string }> {
  assertAdmin()
  if (scope && !storeGet().doc?.projects[scope]) throw new Error('Scope project not found')
  const { raw, hash } = await mintToken()
  const id = newViewerId()
  const by = sessionModule().getSession()?.appUserId ?? 'pending'
  commit((doc) => {
    doc.users.viewers = [
      ...doc.users.viewers,
      {
        id, name, tokenHash: hash, createdAt: hlcNow(), createdBy: by,
        revokedAt: null, note, updatedAt: hlcNow(), writerId: writerId(),
        // Omit when whole-workspace — absent and '' mean the same thing, and
        // writing the empty default would diverge the D1 shadow diff (the
        // regen omits it, pre-P8 docs never had it).
        ...(scope ? { scope } : {}),
      },
    ]
    appendActivity(doc, 'viewer.create', id, { name, scope: scope || 'all' })
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

// ---------------------------------------------------------------------------
// Guest upload links — one project + one media section, no login. The raw
// token is shown ONCE (like viewer tokens); only its sha256 hash is stored,
// and the server derives the upload destination from the link, never from
// the guest's request.
// ---------------------------------------------------------------------------

export async function createUploadLink(
  projectId: string,
  sectionId: string,
  expiresInDays: 1 | 7 | 30,
  maxFileBytes: number,
  note = '',
): Promise<{ raw: string; linkId: string; synced: boolean }> {
  assertWrite()
  const project = storeGet().doc?.projects[projectId]
  if (!project || project.deleted) throw new Error('Project not found')
  if (!project.mediaSections.some((s) => s.id === sectionId)) {
    throw new Error('Pick one of the project’s media sections for this link')
  }
  await ensureProjectFolder(projectId)
  if (!storeGet().doc?.projects[projectId]?.folderId) {
    throw new Error('Project folder not ready — try again in a few seconds')
  }
  const { raw, hash } = await mintToken()
  const id = newUploadLinkId()
  const link: UploadLink = {
    id,
    tokenHash: hash,
    projectId,
    sectionId,
    maxFileBytes,
    note,
    createdAt: hlcNow(),
    createdBy: sessionModule().getSession()?.appUserId ?? 'pending',
    expiresAt: new Date(Date.now() + expiresInDays * 86_400_000).toISOString(),
    revokedAt: null,
    updatedAt: hlcNow(),
    writerId: writerId(),
  }
  commit((d) => {
    d.uploadLinks = [...(d.uploadLinks ?? []), link]
    appendActivity(d, 'uploadlink.create', projectId, { sectionId, expiresInDays, maxFileBytes })
  })
  // The secret must reach storage before it is shown — same as user creation.
  const synced = await flush()
  return { raw, linkId: id, synced }
}

export async function revokeUploadLink(linkId: string): Promise<boolean> {
  assertWrite()
  const doc = storeGet().doc
  if (!doc?.uploadLinks?.some((l) => l.id === linkId)) throw new Error('Link not found')
  commit((d) => {
    const l = d.uploadLinks?.find((x) => x.id === linkId)
    if (!l || l.revokedAt) return
    l.revokedAt = hlcNow()
    l.updatedAt = hlcNow()
    l.writerId = writerId()
    appendActivity(d, 'uploadlink.revoke', l.projectId, { linkId })
  })
  return await flush()
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

/**
 * Adopt a snapshot as the current doc. Keeps our write identity and a bumped
 * rev, then primes `base` with the remote's current tokens so the next flush
 * takes the unchanged fast path and overwrites storage with exactly this
 * content. The snapshot itself stays as the pre-restore backup.
 */
export async function restoreSnapshot(fileId: string): Promise<void> {
  assertAdmin()
  const { readFile, getMeta, copyFile } = await import('../drive/client')
  const { parseDoc } = await import('../types/schema')
  const store = storeGet()
  const nexusId = store.doc?.ids.nexusFileId
  if (!nexusId) throw new Error('Workspace file id unknown')
  const raw = await readFile(fileId)
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
    const currentRaw = await readFile(nexusId)
    if (currentRaw !== raw) {
      const backup = await copyFile(
        nexusId,
        `pre-restore-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`,
        SYSTEM_PREFIXES.snapshots,
      )
      restored.snapshots = [
        ...restored.snapshots,
        { fileId: backup.id, rev: store.doc?.rev ?? 0, at: new Date().toISOString(), by: writerId(), note: 'pre-restore' },
      ]
    }
  } catch {
    /* best-effort — restore proceeds without the extra copy */
  }
  const meta = await getMeta(nexusId)
  store.setDoc(restored)
  store.setBase({ headRevisionId: meta.headRevisionId, md5Checksum: meta.md5Checksum, version: meta.version })
  markContentDirty() // setDoc bypassed commit() — the restore MUST write
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
  if (!canWrite()) return // viewers/anonymous tabs must not archive (writes would fail and banner)
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

  // Storage side: trash group prefixes (contain all project files) + script files.
  const { trashFile } = await import('../drive/client')
  for (const g of groups) {
    if (g.folderId) await trashFile(g.folderId).catch(() => {})
  }
  for (const s of scripts) {
    if (s.storage.type === 'md' && s.storage.fileId) {
      await trashFile(s.storage.fileId).catch(() => {})
    }
    for (const c of s.copies) await trashFile(c.fileId).catch(() => {})
  }

  commit((d) => {
    d.groups = {}
    d.projects = {}
    d.scripts = {}
    d.beats = {}
    d.scenes = {}
    d.shots = {}
    d.storyLinks = []
    d.refs = []
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
