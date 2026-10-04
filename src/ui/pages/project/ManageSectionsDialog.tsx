import { useState } from 'react'
import { confirmDialog } from '../../components/ConfirmDialog'
import { Modal } from '../../components/Modal'
import { toast } from '../../components/Toast'
import { Icon } from '../../components/Icon'
import { removeMediaSection, renameMediaSection } from '../../../state/actions'
import { reorderMediaSections } from '../../../state/actions'
import type { MediaSection } from '../../../types/schema'

/** Manage sections: rename, reorder (← → — accessible and merge-safe; no
 *  drag), delete. Deleting a section sends its files to Unsorted in the same
 *  commit. */
export function ManageSectionsDialog({ projectId, sections, counts, activeSection, onSectionRemoved, onClose }: {
  projectId: string
  sections: MediaSection[]
  /** Per-section file counts for the delete copy. */
  counts: Record<string, number>
  /** Currently viewed section — delete-confirm copy and fallbacks need it. */
  activeSection: string
  onSectionRemoved: (id: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')

  const commitRename = (id: string) => {
    if (editingId !== id) return
    const v = editingName.trim()
    setEditingId(null)
    if (!v || v === sections.find((s) => s.id === id)?.name) return
    try {
      renameMediaSection(projectId, id, v)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Rename failed')
    }
  }

  const remove = async (id: string) => {
    const s = sections.find((x) => x.id === id)
    if (!s) return
    const n = counts[id] ?? 0
    const ok = await confirmDialog({
      title: `Delete section “${s.name}”?`,
      body: (
        <div className="confirm-body">
          <div className="confirm-what">
            Its {n} file{n === 1 ? '' : 's'} move to Unsorted — nothing is deleted.
          </div>
        </div>
      ),
      confirmLabel: 'Delete section',
      tone: 'danger',
    })
    if (!ok) return
    try {
      removeMediaSection(projectId, id)
      if (activeSection === id) onSectionRemoved(id)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  const reorder = (id: string, dir: -1 | 1) => {
    try {
      reorderMediaSections(projectId, id, dir)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Reorder failed')
    }
  }

  return (
    <Modal title="Manage sections" onClose={onClose}>
      {sections.length === 0 ? (
        <p className="muted small">No sections yet — create one with “New” in the tab strip above.</p>
      ) : (
        sections.map((s, i) => (
          <div key={s.id} className="manage-section-row">
            {editingId === s.id ? (
              <input
                className="input"
                value={editingName}
                autoFocus
                onChange={(e) => setEditingName(e.target.value)}
                onKeyDown={(e) => {
                  // Stop the key here — the Modal's window handler must not
                  // close the whole dialog over an inline edit.
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    setEditingId(null)
                  }
                  if (e.key === 'Enter') {
                    e.stopPropagation()
                    commitRename(s.id)
                  }
                }}
                onBlur={() => commitRename(s.id)}
                aria-label="Section name"
              />
            ) : (
              <span className="manage-section-name">
                {s.name} <span className="faint small">({counts[s.id] ?? 0})</span>
              </span>
            )}
            <span className="row manage-section-actions">
              <button
                className="btn small ghost"
                title="Move earlier"
                aria-label={`Move ${s.name} earlier`}
                disabled={i === 0}
                onClick={() => reorder(s.id, -1)}
              >
                <Icon name="chevron-left" size={13} />
              </button>
              <button
                className="btn small ghost"
                title="Move later"
                aria-label={`Move ${s.name} later`}
                disabled={i === sections.length - 1}
                onClick={() => reorder(s.id, 1)}
              >
                <Icon name="chevron-right" size={13} />
              </button>
              <button
                className="btn small ghost"
                title="Rename section"
                aria-label={`Rename ${s.name}`}
                onClick={() => {
                  setEditingId(s.id)
                  setEditingName(s.name)
                }}
              >
                <Icon name="pencil" size={13} />
              </button>
              <button
                className="btn small ghost"
                title="Delete section"
                aria-label={`Delete ${s.name}`}
                onClick={() => void remove(s.id)}
              >
                <Icon name="trash" size={13} />
              </button>
            </span>
          </div>
        ))
      )}
    </Modal>
  )
}
