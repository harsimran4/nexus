import { useState } from 'react'
import { useStore } from '../../sync/store'
import type { Group } from '../../types/schema'
import { GROUP_COLOR_KEYS, GROUP_COLOR_NAMES } from '../../util/groups'
import { Icon, Modal, banner, toast } from '../components'
import { renameGroup, setGroupColor, deleteGroupCascade } from '../../state/actions'

/** Rename + cascade-delete dialogs shared by the Groups list and the group
 *  detail page — one implementation so the two pages can't drift apart.
 *  Hooks all run before the early returns (the doc can vanish mid-render
 *  when a sync lands). */

/** Swatch row for group.color: Auto, the 8 sticky shades, or None. Real
 *  buttons, so Tab + Enter work; aria-pressed marks the selection. */
export function GroupColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }): React.JSX.Element {
  return (
    <div className="field">
      <label>Color</label>
      <div className="swatch-row">
        <button
          type="button"
          className={`swatch auto${value === '' ? ' on' : ''}`}
          title="Auto — assign an unused shade"
          aria-label="Auto — assign an unused shade"
          aria-pressed={value === ''}
          onClick={() => onChange('')}
        />
        {GROUP_COLOR_KEYS.map((k) => (
          <button
            key={k}
            type="button"
            className={`swatch ${k}${value === k ? ' on' : ''}`}
            style={{ background: `var(--${k})` }}
            title={GROUP_COLOR_NAMES[k]}
            aria-label={GROUP_COLOR_NAMES[k]}
            aria-pressed={value === k}
            onClick={() => onChange(k)}
          />
        ))}
        <button
          type="button"
          className={`swatch none${value === 'none' ? ' on' : ''}`}
          title="No color — plain paper"
          aria-label="No color — plain paper"
          aria-pressed={value === 'none'}
          onClick={() => onChange('none')}
        />
      </div>
    </div>
  )
}

export function GroupRenameModal({ group, onClose }: { group: Group; onClose: () => void }): React.JSX.Element {
  const [name, setName] = useState(group.name)
  const [color, setColor] = useState(group.color)
  const [error, setError] = useState<string | null>(null)

  const save = (): void => {
    const n = name.trim()
    const nameChanged = n !== '' && n !== group.name
    const colorChanged = color !== group.color
    if (!nameChanged && !colorChanged) return
    try {
      if (nameChanged) {
        renameGroup(group.id, n)
        toast.success(`Renamed to “${n}”`)
      }
      if (colorChanged) setGroupColor(group.id, color)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update the group')
    }
  }

  return (
    <Modal title={`Edit group “${group.name}”`} onClose={onClose}>
      <p className="muted small" style={{ marginTop: 0 }}>
        Renaming only changes the label here — nothing moves on Drive. The color tints the group’s board cards, folder tab and crumb dot.
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
      <GroupColorPicker value={color} onChange={setColor} />
      {error && banner('error', 'Could not update the group', error)}
      <div className="row mt16" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          disabled={!name.trim() || (name.trim() === group.name && color === group.color)}
          onClick={save}
        >
          Save
        </button>
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
