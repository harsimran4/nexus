// IndexedDB mirror of the dirty scratch doc. This is LOAD-BEARING, not
// optional: keepalive fetches die above 64KB (verified cap), so a tab closed
// mid-debounce with a large doc recovers its edits from here on next boot.

import type { NexusDoc } from '../types/schema'

const DB_NAME = 'nexus'
const STORE = 'kv'
const DRAFT_KEY = 'scratch'
const RECOVERY_KEY = 'recovery'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB unavailable'))
  })
  return dbPromise
}

async function idbRun<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    const req = fn(tx.objectStore(STORE))
    req.onsuccess = () => resolve(req.result as T)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
  })
}

export async function saveDraft(doc: NexusDoc): Promise<void> {
  try {
    await idbRun('readwrite', (s) => s.put({ doc, savedAt: new Date().toISOString() }, DRAFT_KEY))
  } catch {
    /* private-mode browsers can block IndexedDB — debounce window shrinks, nothing else breaks */
  }
}

export async function loadDraft(): Promise<{ doc: NexusDoc; savedAt: string } | null> {
  try {
    const v = await idbRun<{ doc: NexusDoc; savedAt: string } | undefined>('readonly', (s) => s.get(DRAFT_KEY))
    return v ?? null
  } catch {
    return null
  }
}

export async function clearDraft(): Promise<void> {
  try {
    await idbRun('readwrite', (s) => s.delete(DRAFT_KEY))
  } catch {
    /* ignore */
  }
}

/** Stash a recovered-but-not-yet-recommitted draft so the user can decide later. */
export async function parkRecovery(payload: { doc: NexusDoc; savedAt: string }): Promise<void> {
  try {
    await idbRun('readwrite', (s) => s.put(payload, RECOVERY_KEY))
  } catch {
    /* ignore */
  }
}
export async function takeRecovery(): Promise<{ doc: NexusDoc; savedAt: string } | null> {
  try {
    const v = await idbRun<{ doc: NexusDoc; savedAt: string } | undefined>('readonly', (s) => s.get(RECOVERY_KEY))
    if (v) await idbRun('readwrite', (s) => s.delete(RECOVERY_KEY))
    return v ?? null
  } catch {
    return null
  }
}

// --- unsaved script bodies (survive tab closes, like entity drafts) ---

const SCRIPT_DRAFT_PREFIX = 'scriptDraft:'

export async function loadScriptDraft(id: string): Promise<string | null> {
  try {
    const v = await idbRun<{ body: string } | undefined>('readonly', (s) => s.get(SCRIPT_DRAFT_PREFIX + id))
    return v?.body ?? null
  } catch {
    return null
  }
}

export async function saveScriptDraft(id: string, body: string): Promise<void> {
  try {
    await idbRun('readwrite', (s) => s.put({ body, savedAt: new Date().toISOString() }, SCRIPT_DRAFT_PREFIX + id))
  } catch {
    /* ignore */
  }
}

export async function clearScriptDraft(id: string): Promise<void> {
  try {
    await idbRun('readwrite', (s) => s.delete(SCRIPT_DRAFT_PREFIX + id))
  } catch {
    /* ignore */
  }
}

// --- workspace-id memory (localStorage, synchronous at boot) ---

export function rememberIds(ids: { rootFolderId: string; nexusFileId: string }): void {
  try {
    localStorage.setItem('nexus.lastGoodIds', JSON.stringify(ids))
  } catch {
    /* ignore */
  }
}

export function recallIds(): { rootFolderId: string; nexusFileId: string } | null {
  try {
    const raw = localStorage.getItem('nexus.lastGoodIds')
    if (!raw) return null
    const ids = JSON.parse(raw)
    if (typeof ids?.rootFolderId === 'string' && typeof ids?.nexusFileId === 'string') return ids
  } catch {
    /* ignore */
  }
  return null
}
