import { useMemo, useRef, useState } from 'react'
import { useStore } from '../../sync/store'
import { ITEM_KINDS, type ItemKind, type Project } from '../../types/schema'
import { compareHlc, decodeHlc } from '../../util/hlc'
import { Empty, KindBadge, Modal, StatusBadge, banner } from '../components'
import { ItemDialog } from './ItemDialog'
import { canAdmin, canWrite } from '../../auth/session'
import { createItem, deleteProject, renameProject, uploadToItem } from '../../state/actions'
import { isSignedIn } from '../../auth/tokenClient'

export function ProjectView({ projectId }: { projectId: string }): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const [openItem, setOpenItem] = useState<string | null>(null)
  const [newOpen, setNewOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)

  const items = useMemo(() => {
    if (!doc) return []
    return Object.values(doc.items)
      .filter((i) => i.deleted === null && i.archivedAt === null && i.projectId === projectId)
      .sort((a, b) => compareHlc(b.updatedAt, a.updatedAt))
  }, [doc, projectId])

  if (!doc) return <></>

  const project = doc.projects[projectId]
  if (!project || project.deleted !== null) {
    return (
      <Empty icon="▦">
        This project doesn't exist or has been deleted. <a href="#/dash">Back to dashboard</a>
      </Empty>
    )
  }

  const writable = canWrite()
  const admin = canAdmin()

  const onDelete = () => {
    if (!admin) return
    if (confirm(`Delete project "${project.name}"? Its items stay in the Archive.`)) {
      deleteProject(projectId)
      location.hash = '#/dash'
    }
  }

  return (
    <div>
      <div className="content-header">
        <div>
          <h1>{project.name}</h1>
          <div className="sub">
            {items.length} item{items.length === 1 ? '' : 's'} · created{' '}
            {new Date(decodeHlc(project.createdAt).ms).toLocaleDateString()}
          </div>
          {project.description && (
            <div className="muted small" style={{ maxWidth: 760, marginTop: 4 }}>{project.description}</div>
          )}
          {project.labels.length > 0 && (
            <div className="chips mt8">
              {project.labels.map((l) => (
                <span key={l} className="badge label">{l}</span>
              ))}
            </div>
          )}
        </div>
        <div className="row wrap">
          {project.folderId && (
            <a
              className="btn"
              href={`https://drive.google.com/drive/folders/${project.folderId}`}
              target="_blank"
              rel="noreferrer"
            >
              Open in Drive
            </a>
          )}
          <button
            className="btn primary"
            disabled={!writable}
            title={writable ? undefined : 'Editor or admin login required'}
            onClick={() => setNewOpen(true)}
          >
            New item
          </button>
          <button
            className="btn"
            disabled={!admin}
            title={admin ? undefined : 'Admin login required'}
            onClick={() => setRenameOpen(true)}
          >
            Rename
          </button>
          <button
            className="btn danger"
            disabled={!admin}
            title={admin ? undefined : 'Admin login required'}
            onClick={onDelete}
          >
            Delete
          </button>
        </div>
      </div>

      {!admin && (
        <div className="muted small mb8">
          {!writable && 'Read-only view — sign in as an editor or admin to add or edit items. '}
          Rename and Delete are admin-only.
        </div>
      )}

      {items.length === 0 ? (
        <Empty icon="▦">
          No items in this project yet.
          {writable ? ' Use "New item" to add the first one.' : ' Items will appear here as the team adds them.'}
        </Empty>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Kind</th>
                <th>Title</th>
                <th>Status</th>
                <th>Labels</th>
                <th>Assignee</th>
                <th>Due</th>
                <th style={{ textAlign: 'right' }}>Files</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const isOverdue =
                  item.dueAt !== null && new Date(item.dueAt) < new Date() && item.status !== 'completed'
                const assignee = item.assigneeAppId
                  ? doc.users.app.find((u) => u.id === item.assigneeAppId)?.name
                  : null
                return (
                  <tr key={item.id} className="clickable" onClick={() => setOpenItem(item.id)}>
                    <td><KindBadge kind={item.kind} /></td>
                    <td>{item.title}</td>
                    <td><StatusBadge doc={doc} status={item.status} /></td>
                    <td>
                      {item.labels.length === 0 ? (
                        <span className="faint">—</span>
                      ) : (
                        <div className="chips">
                          {item.labels.map((l) => (
                            <span key={l} className="badge label">{l}</span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td>{assignee ?? <span className="faint">—</span>}</td>
                    <td style={isOverdue ? { color: 'var(--red)', fontWeight: 600 } : undefined}>
                      {item.dueAt ? new Date(item.dueAt).toLocaleDateString() : '—'}
                    </td>
                    <td style={{ textAlign: 'right' }}>{item.fileIds.length}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {openItem && <ItemDialog itemId={openItem} onClose={() => setOpenItem(null)} />}
      {newOpen && <NewItemModal projectId={projectId} onClose={() => setNewOpen(false)} />}
      {renameOpen && <RenameModal project={project} onClose={() => setRenameOpen(false)} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// New item: create first, then optionally upload the chosen file into the
// project folder on Drive (uploadToItem needs the item to exist).
// ---------------------------------------------------------------------------

function NewItemModal({ projectId, onClose }: { projectId: string; onClose: () => void }): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState<ItemKind>('video')
  const [due, setDue] = useState('')
  const [notes, setNotes] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [pct, setPct] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [createdId, setCreatedId] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const submit = async (): Promise<void> => {
    if (busy) return
    setError(null)
    setBusy(true)
    try {
      let id = createdId
      if (!id) {
        const t = title.trim()
        if (!t) return
        id = createItem({ title: t, projectId, kind, dueAt: due || null, notes })
        setCreatedId(id)
      }
      if (file) {
        setPct(0)
        const result = await uploadToItem(id, file, setPct)
        setPct(null)
        if (!result.ok) {
          setError(result.error) // item exists — the button becomes "Retry upload"
          return
        }
      }
      onClose()
    } catch (e) {
      setPct(null)
      setError(e instanceof Error ? e.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="New item" onClose={onClose}>
      <div className="field">
        <label>Title</label>
        <input
          className="input"
          value={title}
          autoFocus
          disabled={createdId !== null}
          placeholder="e.g. Interview cut — episode 12"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && title.trim()) void submit()
          }}
        />
      </div>

      <div className="row wrap mb8">
        <div className="field" style={{ width: 190 }}>
          <label>Kind</label>
          <select
            className="input"
            value={kind}
            disabled={createdId !== null}
            onChange={(e) => setKind(e.target.value as ItemKind)}
          >
            {ITEM_KINDS.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </div>
        <div className="field" style={{ width: 190 }}>
          <label>Due date</label>
          <input
            className="input"
            type="date"
            value={due}
            disabled={createdId !== null}
            onChange={(e) => setDue(e.target.value)}
          />
        </div>
      </div>

      <div className="field">
        <label>Notes</label>
        <textarea
          className="input"
          value={notes}
          disabled={createdId !== null}
          placeholder="Context, links, feedback…"
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      <div className="field">
        <label>File (optional — uploads to the project folder on Drive)</label>
        {file ? (
          <div className="row spread" style={{ background: 'var(--bg-raised)', padding: '7px 10px', borderRadius: 8 }}>
            <span className="mono small" style={{ wordBreak: 'break-all' }}>{file.name}</span>
            <button className="btn small ghost" disabled={busy} onClick={() => setFile(null)}>Remove</button>
          </div>
        ) : (
          <div
            className="dropzone"
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              const f = e.dataTransfer.files[0]
              if (f) setFile(f)
            }}
          >
            Drop a file here or click to choose one — it uploads right after the item is created
          </div>
        )}
        <input
          ref={fileInput}
          type="file"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) setFile(f)
            e.target.value = ''
          }}
        />
        {pct !== null && <div className="progress"><div style={{ width: `${pct}%` }} /></div>}
        {!isSignedIn() &&
          banner('warn', 'Not connected to Google', 'Click "Connect Google (studio account)" in the top bar to enable uploads.')}
      </div>

      {error && banner('error', createdId ? 'Item created, but the upload failed — you can retry' : 'Could not create the item', error)}

      <div className="row spread mt16">
        <button className="btn ghost" onClick={onClose}>{createdId ? 'Close' : 'Cancel'}</button>
        <button
          className="btn primary"
          disabled={busy || (!createdId && !title.trim())}
          onClick={() => void submit()}
        >
          {createdId ? (file ? 'Retry upload' : 'Done') : 'Create item'}
        </button>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------

function RenameModal({ project, onClose }: { project: Project; onClose: () => void }): React.JSX.Element {
  const [name, setName] = useState(project.name)
  const [error, setError] = useState<string | null>(null)

  const save = (): void => {
    const n = name.trim()
    if (!n || n === project.name) return
    try {
      renameProject(project.id, n)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not rename the project')
    }
  }

  return (
    <Modal title="Rename project" onClose={onClose}>
      <div className="field">
        <label>Project name</label>
        <input
          className="input"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
          }}
        />
      </div>
      {error && banner('error', 'Could not rename', error)}
      <div className="row mt16" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!name.trim() || name.trim() === project.name} onClick={save}>
          Save
        </button>
      </div>
    </Modal>
  )
}
