// Selection state for the Media grid — a module store keyed by projectId,
// mirrored to sessionStorage so a refresh keeps the selection. The URL
// deliberately does NOT carry it: storage keys run ~50 chars, and a
// 50-file selection would bloat every shared link by kilobytes.

import { useSyncExternalStore } from 'react'

const key = (projectId: string): string => `nexus.sel.${projectId}`

const EMPTY: Set<string> = new Set()
let selections: Record<string, Set<string>> = {}
const subs = new Set<() => void>()

function emit(): void {
  for (const fn of subs) fn()
}

function load(projectId: string): Set<string> {
  let sel = selections[projectId]
  if (!sel) {
    sel = new Set()
    selections[projectId] = sel
    try {
      const raw = sessionStorage.getItem(key(projectId))
      if (raw) for (const id of JSON.parse(raw) as string[]) sel.add(id)
    } catch {
      // private-mode quota errors etc. — selection just won't survive refresh
    }
  }
  return sel
}

function persist(projectId: string, sel: Set<string>): void {
  try {
    sessionStorage.setItem(key(projectId), JSON.stringify([...sel]))
  } catch {
    // non-fatal — in-memory selection still works
  }
}

export function subscribeSelection(fn: () => void): () => void {
  subs.add(fn)
  return () => {
    subs.delete(fn)
  }
}

export function getSelection(projectId: string): Set<string> {
  return load(projectId)
}

/** Every write REPLACES the Set — useSyncExternalStore compares snapshots by
 *  reference, so mutating the cached Set in place would never re-render
 *  (the same contract uploads.ts documents on its batch object). */
function mutate(projectId: string, fn: (sel: Set<string>) => Iterable<string> | void): void {
  const prev = load(projectId)
  const next = new Set(prev)
  const out = fn(next)
  selections[projectId] = out instanceof Set ? out : next
  persist(projectId, selections[projectId])
  emit()
}

export function toggleSelected(projectId: string, fileId: string): void {
  mutate(projectId, (sel) => {
    if (sel.has(fileId)) sel.delete(fileId)
    else sel.add(fileId)
  })
}

export function setSelection(projectId: string, ids: Iterable<string>): void {
  mutate(projectId, (sel) => {
    sel.clear()
    for (const id of ids) sel.add(id)
  })
}

export function clearSelection(projectId: string): void {
  mutate(projectId, (sel) => {
    sel.clear()
  })
}

/** Drop entries whose files are gone (bulk delete / peer delete). */
export function pruneSelection(projectId: string, validIds: ReadonlySet<string>): void {
  mutate(projectId, (sel) => {
    for (const id of [...sel]) if (!validIds.has(id)) sel.delete(id)
  })
}

const getSnapshot = (projectId: string) => (): Set<string> => load(projectId)

export function useMediaSelection(projectId: string): Set<string> {
  return useSyncExternalStore(subscribeSelection, getSnapshot(projectId), () => EMPTY)
}
