// Pure parse/serialize for the project page's URL view state — the route's
// validateSearch runs parseMediaView so hand-edited URLs can't crash the
// page: every unknown value silently falls back to the default downstream.
// Unit-tested in tests/mediaUrl.test.ts.

import type { MediaKind, MediaSort } from './media'

export type ProjectTab = 'media' | 'scripts' | 'settings'

export interface MediaViewUrl {
  tab?: ProjectTab
  /** Section id, 'unsorted', or 'all'. */
  section?: string
  kind?: MediaKind | 'all'
  sort?: MediaSort
  /** Name search, clamped — URLs are shared, not a data store. */
  q?: string
  /** File open in the lightbox (storage key) — deep-linkable. */
  file?: string
}

const TABS: ProjectTab[] = ['media', 'scripts', 'settings']
const KINDS: (MediaKind | 'all')[] = ['all', 'image', 'video', 'audio', 'other']
const SORTS: MediaSort[] = ['date-desc', 'date-asc', 'name-asc', 'name-desc', 'size-desc', 'size-asc']
// Links minted before the date sorts existed carry the legacy names — read
// them as their replacements instead of dropping the viewer's context.
const SORT_ALIASES: Record<string, MediaSort> = { 'added-desc': 'date-desc', 'added-asc': 'date-asc' }

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)

/** Accepts a raw search record (validateSearch) or an already-typed view
 *  (re-parsing before a navigate). */
export function parseMediaView(search: Record<string, unknown> | MediaViewUrl): MediaViewUrl {
  const s = search as Record<string, unknown>
  const tab = str(s.tab)
  const kind = str(s.kind)
  const rawSort = str(s.sort)
  const q = str(s.q)
  return {
    tab: tab && TABS.includes(tab as ProjectTab) ? (tab as ProjectTab) : undefined,
    section: str(s.section),
    kind: kind && KINDS.includes(kind as MediaKind | 'all') ? (kind as MediaKind | 'all') : undefined,
    sort: rawSort
      ? SORTS.includes(rawSort as MediaSort)
        ? (rawSort as MediaSort)
        : SORT_ALIASES[rawSort]
      : undefined,
    q: q ? q.slice(0, 100) : undefined,
    file: str(s.file),
  }
}

/** URL search object holding only non-default values — keeps share links
 *  short and stops default filter churn from writing history entries. */
export function serializeMediaView(view: MediaViewUrl): Record<string, string> {
  const out: Record<string, string> = {}
  if (view.tab && view.tab !== 'media') out.tab = view.tab
  if (view.section && view.section !== 'all') out.section = view.section
  if (view.kind && view.kind !== 'all') out.kind = view.kind
  if (view.sort && view.sort !== 'date-desc') out.sort = view.sort
  if (view.q) out.q = view.q
  if (view.file) out.file = view.file
  return out
}
