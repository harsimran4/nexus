// Pure helpers behind the project Media tab — no React, no Drive I/O, so the
// filter/sort logic is unit-testable (see tests/media.test.ts).

import type { FileMeta } from '../drive/client'

export type MediaKind = 'image' | 'video' | 'audio' | 'other'

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
}

export function buildItems(fileIds: string[], meta: Record<string, FileMeta>): MediaItem[] {
  return fileIds.map((fileId, index) => {
    const m = meta[fileId]
    return {
      fileId,
      name: m?.name ?? fileId,
      mime: m?.mimeType,
      size: fileSizeBytes(m?.size),
      index,
    }
  })
}

export type MediaSort = 'name-asc' | 'name-desc' | 'added-desc' | 'added-asc' | 'size-desc' | 'size-asc'

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
  const sorted = [...filtered]
  switch (view.sort) {
    case 'name-asc':
      sorted.sort(byName)
      break
    case 'name-desc':
      sorted.sort((a, b) => byName(b, a))
      break
    case 'added-desc':
      sorted.sort((a, b) => b.index - a.index)
      break
    case 'added-asc':
      sorted.sort((a, b) => a.index - b.index)
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
