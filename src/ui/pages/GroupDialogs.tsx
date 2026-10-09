import { useState } from 'react'
import { useStore } from '../../sync/store'
import type { Group } from '../../types/schema'
import { Icon, Modal, banner, toast } from '../components'
import { renameGroup, deleteGroupCascade } from '../../state/actions'

/** Rename + cascade-delete dialogs shared by the Groups list and the group
 *  detail page — one implementation so the two pages can't drift apart.
 *  Hooks all run before the early returns (the doc can vanish mid-render
 *  when a sync lands). */

export function GroupRenameModal({ group, onClose }: { group: Group; onClose: () => void }): React.JSX.Element {
  const [name, setName] = useState(group.name)
  const [error, setError] = useState<string | null>(null)

  const save = (): void => {
    const n = name.trim()
    if (!n || n === group.name) return
    try {
      renameGroup(group.id, n)
      toast.success(`Renamed to “${n}”`)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not rename the group')
    }
  }

  return (
    <Modal title={`Rename “${group.name}”`} onClose={onClose}>
      <p className="muted small" style={{ marginTop: 0 }}>
        Renaming only changes the label here — nothing moves on Drive.
      </p>
      <div className="field">
        <label>Group name</label>
        <input
          className="input"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
        />
      </div>
      {error && banner('error', 'Could not rename', error)}
      <div className="row mt16" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!name.trim() || name.trim() === group.name} onClick={save}>Save</button>
      </div>
    </Modal>
  )
}

export function GroupDeleteModal({ groupId, onClose, onDeleted }: {
  groupId: string
  onClose: () => void
  /** Runs after the cascade completes — the detail page navigates away, the list just re-renders. */
  onDeleted?: () => void
}): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const group = doc?.groups[groupId]
  if (!doc || !group) return <></>

  // The cascade trashes the whole group folder, archived projects included —
  // so they are listed here too, not just the ones still on the board.
  const projects = Object.values(doc.projects).filter((p) => p.groupId === groupId && p.deleted === null)
  const fileCount = projects.reduce((n, p) => n + p.fileIds.length, 0)

  return (
    <Modal title={`Delete group “${group.name}”?`} onClose={onClose} wide>
      {banner('warn', 'Everything inside moves to trash/', 'The group folder — every project and file inside it — moves to the trash. All projects in the group also leave the board.')}
      <div className="field">
        <label>What will be trashed:</label>
        <div className="trash-tree">
          <div className="trash-tree-head">
            <span className="row" style={{ gap: 7 }}>
              <Icon name="folder" size={13} />
              {group.name}/
            </span>
            <span className="faint small">group folder</span>
          </div>
          {projects.map((p) => (
            <div key={p.id} className="trash-tree-row small">
              <Icon name={p.fileIds.length > 0 ? 'file-text' : 'file'} size={12} />
              <span>
                {p.name}
                <span className="faint"> · {p.fileIds.length} file{p.fileIds.length === 1 ? '' : 's'}</span>
                {p.archivedAt !== null && <span className="faint"> · archived</span>}
              </span>
            </div>
          ))}
          {projects.length === 0 && <div className="trash-tree-empty faint small">No projects inside.</div>}
        </div>
        <div className="muted small mt8">
          {projects.length} project{projects.length === 1 ? '' : 's'} · {fileCount} file{fileCount === 1 ? '' : 's'}
        </div>
      </div>
      {error && banner('error', 'Delete failed', error)}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await deleteGroupCascade(groupId)
              toast.success(`“${group.name}” and everything inside moved to trash`)
              onDeleted?.()
              onClose()
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Delete failed')
              setBusy(false)
            }
          }}
        >
          {busy ? 'Deleting…' : 'Move everything to trash'}
        </button>
      </div>
    </Modal>
  )
}
