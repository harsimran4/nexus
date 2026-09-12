// First-run workspace bootstrap. Drive has no atomic create, so two clients
// racing #/init can both create nexus.json — the rule is list-by-name and
// adopt the OLDEST createdTime, quarantining losers to /snapshots/duplicates/.

import { createAnyoneReaderPermission, createFolder, createJsonFile, listChildren, trashFile, type Credential } from './client'
import { emptyDoc, type NexusDoc } from '../types/schema'
import { writerId } from '../sync/identity'
import { hlcNow } from '../util/hlc'

export interface Workspace {
  rootFolderId: string
  nexusFileId: string | null
}

/** Find an existing workspace by name under a known root (or everywhere we can see). */
export async function findWorkspace(knownRootId: string, cred: Credential): Promise<Workspace | null> {
  if (knownRootId) {
    const res = await listChildren(knownRootId, cred, { query: "name = 'nexus.json'" })
    if (res.files.length > 0) {
      const oldest = oldestByCreated(res.files)
      return { rootFolderId: knownRootId, nexusFileId: oldest.id }
    }
    return { rootFolderId: knownRootId, nexusFileId: null }
  }
  // No root known — look for the root folder by name at Drive's top level.
  const res = await listChildren('root', cred, {
    query: "name = 'Nexus Root' and mimeType = 'application/vnd.google-apps.folder'",
  })
  if (res.files.length === 0) return null
  const root = oldestByCreated(res.files)
  const inner = await listChildren(root.id, cred, { query: "name = 'nexus.json'" })
  return { rootFolderId: root.id, nexusFileId: inner.files.length ? oldestByCreated(inner.files).id : null }
}

function oldestByCreated(files: { id: string; createdTime?: string }[]): { id: string; createdTime?: string } {
  return [...files].sort((a, b) => (a.createdTime ?? '').localeCompare(b.createdTime ?? ''))[0]
}

/** Create the full workspace: root folder, link-share, nexus.json, snapshots folder. */
export async function createWorkspace(doc: NexusDoc, cred: { mode: 'bearer' }): Promise<Workspace> {
  const root = await createFolder(doc.settings.rootFolderName, null, cred)
  let shared = true
  try {
    await createAnyoneReaderPermission(root.id, cred) // children inherit
  } catch {
    // Workspace org policies can block anyone-links (cannotShareDriveItem) —
    // the UI falls back to printed manual-share instructions.
    shared = false
  }
  const nexus = await createJsonFile('nexus.json', root.id, JSON.stringify(doc), cred)
  const finalDoc: NexusDoc = { ...doc, ids: { rootFolderId: root.id, nexusFileId: nexus.id } }
  await rewriteDoc(finalDoc, nexus.id, cred)
  await createFolder('snapshots', root.id, cred)
  return { rootFolderId: root.id, nexusFileId: nexus.id, ...(shared ? {} : { needsManualShare: true }) } as Workspace & {
    needsManualShare?: boolean
  }
}

async function rewriteDoc(doc: NexusDoc, nexusId: string, cred: { mode: 'bearer' }): Promise<void> {
  const { writeFileJson } = await import('./client')
  await writeFileJson(nexusId, JSON.stringify(doc), cred)
}

export function initialDoc(): NexusDoc {
  return emptyDoc()
}

export async function ensureSnapshotsFolder(rootFolderId: string, cred: { mode: 'bearer' }): Promise<string> {
  const res = await listChildren(rootFolderId, cred, { query: "name = 'snapshots'" })
  if (res.files.length > 0) return res.files[0].id
  const folder = await createFolder('snapshots', rootFolderId, cred)
  return folder.id
}

/** Duplicate nexus.json (bootstrap race) — keep the oldest, trash the rest. */
export async function quarantineDuplicates(rootFolderId: string, keepId: string, cred: { mode: 'bearer' }): Promise<number> {
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
