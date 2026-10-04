// Unit tests for util/media.ts — the pure filter/sort logic behind the
// project Media tab. No Drive I/O, no React; everything is deterministic.

import { describe, expect, it } from 'vitest'
import {
  KIND_GLYPH,
  UNSORTED,
  buildItems,
  extFromKey,
  fileSizeBytes,
  filterAndSort,
  formatBytes,
  formatRelative,
  kindFromMime,
  totalSize,
  type MediaItem,
} from '../src/util/media'
import type { FileMeta } from '../src/drive/client'

const item = (over: Partial<MediaItem> & { fileId: string }): MediaItem => ({
  name: over.fileId,
  mime: undefined,
  size: null,
  index: 0,
  pending: false,
  ...over,
})

describe('kindFromMime', () => {
  it('classifies by mime prefix', () => {
    expect(kindFromMime('image/png')).toBe('image')
    expect(kindFromMime('video/mp4')).toBe('video')
    expect(kindFromMime('audio/mpeg')).toBe('audio')
    expect(kindFromMime('application/pdf')).toBe('other')
    expect(kindFromMime('application/vnd.google-apps.document')).toBe('other')
  })

  it('treats missing mime as other', () => {
    expect(kindFromMime(undefined)).toBe('other')
  })

  it('glyphs exist for every kind', () => {
    for (const k of ['image', 'video', 'audio', 'other'] as const) {
      expect(KIND_GLYPH[k].length).toBeGreaterThan(0)
    }
  })
})

describe('fileSizeBytes / formatBytes', () => {
  it('coerces Drive int64 strings', () => {
    expect(fileSizeBytes('1048576')).toBe(1048576)
    expect(fileSizeBytes(512)).toBe(512)
  })

  it('returns null for missing or garbage sizes, keeps 0', () => {
    expect(fileSizeBytes(undefined)).toBeNull()
    expect(fileSizeBytes('abc')).toBeNull()
    expect(fileSizeBytes(-5)).toBeNull()
    expect(fileSizeBytes(0)).toBe(0)
  })

  it('formats human sizes; unknown renders as em dash', () => {
    expect(formatBytes(null)).toBe('—')
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536 * 1024)).toBe('1.5 MB')
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB')
  })
})

describe('buildItems', () => {
  it('maps fileIds with meta, preserving order as index', () => {
    const meta: Record<string, FileMeta> = {
      a: { id: 'a', name: 'shot.mp4', mimeType: 'video/mp4', size: '2048' },
    }
    const items = buildItems(['a', 'b'], meta)
    expect(items[0]).toEqual({ fileId: 'a', name: 'shot.mp4', mime: 'video/mp4', size: 2048, index: 0, pending: false })
    // missing meta → pending (cards skeleton; the raw key never shows as a name)
    expect(items[1]).toEqual({ fileId: 'b', name: 'b', mime: undefined, size: null, index: 1, pending: true })
  })

  it('carries modifiedTime as epoch ms when parseable', () => {
    const meta: Record<string, FileMeta> = {
      a: { id: 'a', name: 'a.png', modifiedTime: '2026-01-02T03:04:05.000Z' },
      b: { id: 'b', name: 'b.png', modifiedTime: 'not a date' },
    }
    const items = buildItems(['a', 'b'], meta)
    expect(items[0].modified).toBe(Date.parse('2026-01-02T03:04:05.000Z'))
    expect(items[1].modified).toBeUndefined()
  })
})

describe('date sorts', () => {
  const T = (iso: string) => Date.parse(iso)
  const items: MediaItem[] = [
    item({ fileId: 'old', name: 'old.png', index: 0, modified: T('2026-01-01T00:00:00Z') }),
    item({ fileId: 'new', name: 'new.png', index: 1, modified: T('2026-03-01T00:00:00Z') }),
    item({ fileId: 'mid', name: 'mid.png', index: 2, modified: T('2026-02-01T00:00:00Z') }),
  ]
  const view = (sort: string) =>
    filterAndSort(items, { search: '', kind: 'all', section: 'all', sectionOf: {}, sort: sort as 'date-desc' })
      .map((i) => i.fileId)

  it('date sorts by modifiedTime', () => {
    expect(view('date-desc')).toEqual(['new', 'mid', 'old'])
    expect(view('date-asc')).toEqual(['old', 'mid', 'new'])
  })

  it('items without meta count as oldest; index breaks ties', () => {
    const mixed: MediaItem[] = [
      item({ fileId: 'known', name: 'known.png', index: 0, modified: T('2026-01-01T00:00:00Z') }),
      item({ fileId: 'pending-b', name: 'b', index: 1 }),
      item({ fileId: 'pending-a', name: 'a', index: 2 }),
    ]
    const got = (sort: string) =>
      filterAndSort(mixed, { search: '', kind: 'all', section: 'all', sectionOf: {}, sort: sort as 'date-desc' })
        .map((i) => i.fileId)
    expect(got('date-desc')).toEqual(['known', 'pending-a', 'pending-b'])
    expect(got('date-asc')).toEqual(['pending-b', 'pending-a', 'known'])
  })

  it('all-pending behaves like the old index order', () => {
    const pending: MediaItem[] = [
      item({ fileId: 'a', name: 'a', index: 0 }),
      item({ fileId: 'b', name: 'b', index: 1 }),
    ]
    const got = (sort: string) =>
      filterAndSort(pending, { search: '', kind: 'all', section: 'all', sectionOf: {}, sort: sort as 'date-desc' })
        .map((i) => i.fileId)
    expect(got('date-desc')).toEqual(['b', 'a'])
    expect(got('date-asc')).toEqual(['a', 'b'])
  })
})

