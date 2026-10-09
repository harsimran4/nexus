import { useState } from 'react'
import { useStore } from '../../sync/store'
import { compareHlc, decodeHlc } from '../../util/hlc'
import { Empty, Icon, Modal, StatusBadge, banner } from '../components'
import { canWrite } from '../../auth/session'
import { createProject } from '../../state/actions'
import { navigate } from '../../nav'
import { MediaThumb } from '../MediaThumb'
import { GroupDeleteModal, GroupRenameModal } from './GroupDialogs'

export function GroupView({ groupId }: { groupId: string }): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [newOpen, setNewOpen] = useState(false)
  const writable = canWrite()

  const group = doc?.groups[groupId]
  if (!doc || !group || group.deleted !== null) {
    return (
      <Empty icon="▦">
        This group doesn't exist or has been deleted.{' '}
        <a href="/" onClick={(e) => { e.preventDefault(); navigate('dash') }}>Back to dashboard</a>
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

  const openProject = (id: string) => navigate('project/' + id)

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
          <button className="btn" disabled={!writable} onClick={() => setRenameOpen(true)}>Rename</button>
          <button className="btn danger" disabled={!writable} onClick={() => setDeleteOpen(true)}>Delete</button>
        </div>
      </div>

      {!writable && banner('info', 'Read-only view', 'Sign in as an editor or admin to make changes.')}

      <div className="card mb8">
        <div className="spread mb8">
          <h3 style={{ margin: 0 }}>Projects in this group</h3>
          <button className="btn primary small" disabled={!writable} onClick={() => setNewOpen(true)}>
            <Icon name="plus" size={13} /> New project
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
                <tr
                  key={p.id}
                  className="clickable"
                  onClick={() => openProject(p.id)}
                >
                  <td className="group-project-name">
                    <span className="row">
                      {p.fileIds[0] && (
                        <MediaThumb
                          fileKey={p.fileIds[0]}
                          style={{ width: 42, height: 30, borderRadius: 'var(--radius-xs)', background: 'var(--panel-2)' }}
                        />
                      )}
                      {/* The name link is the row's keyboard + screen-reader
                          stop; the row-level onClick is a mouse shortcut.
                          Keeping the tr plain preserves table semantics so
                          Status/Files/Due stay navigable cells. */}
                      <a
                        href={`/project/${p.id}`}
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          openProject(p.id)
                        }}
                      >
                        {p.name}
                      </a>
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
              <a key={s.id} className="chip" href="/scripts" onClick={(e) => { e.preventDefault(); navigate('scripts') }}>{s.title}</a>
            ))}
          </div>
        </div>
      )}

      {renameOpen && <GroupRenameModal group={group} onClose={() => setRenameOpen(false)} />}

      {newOpen && (
        <NewProjectInGroupModal groupId={groupId} onClose={() => setNewOpen(false)} onCreated={(id) => { setNewOpen(false); navigate('project/' + id) }} />
      )}

      {deleteOpen && (
        <GroupDeleteModal
          groupId={groupId}
          onClose={() => setDeleteOpen(false)}
          onDeleted={() => navigate('dash')}
        />
      )}
    </div>
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
