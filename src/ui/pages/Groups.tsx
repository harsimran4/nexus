import { useState } from 'react'
import { useStore } from '../../sync/store'
import { compareHlc } from '../../util/hlc'
import { Empty, Modal, banner, PageQuote } from '../components'
import { canWrite } from '../../auth/session'
import { createGroup, deleteGroupCascade, renameGroup } from '../../state/actions'
import { navigate } from '../../App'

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
          <button className="btn primary" onClick={() => setCreating(true)}>+ New group</button>
        )}
      </div>

      <PageQuote topic="groups" />

      {groups.length === 0 ? (
        <Empty icon="▦">
          No groups yet.{' '}
          {writable ? 'Create your first group — e.g. "Personal" or "Client Work" — then add projects inside it.' : ''}
        </Empty>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
          {groups.map((g) => (
            <div
              key={g.id}
              className="card folder-card"
              style={{ cursor: 'pointer', transition: 'border-color .12s' }}
              onClick={() => navigate('group/' + g.id)}
              onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent)')}
              onMouseLeave={(e) => (e.currentTarget.style.borderColor = '#d9ccaa')}
            >
              <div className="spread">
                <h3 style={{ margin: 0 }}>{g.name}</h3>
                <span className="badge">{projectCount(g.id)} project{projectCount(g.id) === 1 ? '' : 's'}</span>
              </div>
              {g.description && <div className="muted small mt8">{g.description}</div>}
              <div className="row wrap mt8">
                <button
                  className="btn small"
                  onClick={(e) => {
                    e.stopPropagation()
                    setRenaming(g.id)
                  }}
                  disabled={!writable}
                >
                  Rename
                </button>
                <button
                  className="btn small danger"
                  onClick={(e) => {
                    e.stopPropagation()
                    setDeleting(g.id)
                  }}
                  disabled={!writable}
                >
                  Delete
                </button>
                {g.folderId && (
                  <a
                    className="btn small ghost"
                    href={`https://drive.google.com/drive/folders/${g.folderId}`}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                  >
                    Drive ↗
                  </a>
                )}
              </div>
            </div>
          ))}
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
      {renaming && doc && <GroupRenameModal groupId={renaming} onClose={() => setRenaming(null)} />}
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
      {banner('info', 'One Drive folder per group', 'Nexus/groups/<name>/ — every project inside gets its own subfolder.')}
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

function GroupRenameModal({ groupId, onClose }: { groupId: string; onClose: () => void }): React.JSX.Element {
  const group = useStore((s) => s.doc?.groups[groupId])
  const [name, setName] = useState(group?.name ?? '')
  const [error, setError] = useState<string | null>(null)

  if (!group) return <></>

  const save = (): void => {
    const n = name.trim()
    if (!n || n === group.name) return
    try {
      renameGroup(group.id, n)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not rename the group')
    }
  }

  return (
    <Modal title={`Rename "${group.name}"`} onClose={onClose}>
      <p className="muted small" style={{ marginTop: 0 }}>
        The Drive folder is renamed too.
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

function GroupDeleteModal({ groupId, onClose }: { groupId: string; onClose: () => void }): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const group = doc?.groups[groupId]
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!doc || !group) return <></>

  const projects = Object.values(doc.projects).filter((p) => p.groupId === groupId && p.deleted === null)
  const fileCount = projects.reduce((n, p) => n + p.fileIds.length, 0)

  return (
    <Modal title={`Delete group "${group.name}"?`} onClose={onClose} wide>
      {banner('warn', 'Everything inside moves to Drive trash', 'Recoverable for 30 days in Google Drive. All projects in the group are also removed from the board.')}
      <div className="field">
        <label>What will be trashed:</label>
        <div style={{ maxHeight: 240, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
          <div className="row spread" style={{ padding: '7px 10px', background: 'var(--bg-raised)' }}>
            <span style={{ fontWeight: 600 }}>📁 {group.name}/</span>
            <span className="faint small">group folder</span>
          </div>
          {projects.map((p) => (
            <div key={p.id} className="small" style={{ padding: '6px 10px 6px 26px' }}>
              {p.fileIds.length > 0 ? '📄' : '▫'} {p.name}
              <span className="faint"> · {p.fileIds.length} file{p.fileIds.length === 1 ? '' : 's'}</span>
            </div>
          ))}
          {projects.length === 0 && <div className="faint small" style={{ padding: '8px 10px' }}>No projects inside.</div>}
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
