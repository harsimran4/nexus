// First-run workspace bootstrap + the system-folder layout:
//   <Root>/master/nexus.json · snapshots/ · projects/<Project>/ · scripts/ · Unsorted/
// Drive has no atomic create, so two clients racing #/init can both create
// nexus.json — the rule is list-by-name and adopt the OLDEST createdTime.

import { createAnyoneReaderPermission, createFolder, createJsonFile, listChildren, moveFile, trashFile, type Credential, type FileMeta } from './client'
import { emptyDoc, type NexusDoc } from '../types/schema'
import { writerId } from '../sync/identity'
import { hlcNow } from '../util/hlc'

export interface Workspace {
  rootFolderId: string
  nexusFileId: string | null
}

export interface SystemFolders {
  master?: string
  snapshots?: string
  groups?: string
  scripts?: string
}

const FOLDER_MIME = "mimeType = 'application/vnd.google-apps.folder'"

/** Find an existing workspace by name under a known root (or, for a signed-in
 *  user, at Drive's top level). Key-only callers without a root can't search
 *  Drive root at all ("root" means someone's My Drive) — return null quietly. */
export async function findWorkspace(knownRootId: string, cred: Credential): Promise<Workspace | null> {
  if (knownRootId) {
    return { rootFolderId: knownRootId, nexusFileId: await findNexusInRoot(knownRootId, cred) }
  }
  // No root known — the 'root' alias only resolves for a signed-in user.
  const { hasBearer } = await import('./client')
  if (cred.mode === 'key' || !hasBearer()) return null
  const res = await listChildren('root', cred, {
    query: FOLDER_MIME + " and (name = 'Nexus Root' or name = 'Nexus')",
  })
  if (res.files.length === 0) return null
  const root = oldestByCreated(res.files)
  return { rootFolderId: root.id, nexusFileId: await findNexusInRoot(root.id, cred) }
}

/** nexus.json may sit in master/ (current layout) or at the root (legacy). */
async function findNexusInRoot(rootFolderId: string, cred: Credential): Promise<string | null> {
  const master = await listChildren(rootFolderId, cred, { query: FOLDER_MIME + " and name = 'master'" })
  if (master.files.length > 0) {
    const inner = await listChildren(master.files[0].id, cred, { query: "name = 'nexus.json'" })
    if (inner.files.length > 0) return oldestByCreated(inner.files).id
  }
  const res = await listChildren(rootFolderId, cred, { query: "name = 'nexus.json'" })
  return res.files.length > 0 ? oldestByCreated(res.files).id : null
}

function oldestByCreated(files: { id: string; createdTime?: string }[]): { id: string; createdTime?: string } {
  return [...files].sort((a, b) => (a.createdTime ?? '').localeCompare(b.createdTime ?? ''))[0]
}

/** Find-or-create one of the system folders by its fixed name inside the root. */
async function ensureSystemFolder(rootId: string, name: string, cred: Credential): Promise<string> {
  const res = await listChildren(rootId, cred, { query: FOLDER_MIME + ` and name = '${name}'` })
  if (res.files.length > 0) return res.files[0].id
  const folder = await createFolder(name, rootId, cred)
  return folder.id
}

/** Ensure all system folders exist; returns their IDs. */
export async function ensureSystemFolders(rootId: string, cred: Credential): Promise<SystemFolders> {
  const names: (keyof SystemFolders)[] = ['master', 'snapshots', 'groups', 'scripts']
  const out: SystemFolders = {}
  for (const name of names) {
    out[name] = await ensureSystemFolder(rootId, name, cred)
  }
  return out
}

/** One-time migration for pre-layout workspaces: create missing system
 *  folders, move nexus.json into master/, record everything. */
export async function migrateWorkspaceFolders(cred: Credential): Promise<{ movedNexus: boolean; created: string[] }> {
  const { storeGet, useStore } = await import('../sync/store')
  const doc = storeGet().doc
  if (!doc) throw new Error('Workspace not loaded')
  const rootId = doc.ids.rootFolderId
  if (!rootId) throw new Error('Workspace root unknown')

  const created: string[] = []
  const existing = doc.ids.systemFolders ?? {}
  const folders: SystemFolders = { ...existing }
  for (const name of ['master', 'snapshots', 'groups', 'scripts'] as const) {
    if (folders[name]) {
      const check = await listChildren(rootId, cred, { query: FOLDER_MIME + ` and name = '${name}'` })
      if (check.files.some((f) => f.id === folders[name])) continue // still there
    }
    folders[name] = await ensureSystemFolder(rootId, name, cred)
    created.push(name)
  }

  // Move nexus.json into master/ when it isn't there already.
  let movedNexus = false
  const masterId = folders.master!
  const inMaster = await listChildren(masterId, cred, { query: "name = 'nexus.json'" })
  if (inMaster.files.length === 0) {
    await moveFile(doc.ids.nexusFileId, masterId, rootId, cred)
    movedNexus = true
  }

  useStore.getState().setDoc({
    ...doc,
    ids: { ...doc.ids, systemFolders: folders },
  })
  const { commitQuiet } = await import('../sync/writer')
  commitQuiet((d) => {
    d.ids = { ...d.ids, systemFolders: folders }
    d.updatedAt = hlcNow()
    d.writerId = writerId()
  })
  return { movedNexus, created }
}

