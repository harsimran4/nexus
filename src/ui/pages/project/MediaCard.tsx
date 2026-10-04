import { useRef } from 'react'
import { Menu, MenuItem } from '../../components/Menu'
import { Icon } from '../../components/Icon'
import { Skeleton } from '../../components/Skeleton'
import { MediaThumb } from '../../MediaThumb'
import { formatBytes, formatRelative, type MediaItem } from '../../../util/media'

/** One media card — a print pinned to the board. The tape, tilt, and wobble
 *  selection ring survive; execution is tokenized (--media-tilt/--media-tape
 *  in styles.css dial the personality from CSS alone).

Interaction model:
- thumb click → preview (lightbox); ctrl/⌘+click or shift+click → select
- in select mode the thumb toggles selection instead
- hover reveals Download + an overflow menu (Rename / Move / Delete); on
  touch devices the menu button is always visible (no hover-only affordance)
- three real tab stops: preview button, checkbox, menu trigger */
export function MediaCard({ item, sectionName, showSection, selected, selectMode, renaming, downloadPct, writable, onPreview, onToggleSelect, onRangeSelect, onDownload, onRenameStart, onRenameCommit, onRenameCancel, onMove, onDelete }: {
  item: MediaItem
  /** Section label shown in the All view. */
  sectionName?: string
  showSection: boolean
  selected: boolean
  selectMode: boolean
  renaming: boolean
  downloadPct: number | null | undefined
  writable: boolean
  onPreview: () => void
  onToggleSelect: () => void
  /** shift+click — select the range from the last touched card. */
  onRangeSelect: () => void
  onDownload: () => void
  onRenameStart: () => void
  onRenameCommit: (name: string) => void
  onRenameCancel: () => void
  onMove: () => void
  onDelete: () => void
}): React.JSX.Element {
  // Hooks before any early return — the skeleton path renders on the SAME
  // instance (key=fileId) that later renders the full card, so the hook
  // count must never change between them.
  const renamed = useRef(false)
  if (item.pending) {
    return (
      <article className="media-card" aria-label="Loading file">
        <Skeleton className="media-card-thumb" />
        <Skeleton className="media-card-line" />
        <Skeleton className="media-card-line short" />
      </article>
    )
  }

  // Videos show a poster; audio/documents show their glyph tile inside the
  // thumb — the kind badge stays only where the thumbnail could be mistaken.
  const ext = item.name.includes('.') ? item.name.slice(item.name.lastIndexOf('.') + 1).toUpperCase().slice(0, 5) : ''
  // The rename input commits on Enter AND on blur — unmounting fires blur
  // after Enter, and after an Escape cancel. One commit wins; the rest no-op.
  const commitRename = (value: string) => {
    if (renamed.current) return
    renamed.current = true
    onRenameCommit(value)
  }
  const cancelRename = () => {
    renamed.current = true // the unmount-blur must not commit a cancelled rename
    onRenameCancel()
  }

  const thumbClick = (e: React.MouseEvent) => {
    if (e.shiftKey) {
      e.preventDefault()
      onRangeSelect()
      return
    }
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault()
      onToggleSelect()
      return
    }
    if (selectMode) onToggleSelect()
    else onPreview()
  }

  return (
    <article className={`media-card${selected ? ' sel' : ''}${selectMode ? ' selectable' : ''}`}>
      <div className="media-card-thumb">
        <button
          className="media-card-preview"
          onClick={thumbClick}
          aria-label={selectMode ? `Toggle selection of ${item.name}` : `Preview ${item.name}`}
          title={item.name}
        >
          <MediaThumb fileKey={item.fileId} alt={item.name} mime={item.mime} />
        </button>
        {ext && (
          <span className="media-card-ext" aria-hidden="true">{ext}</span>
        )}
        {!selectMode && (
          <div className="media-card-hover">
            <button
              className="media-card-hover-btn"
              title="Download"
              aria-label={`Download ${item.name}`}
              disabled={downloadPct !== undefined}
              onClick={onDownload}
            >
              <Icon name={downloadPct !== undefined ? 'clock' : 'download'} size={14} />
            </button>
            {writable && (
              <Menu
                label={`More actions for ${item.name}`}
                trigger={({ ref, onClick, 'aria-expanded': expanded, 'aria-haspopup': popup }) => (
                  <button
                    ref={ref}
                    onClick={onClick}
                    aria-expanded={expanded}
                    aria-haspopup={popup}
                    className="media-card-hover-btn"
                    title="More actions"
                    aria-label={`More actions for ${item.name}`}
                  >
                    <Icon name="dots" size={14} />
                  </button>
                )}
              >
                <MenuItem icon="pencil" onSelect={onRenameStart}>Rename</MenuItem>
                <MenuItem icon="move" onSelect={onMove}>Move to…</MenuItem>
                <MenuItem icon="trash" tone="danger" onSelect={onDelete}>Delete</MenuItem>
              </Menu>
            )}
          </div>
        )}
        <input
          type="checkbox"
          className="media-card-check"
          checked={selected}
          onChange={onToggleSelect}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Select ${item.name}`}
          title="Select"
        />
        {downloadPct !== undefined && (
          <div className={`progress dl-progress${downloadPct === null ? ' indeterminate' : ''}`}>
            <div style={{ width: `${downloadPct ?? 0}%` }} />
          </div>
        )}
      </div>
      {renaming ? (
        <input
          className="input media-card-rename"
          defaultValue={item.name}
          autoFocus
          onFocus={(e) => {
            // Select the stem, leave the extension — rename semantics people expect.
            const dot = item.name.lastIndexOf('.')
            e.target.setSelectionRange(0, dot > 0 ? dot : item.name.length)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename((e.target as HTMLInputElement).value)
            if (e.key === 'Escape') cancelRename()
          }}
          onBlur={(e) => commitRename(e.target.value)}
          aria-label="File name"
        />
      ) : (
        <div className="media-card-name" title={item.name}>{item.name}</div>
      )}
      <div className="media-meta">
        {formatBytes(item.size)}
        {item.modified !== undefined && (
          <span title={new Date(item.modified).toLocaleString()}> · {formatRelative(item.modified)}</span>
        )}
        {showSection && sectionName ? ` · ${sectionName}` : ''}
      </div>
    </article>
  )
}
