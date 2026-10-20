// Notification center — persistent, dismissible records of things that
// happened while you were looking elsewhere (guest uploads completing,
// later: snapshot restores, share-link activity). localStorage-backed so the
// digest survives reloads; capped at 50; ids are caller-supplied so the same
// event can't record twice.

import { useSyncExternalStore } from 'react'

export interface Notice {
  id: string
  kind: 'guest-upload' | 'system'
  title: string
  body: string
  at: string
  read: boolean
}

const KEY = 'nexus.notifications'
const CAP = 50

let items: Notice[] = load()
const subs = new Set<() => void>()

function load(): Notice[] {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as Notice[]).slice(0, CAP) : []
  } catch {
    return []
  }
}

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(items))
  } catch {
    /* private mode — the center degrades to in-memory */
  }
}

function emit(): void {
  for (const fn of subs) fn()
}

/** Record an event. Same id = same event: repeats update nothing. */
export function pushNotice(n: { id: string; kind: Notice['kind']; title: string; body: string }): void {
  if (items.some((i) => i.id === n.id)) return
  items = [{ ...n, at: new Date().toISOString(), read: false }, ...items].slice(0, CAP)
  persist()
  emit()
}

export function markAllRead(): void {
  if (!items.some((i) => !i.read)) return
  items = items.map((i) => (i.read ? i : { ...i, read: true }))
  persist()
  emit()
}

export function clearNotices(): void {
  if (items.length === 0) return
  items = []
  persist()
  emit()
}

const subscribe = (fn: () => void): (() => void) => {
  subs.add(fn)
  return () => subs.delete(fn)
}
const getSnapshot = (): Notice[] => items
const getServerSnapshot = (): Notice[] => []

export function useNotices(): Notice[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

const getUnread = (): number => items.filter((i) => !i.read).length

export function useUnreadCount(): number {
  return useSyncExternalStore(subscribe, getUnread, () => 0)
}