export function workspaceUsesSystemFolders(doc: NexusDoc): boolean {
  const f = doc.ids.systemFolders
  return Boolean(f?.master && f.groups && f.scripts && f.snapshots)
}

/** Create the full workspace: root (reused when the folder already exists),
 *  link-share, system folders, nexus.json in master/. */
export async function createWorkspace(
  doc: NexusDoc,
  cred: Credential,
  existingRootId?: string | null,
): Promise<Workspace> {
  let shared = true
  let root: FileMeta
  if (existingRootId) {
    // Re-init into an existing folder: don't create or re-share it.
    root = { id: existingRootId, name: doc.settings.rootFolderName }
  } else {
    root = await createFolder(doc.settings.rootFolderName, null, cred)
    try {
      await createAnyoneReaderPermission(root.id, cred) // children inherit
    } catch {
      // Workspace org policies can block anyone-links (cannotShareDriveItem) —
      // the UI falls back to printed manual-share instructions.
      shared = false
    }
  }
  const folders = await ensureSystemFolders(root.id, cred)
  const nexus = await createJsonFile('nexus.json', folders.master!, JSON.stringify(doc), cred)
  let nexusFileId = nexus.id
  try {
    // Adopt-oldest: if another client raced us, everyone converges on one file.
    const res = await listChildren(folders.master!, cred, { query: "name = 'nexus.json'" })
    if (res.files.length > 1) {
      const oldest = oldestByCreated(res.files)
      if (oldest.id !== nexusFileId) {
        // The oldest file wins; if it parses, adopt it (it may hold the other
        // client's admin user). Otherwise keep ours and trash theirs.
        const { readFile, trashFile } = await import('./client')
        const { parseDoc } = await import('../types/schema')
        const raw = await readFile(oldest.id, cred).catch(() => null)
        if (raw && parseDoc(raw).ok) {
          nexusFileId = oldest.id
          await trashFile(nexus.id, cred).catch(() => {})
        } else {
          await trashFile(oldest.id, cred).catch(() => {})
        }
      }
    }
  } catch {
    /* quarantine is best-effort; the app only ever talks to nexusFileId */
  }
  const finalDoc: NexusDoc = {
    ...doc,
    ids: { rootFolderId: root.id, nexusFileId, systemFolders: folders },
  }
  await rewriteDoc(finalDoc, nexusFileId, cred)
  return { rootFolderId: root.id, nexusFileId, ...(shared ? {} : { needsManualShare: true }) } as Workspace & {
    needsManualShare?: boolean
  }
}

async function rewriteDoc(doc: NexusDoc, nexusId: string, cred: Credential): Promise<void> {
  const { writeFileJson } = await import('./client')
  await writeFileJson(nexusId, JSON.stringify(doc), cred)
}

export function initialDoc(): NexusDoc {
  return emptyDoc()
}

/** Resolve the snapshots folder: recorded ID → find-or-create by name. */
export async function ensureSnapshotsFolder(doc: NexusDoc, cred: Credential): Promise<string> {
  if (doc.ids.systemFolders?.snapshots) return doc.ids.systemFolders.snapshots
  return ensureSystemFolder(doc.ids.rootFolderId, 'snapshots', cred)
}

/** Resolve the scripts folder (milestone copies + script bodies). */
export async function ensureScriptsFolder(doc: NexusDoc, cred: Credential): Promise<string> {
  if (doc.ids.systemFolders?.scripts) return doc.ids.systemFolders.scripts
  return ensureSystemFolder(doc.ids.rootFolderId, 'scripts', cred)
}

/** Resolve the groups parent folder (contains one subfolder per group). */
export async function ensureGroupsFolder(doc: NexusDoc, cred: Credential): Promise<string> {
  if (doc.ids.systemFolders?.groups) return doc.ids.systemFolders.groups
  return ensureSystemFolder(doc.ids.rootFolderId, 'groups', cred)
}

/** Duplicate nexus.json (bootstrap race) — keep the oldest, trash the rest. */
export async function quarantineDuplicates(rootFolderId: string, keepId: string, cred: Credential): Promise<number> {
  const res = await listChildren(rootFolderId, cred, { query: "name = 'nexus.json'" })
  let trashed = 0
  for (const f of oldestByCreatedAll(res.files)) {
    if (f.id !== keepId) {
      try {
        await trashFile(f.id, cred)
        trashed++
      } catch {
        /* leave it; the app only ever talks to keepId */
      }
    }
  }
  return trashed
}

function oldestByCreatedAll<T extends { createdTime?: string }>(files: T[]): T[] {
  return [...files].sort((a, b) => (a.createdTime ?? '').localeCompare(b.createdTime ?? ''))
}

export function freshDocStamps(doc: NexusDoc): NexusDoc {
  return { ...doc, writerId: writerId(), updatedAt: hlcNow() }
}
