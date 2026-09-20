import { useState } from 'react'
import { useStore } from '../../sync/store'
import type { Group } from '../../types/schema'
import { compareHlc, decodeHlc } from '../../util/hlc'
import { Empty, Modal, StatusBadge, banner } from '../components'
import { canWrite } from '../../auth/session'
import { createProject, deleteGroupCascade, renameGroup } from '../../state/actions'
import { navigate } from '../../App'
import { thumbnailUrl } from '../../drive/client'

export function GroupView({ groupId }: { groupId: string }): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [newOpen, setNewOpen] = useState(false)
  const writable = canWrite()

  const group = doc?.groups[groupId]
  if (!doc || !group || group.deleted !== null) {
    return (
      <Empty icon="▦">
        This group doesn't exist or has been deleted. <a href="#/dash">Back to dashboard</a>
      </Empty>
    )
  }

  const projects = Object.values(doc.projects)
    .filter((p) => p.groupId === groupId && p.deleted === null && p.archivedAt === null)
    .sort((a, b) => compareHlc(b.updatedAt, a.updatedAt))

  // Scripts whose PROJECT belongs to this group (scripts link to projects only).
  const scriptsOfGroup = Object.values(doc.scripts).filter((s) => {
    if (s.deleted !== null || s.projectId === null) return false
    return doc.projects[s.projectId]?.groupId === groupId
  })

  return (
    <div>
      <div className="content-header">
        <div>
          <h1>{group.name}</h1>
          <div className="sub">
            {projects.length} project{projects.length === 1 ? '' : 's'} · created{' '}
            {new Date(decodeHlc(group.createdAt).ms).toLocaleDateString()}
          </div>
          {group.description && (
            <div className="muted small" style={{ maxWidth: 760, marginTop: 4 }}>{group.description}</div>
          )}
        </div>
        <div className="row wrap">
          {group.folderId && (
            <a className="btn" href={`https://drive.google.com/drive/folders/${group.folderId}`} target="_blank" rel="noreferrer">
              Open in Drive
            </a>
          )}
          <button className="btn" disabled={!writable} onClick={() => setRenameOpen(true)}>Rename</button>
          <button className="btn danger" disabled={!writable} onClick={() => setDeleteOpen(true)}>Delete</button>
        </div>
      </div>

      {!writable && banner('info', 'Read-only view', 'Sign in as an editor or admin to make changes.')}

      <div className="card mb8">
        <div className="spread mb8">
          <h3 style={{ margin: 0 }}>Projects in this group</h3>
          <button className="btn primary small" disabled={!writable} onClick={() => setNewOpen(true)}>
            + New project
          </button>
        </div>
        {projects.length === 0 ? (
          <Empty icon="▦">No projects in this group yet.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr><th>Name</th><th>Status</th><th>Files</th><th>Due</th><th></th></tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => navigate('project/' + p.id)}>
                  <td style={{ fontWeight: 570 }}>
                    <span className="row" style={{ gap: 9 }}>
                      {p.fileIds[0] && (
                        <img
                          src={thumbnailUrl(p.fileIds[0], 200)}
                          alt=""
                          loading="lazy"
                          style={{ width: 42, height: 30, objectFit: 'cover', borderRadius: 4, background: 'var(--panel-2)' }}
                          onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
                        />
                      )}
                      {p.name}
                    </span>
                  </td>
                  <td><StatusBadge doc={doc} status={p.status} /></td>
                  <td className="small muted">{p.fileIds.length}</td>
                  <td className="small muted">
                    {p.dueAt ? new Date(p.dueAt).toLocaleDateString() : '—'}
                  </td>
                  <td className="faint small">open →</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {scriptsOfGroup.length > 0 && (
        <div className="card">
          <h3>Scripts linked to this group</h3>
          <div className="chips mt8">
            {scriptsOfGroup.map((s) => (
              <a key={s.id} className="chip" href="#/scripts">{s.title}</a>
            ))}
          </div>
        </div>
      )}

      {renameOpen && <RenameGroupModal group={group} onClose={() => setRenameOpen(false)} />}

      {newOpen && (
        <NewProjectInGroupModal groupId={groupId} onClose={() => setNewOpen(false)} onCreated={(id) => { setNewOpen(false); navigate('project/' + id) }} />
      )}

      {deleteOpen && (
        <Modal title={`Delete group "${group.name}"?`} onClose={() => setDeleteOpen(false)} wide>
          {banner('warn', 'Everything inside moves to Drive trash', 'The group folder (with every project subfolder and file) is trashed — recoverable for 30 days in Google Drive. All projects in the group are also removed from the board.')}
          <div className="field">
            <label>What will be trashed:</label>
            <div style={{ maxHeight: 240, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
              <div className="row spread" style={{ padding: '7px 10px', background: 'var(--bg-raised)' }}>
                <span style={{ fontWeight: 600 }}>📁 {group.name}/</span>
                <span className="faint small">group folder</span>
              </div>
              {projects.map((p) => (
                <div key={p.id} style={{ padding: '6px 10px 6px 26px' }} className="small">
                  {p.fileIds.length > 0 ? '📄' : '▫'} {p.name}
                  <span className="faint"> · {p.fileIds.length} file{p.fileIds.length === 1 ? '' : 's'}</span>
                </div>
              ))}
              {projects.length === 0 && <div className="faint small" style={{ padding: '8px 10px' }}>No projects inside.</div>}
            </div>
            <div className="muted small mt8">{projects.length} project{projects.length === 1 ? '' : 's'} will be removed from the board.</div>
          </div>
          {deleteError && banner('error', 'Delete failed', deleteError)}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setDeleteOpen(false)}>Cancel</button>
            <button
              className="btn danger"
              disabled={deleting}
              onClick={async () => {
                setDeleting(true)
                try {
                  await deleteGroupCascade(groupId)
                  setDeleteOpen(false)
                  navigate('dash')
                } catch (e) {
                  setDeleteError(e instanceof Error ? e.message : 'Delete failed')
                  setDeleting(false)
                }
              }}
            >
              {deleting ? 'Deleting…' : 'Move everything to trash'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

function RenameGroupModal({ group, onClose }: { group: Group; onClose: () => void }): React.JSX.Element {
  const [name, setName] = useState(group.name)
  const [error, setError] = useState<string | null>(null)

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
    <Modal title="Rename group" onClose={onClose}>
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

function NewProjectInGroupModal({ groupId, onClose, onCreated }: { groupId: string; onClose: () => void; onCreated: (id: string) => void }): React.JSX.Element {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const create = () => {
    const n = name.trim()
    if (!n) return
    void (async () => {
      try {
        const id = await createProject({ groupId, name: n })
        onCreated(id)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not create the project')
      }
    })()
  }

  return (
    <Modal title="New project" onClose={onClose}>
      <p className="muted small" style={{ marginTop: 0 }}>
        It lives in this group's folder on Drive and appears on the board.
      </p>
      <div className="field">
        <label>Project name</label>
        <input
          className="input"
          autoFocus
          placeholder="e.g. Q4 Launch"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && create()}
        />
      </div>
      {error && banner('error', error)}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!name.trim()} onClick={create}>Create project</button>
      </div>
    </Modal>
  )
}
