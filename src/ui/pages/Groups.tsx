import { useState } from 'react'
import { useStore } from '../../sync/store'
import { compareHlc } from '../../util/hlc'
import { Empty, Icon, Modal, PageQuote, banner } from '../components'
import { canWrite } from '../../auth/session'
import { createGroup } from '../../state/actions'
import { navigate } from '../../nav'
import { GroupDeleteModal, GroupRenameModal } from './GroupDialogs'

export function Groups(): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const writable = canWrite()

  const groups = Object.values(doc?.groups ?? {})
    .filter((g) => g.deleted === null)
    .sort((a, b) => compareHlc(b.updatedAt, a.updatedAt))

  const projectCount = (groupId: string) =>
    Object.values(doc?.projects ?? {}).filter((p) => p.groupId === groupId && p.deleted === null).length

  return (
    <div>
      <div className="content-header">
        <div>
          <h1>Groups</h1>
          <div className="sub">
            Groups organize your projects — each one is a folder on Drive.{' '}
            {writable ? '' : 'Read-only view.'}
          </div>
        </div>
        {writable && (
          <button className="btn primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} /> New group
          </button>
        )}
      </div>

      <PageQuote topic="groups" />

      {groups.length === 0 ? (
        <Empty icon="▦">
          No groups yet.{' '}
          {writable ? 'Create your first group — e.g. “Personal” or “Client Work” — then add projects inside it.' : ''}
        </Empty>
      ) : (
        <div className="group-grid">
          {groups.map((g) => {
            const n = projectCount(g.id)
            return (
              <div
                key={g.id}
                className="card folder-card"
                onClick={() => navigate('group/' + g.id)}
              >
                <div className="spread">
                  {/* The name is the real control: keyboard + screen-reader
                      activation live here, and the h3 keeps heading semantics.
                      The card-level onClick is only a mouse convenience. */}
                  <h3>
                    <a
                      href={`/group/${g.id}`}
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        navigate('group/' + g.id)
                      }}
                    >
                      {g.name}
                    </a>
                  </h3>
                  {writable && (
                    <span className="folder-card-actions">
                      <button
                        className="folder-card-btn"
                        title={`Rename ${g.name}`}
                        aria-label={`Rename ${g.name}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          setRenaming(g.id)
                        }}
                      >
                        <Icon name="pencil" size={13} />
                      </button>
                      <button
                        className="folder-card-btn danger"
                        title={`Delete ${g.name}`}
                        aria-label={`Delete ${g.name}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          setDeleting(g.id)
                        }}
                      >
                        <Icon name="trash" size={13} />
                      </button>
                    </span>
                  )}
                </div>
                {g.description && <div className="muted small mt8 folder-card-desc">{g.description}</div>}
                <div className="mt8">
                  <span className="badge">{n} project{n === 1 ? '' : 's'}</span>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {creating && (
        <GroupCreateModal
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false)
            navigate('group/' + id)
          }}
        />
      )}
      {renaming && doc?.groups[renaming] && (
        <GroupRenameModal group={doc.groups[renaming]} onClose={() => setRenaming(null)} />
      )}
      {deleting && doc && <GroupDeleteModal groupId={deleting} onClose={() => setDeleting(null)} />}
    </div>
  )
}

function GroupCreateModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }): React.JSX.Element {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)

  const create = () => {
    const n = name.trim()
    if (!n) return
    void (async () => {
      try {
        const id = await createGroup(n, description.trim())
        onCreated(id)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not create the group')
      }
    })()
  }

  return (
    <Modal title="New group" onClose={onClose}>
      {banner('info', 'One folder per group', 'Every group gets its own folder on Drive — renaming the group never moves anything.')}
      <div className="field">
        <label>Group name</label>
        <input
          className="input"
          autoFocus
          placeholder="e.g. Personal, Client Work"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && create()}
        />
      </div>
      <div className="field">
        <label>Description (optional)</label>
        <input
          className="input"
          placeholder="What belongs in this group?"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && create()}
        />
      </div>
      {error && banner('error', error)}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!name.trim()} onClick={create}>Create group</button>
      </div>
    </Modal>
  )
}
