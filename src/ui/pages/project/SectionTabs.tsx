import { useState } from 'react'
import type { MediaSection } from '../../../types/schema'
import { UNSORTED } from '../../../util/media'
import { Icon } from '../../components/Icon'

/** Section strip — manila folder tabs inside the project folder. 'All' is
 *  everything; Unsorted (files no section claims) only earns a tab once it
 *  has residents or is active. */
export function SectionTabs({ sections, counts, active, writable, onSelect, onCreate, onManage }: {
  sections: MediaSection[]
  counts: Record<string, number>
  active: string
  writable: boolean
  onSelect: (id: string) => void
  onCreate: (name: string) => void
  onManage: () => void
}): React.JSX.Element {
  const [drafting, setDrafting] = useState<string | null>(null)
  const showUnsorted = active === UNSORTED || (counts[UNSORTED] ?? 0) > 0

  const create = () => {
    const v = (drafting ?? '').trim()
    setDrafting(null)
    if (v) onCreate(v)
  }

  return (
    <div className="media-tabs">
      <button className={`media-tab${active === 'all' ? ' on' : ''}`} aria-pressed={active === 'all'} onClick={() => onSelect('all')}>
        All<span className="count">{counts['all'] ?? 0}</span>
      </button>
      {sections.map((s) => (
        <button key={s.id} className={`media-tab${active === s.id ? ' on' : ''}`} aria-pressed={active === s.id} onClick={() => onSelect(s.id)}>
          {s.name}
          <span className="count">{counts[s.id] ?? 0}</span>
        </button>
      ))}
      {showUnsorted && (
        <button className={`media-tab${active === UNSORTED ? ' on' : ''}`} aria-pressed={active === UNSORTED} onClick={() => onSelect(UNSORTED)}>
          Unsorted<span className="count">{counts[UNSORTED] ?? 0}</span>
        </button>
      )}
      {writable &&
        (drafting === null ? (
          <button className="media-tab media-tab-new" title="New section" onClick={() => setDrafting('')}>
            <Icon name="plus" size={13} /> New
          </button>
        ) : (
          <input
            className="input"
            style={{ width: 150, padding: '2px 9px', fontSize: 13, alignSelf: 'center' }}
            placeholder="Section name…"
            value={drafting}
            autoFocus
            onChange={(e) => setDrafting(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') create()
              if (e.key === 'Escape') setDrafting(null)
            }}
            onBlur={create}
          />
        ))}
      {writable && (
        <button className="media-tab-manage" title="Rename, reorder, or delete sections" onClick={onManage}>
          Manage sections
        </button>
      )}
    </div>
  )
}
