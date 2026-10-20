// P6 — the last good BOOT snapshot in IndexedDB. boot.ts paints it before the
// network answers (instant repeat loads) and keeps it on screen, labelled
// Offline, when revalidation fails. Writers update it after every confirmed
// remote read, so it tracks the freshest server truth the tab has seen.
//
// Everything here is best-effort: private-mode browsers can block IndexedDB,
// and a missing cache just means yesterday's boot (network-first, blocking).

import { idbRun } from './idb'

const SNAPSHOT_KEY = 'bootSnapshot'

export interface BootSnapshot {
  raw: string
  at: string
}

export async function loadBootSnapshot(): Promise<BootSnapshot | null> {
  try {
    const v = await idbRun<BootSnapshot | undefined>('readonly', (s) => s.get(SNAPSHOT_KEY))
    return v && typeof v.raw === 'string' ? v : null
  } catch {
    return null
  }
}

export async function putBootSnapshot(raw: string): Promise<void> {
  try {
    await idbRun('readwrite', (s) => s.put({ raw, at: new Date().toISOString() }, SNAPSHOT_KEY))
  } catch {
    /* best-effort */
  }
}

export async function clearBootSnapshot(): Promise<void> {
  try {
    await idbRun('readwrite', (s) => s.delete(SNAPSHOT_KEY))
  } catch {
    /* best-effort */
  }
}