describe('formatRelative', () => {
  const now = Date.parse('2026-03-15T12:00:00Z')
  const ago = (s: number) => new Date(now - s * 1000).getTime()
  it('buckets seconds→minutes→hours→days→weeks→months→years', () => {
    expect(formatRelative(now, now)).toBe('now')
    expect(formatRelative(ago(30), now)).toBe('now')
    expect(formatRelative(ago(5 * 60), now)).toBe('5m')
    expect(formatRelative(ago(3 * 3600), now)).toBe('3h')
    expect(formatRelative(ago(2 * 86400), now)).toBe('2d')
    expect(formatRelative(ago(2 * 7 * 86400), now)).toBe('2w')
    expect(formatRelative(ago(4 * 30 * 86400), now)).toBe('4mo')
    expect(formatRelative(ago(2 * 365 * 86400), now)).toBe('2y')
  })
  it('clamps future timestamps to now', () => {
    expect(formatRelative(now + 60_000, now)).toBe('now')
  })
})

describe('extFromKey', () => {
  it('reads the extension from the name segment of a media key', () => {
    expect(extFromKey('groups/g1/p1/f_ab12__clip.mp4')).toBe('MP4')
    expect(extFromKey('groups/g1/p1/f_ab12__Photo Final.JPG')).toBe('JPG')
  })
  it('handles keys without the id__name shape or extension', () => {
    expect(extFromKey('snapshots/plainname')).toBe('')
    expect(extFromKey('groups/g/p/f_ab12__noext')).toBe('')
    // dotfile-style names read as extensionless
    expect(extFromKey('groups/g/p/f_ab12__.hidden')).toBe('')
  })
})

describe('filterAndSort', () => {
  const items: MediaItem[] = [
    item({ fileId: 'a', name: 'Alpha take.mp4', mime: 'video/mp4', size: 300, index: 0 }),
    item({ fileId: 'b', name: 'banner.png', mime: 'image/png', size: 500, index: 1 }),
    item({ fileId: 'c', name: 'notes.pdf', mime: 'application/pdf', size: 100, index: 2 }),
    item({ fileId: 'd', name: 'Voiceover.mp3', mime: 'audio/mpeg', size: null, index: 3 }),
  ]
  const base = { search: '', kind: 'all' as const, sort: 'added-desc' as const }
  const view = (over: Partial<Parameters<typeof filterAndSort>[1]>) =>
    filterAndSort(items, { ...base, section: 'all', sectionOf: {}, ...over })

  it('search is a case-insensitive name substring', () => {
    expect(view({ search: 'ALPH' }).map((i) => i.fileId)).toEqual(['a'])
  })

  it('filters by kind', () => {
    expect(view({ kind: 'video' }).map((i) => i.fileId)).toEqual(['a'])
    expect(view({ kind: 'other' }).map((i) => i.fileId)).toEqual(['c'])
  })

  it('filters by section; unsorted means no mediaSectionOf entry', () => {
    const sectionOf = { a: 's1', c: 's1', b: 's2' }
    expect(
      filterAndSort(items, { ...base, sort: 'added-asc', section: 's1', sectionOf }).map((i) => i.fileId),
    ).toEqual(['a', 'c'])
    expect(filterAndSort(items, { ...base, section: UNSORTED, sectionOf }).map((i) => i.fileId)).toEqual(['d'])
  })

  it('sorts by name case-insensitively both ways', () => {
    const names = (s: string) => view({ sort: s as 'name-asc' | 'name-desc' }).map((i) => i.fileId)
    expect(names('name-asc')).toEqual(['a', 'b', 'c', 'd'])
    expect(names('name-desc')).toEqual(['d', 'c', 'b', 'a'])
  })

  it('added order follows insertion index', () => {
    expect(view({ sort: 'added-desc' }).map((i) => i.fileId)).toEqual(['d', 'c', 'b', 'a'])
    expect(view({ sort: 'added-asc' }).map((i) => i.fileId)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('unknown sizes trail in BOTH size directions', () => {
    const ids = (s: string) => view({ sort: s as 'size-desc' | 'size-asc' }).map((i) => i.fileId)
    expect(ids('size-desc')).toEqual(['b', 'a', 'c', 'd'])
    expect(ids('size-asc')).toEqual(['c', 'a', 'b', 'd'])
  })

  it('combines filters with AND', () => {
    const sectionOf = { a: 's1' }
    const got = filterAndSort(items, {
      ...base,
      search: 'take',
      kind: 'video',
      section: 's1',
      sectionOf,
      sort: 'name-asc',
    })
    expect(got.map((i) => i.fileId)).toEqual(['a'])
    // same view but wrong section -> nothing
    expect(
      filterAndSort(items, { ...base, search: 'take', kind: 'video', section: 's2', sectionOf, sort: 'name-asc' }),
    ).toEqual([])
  })
})

describe('totalSize', () => {
  it('sums known sizes and counts unknowns', () => {
    const items = [
      item({ fileId: 'a', size: 100 }),
      item({ fileId: 'b', size: 23 }),
      item({ fileId: 'c', size: null }),
    ]
    expect(totalSize(items)).toEqual({ known: 123, unknownCount: 1 })
  })
})
