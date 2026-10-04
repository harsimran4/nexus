// Pure helpers behind the project Media tab — no React, no Drive I/O, so the
// filter/sort logic is unit-testable (see tests/media.test.ts).

import type { FileMeta } from '../drive/client'

export type MediaKind = 'image' | 'video' | 'audio' | 'other'

/** Thumbnail object key for a media key — `thumbs/<id>.jpg`, derived from the
 *  id segment (stable across renames since ids never change). Null for keys
 *  without the `<id>__<name>` shape (snapshots, doc copies…). */
export function thumbKeyFor(mediaKey: string): string | null {
  const base = mediaKey.slice(mediaKey.lastIndexOf('/') + 1)
  const id = base.split('__')[0]
  if (!base.includes('__') || !id) return null
  return `thumbs/${id}.jpg`
}

export function kindFromMime(mime: string | undefined): MediaKind {
  if (!mime) return 'other'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return 'other'
}

export const KIND_GLYPH: Record<MediaKind, string> = {
  image: '🖼',
  video: '🎬',
  audio: '🎧',
  other: '📄',
}

export const KIND_LABEL: Record<MediaKind, string> = {
  image: 'Images',
  video: 'Videos',
  audio: 'Audio',
  other: 'Other',
}

/** Drive v3 ships int64 fields as strings; Google-Docs-type files omit size. */
export function fileSizeBytes(size: string | number | undefined): number | null {
  if (size === undefined) return null
  const n = Number(size)
  return Number.isFinite(n) && n >= 0 ? n : null
}

export function formatBytes(n: number | null): string {
  if (n === null) return '—'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n
  let u = -1
  do {
    v /= 1024
    u++
  } while (v >= 1024 && u < units.length - 1)
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`
}

export interface MediaItem {
  fileId: string
  name: string
  mime?: string
  size: number | null
  /** Position in the project's fileIds — proxy for "date added". */
  index: number
  /** No meta yet — the card renders a skeleton until it lands (never the raw key). */
  pending: boolean
  /** meta.modifiedTime as epoch ms, when known. */
  modified?: number
}

export function buildItems(fileIds: string[], meta: Record<string, FileMeta>): MediaItem[] {
  return fileIds.map((fileId, index) => {
    const m = meta[fileId]
    const modified = m?.modifiedTime !== undefined ? Date.parse(m.modifiedTime) : NaN
    return {
      fileId,
      name: m?.name ?? fileId,
      mime: m?.mimeType,
      size: fileSizeBytes(m?.size),
      index,
      pending: m === undefined,
      ...(Number.isFinite(modified) ? { modified } : {}),
    }
  })
}

/** Extension in upper case from a storage key's name segment ('MP4'), or ''
 *  when the name has none. */
export function extFromKey(key: string): string {
  const name = key.slice(key.lastIndexOf('/') + 1)
  const base = name.includes('__') ? name.slice(name.indexOf('__') + 2) : name
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toUpperCase().slice(0, 5) : ''
}

/** Compact relative age ('now', '35m', '2h', '3d', '5w', '4mo', '1y').
 *  `now` is injectable for tests; future timestamps clamp to 'now'. */
export function formatRelative(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000))
  if (s < 45) return 'now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  const w = Math.floor(d / 7)
  if (d < 30) return `${w}w`
  const mo = Math.floor(d / 30)
  if (d < 365) return `${mo}mo`
  return `${Math.floor(d / 365)}y`
}

export type MediaSort =
  | 'date-desc'
  | 'date-asc'
  | 'name-asc'
  | 'name-desc'
  | 'size-desc'
  | 'size-asc'
  // legacy names kept until the Media tab switches over (accepted as aliases
  // by the URL parser); date-* replaces them.
  | 'added-desc'
  | 'added-asc'

/** The implicit pseudo-section for files without a mediaSectionOf entry. */
export const UNSORTED = 'unsorted'

export interface MediaView {
  search: string
  kind: MediaKind | 'all'
  section: string // section id, UNSORTED, or 'all'
  sort: MediaSort
}

export function filterAndSort(
  items: MediaItem[],
  view: Pick<MediaView, 'search' | 'kind' | 'sort'> & { section: string; sectionOf: Record<string, string> },
): MediaItem[] {
  const q = view.search.trim().toLowerCase()
  const filtered = items.filter((it) => {
    if (q && !it.name.toLowerCase().includes(q)) return false
    if (view.kind !== 'all' && kindFromMime(it.mime) !== view.kind) return false
    if (view.section !== 'all') {
      const assigned = view.sectionOf[it.fileId]
      if (view.section === UNSORTED ? assigned : assigned !== view.section) return false
    }
    return true
  })
  const byName = (a: MediaItem, b: MediaItem) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  // "Added" time: meta.modifiedTime when known; items without meta yet count
  // as oldest (index breaks ties) — never mix epoch-ms with array positions.
  const added = (it: MediaItem): number => it.modified ?? -1
  const sorted = [...filtered]
  switch (view.sort) {
    case 'name-asc':
      sorted.sort(byName)
      break
    case 'name-desc':
      sorted.sort((a, b) => byName(b, a))
      break
    case 'date-desc':
    case 'added-desc':
      sorted.sort((a, b) => added(b) - added(a) || b.index - a.index)
      break
    case 'date-asc':
    case 'added-asc':
      sorted.sort((a, b) => added(a) - added(b) || a.index - b.index)
      break
    case 'size-desc':
      // Unknown sizes trail in BOTH size directions; name breaks ties.
      sorted.sort((a, b) => (b.size ?? -1) - (a.size ?? -1) || byName(a, b))
      break
    case 'size-asc':
      sorted.sort((a, b) => (a.size ?? Infinity) - (b.size ?? Infinity) || byName(a, b))
      break
  }
  return sorted
}

export function totalSize(items: MediaItem[]): { known: number; unknownCount: number } {
  let known = 0
  let unknownCount = 0
  for (const it of items) {
    if (it.size === null) unknownCount++
    else known += it.size
  }
  return { known, unknownCount }
}
