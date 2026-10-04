import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import { formatBytes, KIND_GLYPH, KIND_LABEL, totalSize, type MediaItem, type MediaSort } from '../../../util/media'
import type { MediaViewUrl } from '../../../util/mediaUrl'
import type { ResolvedMediaView } from './mediaView'

const SORT_OPTIONS: { value: MediaSort; label: string }[] = [
  { value: 'date-desc', label: 'Newest first' },
  { value: 'date-asc', label: 'Oldest first' },
  { value: 'name-asc', label: 'Name A→Z' },
  { value: 'name-desc', label: 'Name Z→A' },
  { value: 'size-desc', label: 'Size: large → small' },
  { value: 'size-asc', label: 'Size: small → large' },
]

/** Toolbar: search (debounced, with clear), kind chips, sort, count, actions.
 *  Own grid layout replaces the old one-row squeeze the phone CSS had to
 *  fight with !important. */
export function MediaToolbar({ view, setView, items, shownCount, totalCount, selectMode, writable, onUpload, onShare, onToggleSelect }: {
  view: ResolvedMediaView
  setView: (patch: Partial<Omit<MediaViewUrl, 'tab'>>) => void
  items: MediaItem[]
  shownCount: number
  totalCount: number
  selectMode: boolean
  writable: boolean
  onUpload: () => void
  onShare: () => void
  onToggleSelect: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(view.q)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const totals = totalSize(items)

  // Keep the draft in sync when the URL changes underneath (Back/Forward).
  useEffect(() => {
    setDraft(view.q)
  }, [view.q])

  const onSearch = (v: string) => {
    setDraft(v)
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => setView({ q: v }), 250)
  }
  useEffect(() => () => {
    if (debounce.current) clearTimeout(debounce.current)
  }, [])

  return (
    <div className="media-toolbar">
      <div className="media-toolbar-search">
        <Icon name="search" size={14} className="media-toolbar-search-ic" />
        <input
          className="input media-toolbar-input"
          placeholder="Search by name…"
          value={draft}
          onChange={(e) => onSearch(e.target.value)}
          aria-label="Search files by name"
        />
        {draft && (
          <button className="media-toolbar-clear" aria-label="Clear search" onClick={() => onSearch('')}>
            <Icon name="x" size={12} />
          </button>
        )}
        {draft && <span className="media-toolbar-matches">{shownCount} match{shownCount === 1 ? '' : 'es'}</span>}
      </div>
      <div className="media-toolbar-row">
        <div className="chips" role="group" aria-label="Filter by type">
          {(['all', 'image', 'video', 'audio', 'other'] as const).map((k) => (
            <button key={k} className={`chip ${view.kind === k ? 'on' : ''}`} aria-pressed={view.kind === k} onClick={() => setView({ kind: k })}>
              {k === 'all' ? 'All types' : `${KIND_GLYPH[k]} ${KIND_LABEL[k]}`}
            </button>
          ))}
        </div>
        <select
          className="input media-toolbar-sort"
          value={view.sort}
          onChange={(e) => setView({ sort: e.target.value as MediaSort })}
          aria-label="Sort files"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>
      <div className="media-toolbar-row media-toolbar-foot">
        <span className="media-count">
          {shownCount} of {totalCount} file{totalCount === 1 ? '' : 's'} · {formatBytes(totals.known)}
          {totals.unknownCount > 0 ? ` + ${totals.unknownCount} unknown` : ''}
        </span>
        {totalCount > 1000 && <span className="media-toolbar-note">showing first 1000</span>}
        <span className="media-toolbar-actions">
          {writable && (
            <button className="btn primary" onClick={onUpload}>
              <Icon name="upload" size={14} /> Upload
            </button>
          )}
          {writable && (
            <button className="btn" title="Guests upload via a link — no login needed" onClick={onShare}>
              <Icon name="link" size={14} /> Share link
            </button>
          )}
          <button className="btn" onClick={onToggleSelect}>
            <Icon name="check-square" size={14} /> {selectMode ? 'Done' : 'Select'}
          </button>
        </span>
      </div>
    </div>
  )
}
