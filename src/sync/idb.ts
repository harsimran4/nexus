// Shared IndexedDB plumbing (the 'nexus' DB, one 'kv' object store). Used by
// the load-bearing scratch-draft mirror (drafts.ts) and the P6 boot snapshot
// cache (bootCache.ts). Kept tiny on purpose — private-mode browsers can
// block IndexedDB, so EVERY caller treats failures as best-effort.

let dbPromise: Promise<IDBDatabase> | null = null

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open('nexus', 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB unavailable'))
  })
  return dbPromise
}

export async function idbRun<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction('kv', mode)
    const req = fn(tx.objectStore('kv'))
    req.onsuccess = () => resolve(req.result as T)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
  })
}
