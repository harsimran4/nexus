import { useMemo, useState } from 'react'
import { useStore } from '../../sync/store'
import type { Item } from '../../types/schema'
import { compareHlc } from '../../util/hlc'
import { Empty, KindBadge, Modal, StatusBadge } from '../components'
import { ItemDialog } from './ItemDialog'
import { createItem, createProject } from '../../state/actions'
import { canWrite } from '../../auth/session'
import { navigate } from '../../App'
import { banner } from '../components'

const KIND_ICON: Record<string, string> = {
  video: '▶', script: '✎', thumbnail: '🖼', audio: '♪', doc: '☰', other: '◇',
}

export function Dashboard(): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const [search, setSearch] = useState('')
  const [projectFilter, setProjectFilter] = useState<string>('')
  const [labelFilter, setLabelFilter] = useState<string>('')
  const [assigneeFilter, setAssigneeFilter] = useState<string>('')
  const [openItem, setOpenItem] = useState<string | null>(null)
  const [quickTitle, setQuickTitle] = useState('')
  const [quickProject, setQuickProject] = useState('')
  const [newProjectOpen, setNewProjectOpen] = useState(false)

  const items = useMemo(() => {
    if (!doc) return []
    const q = search.trim().toLowerCase()
    return Object.values(doc.items)
      .filter((i) => i.deleted === null && i.archivedAt === null)
      .filter((i) => (projectFilter ? i.projectId === projectFilter : true))
      .filter((i) => (labelFilter ? i.labels.includes(labelFilter) : true))
      .filter((i) => (assigneeFilter ? i.assigneeAppId === assigneeFilter : true))
      .filter((i) =>
        q ? i.title.toLowerCase().includes(q) || i.notes.toLowerCase().includes(q) : true,
      )
      .sort((a, b) => compareHlc(b.updatedAt, a.updatedAt))
  }, [doc, search, projectFilter, labelFilter, assigneeFilter])

  if (!doc) return <></>

  const labels = [...new Set(Object.values(doc.items).flatMap((i) => i.labels))].sort()
  const projects = Object.values(doc.projects).filter((p) => p.deleted === null)

  const quickAdd = () => {
    const title = quickTitle.trim()
    if (!title || !canWrite()) return
    createItem({ title, projectId: quickProject || null })
    setQuickTitle('')
  }

  return (
    <div>
      <div className="content-header">
        <div>
          <h1>Dashboard</h1>
          <div className="sub">
            {items.length} item{items.length === 1 ? '' : 's'} · {projects.length} project{projects.length === 1 ? '' : 's'}
          </div>
        </div>
        <div className="row">
          {canWrite() && (
            <button className="btn primary" onClick={() => setNewProjectOpen(true)}>
              + New project
            </button>
          )}
        </div>
      </div>

      <div className="card mb8">
        <div className="row wrap">
          <input
            className="input"
            style={{ maxWidth: 260 }}
            placeholder="Search titles and notes…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select className="input" style={{ maxWidth: 190 }} value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <select className="input" style={{ maxWidth: 170 }} value={assigneeFilter} onChange={(e) => setAssigneeFilter(e.target.value)}>
            <option value="">Anyone</option>
            {doc.users.app.map((u) => (
              <option key={u.id} value={u.id}>{u.name}</option>
            ))}
          </select>
          {labels.length > 0 && (
            <div className="chips">
              {labels.map((l) => (
                <button key={l} className={`chip ${labelFilter === l ? 'on' : ''}`} onClick={() => setLabelFilter(labelFilter === l ? '' : l)}>
                  {l}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {canWrite() && (
        <div className="card mb8">
          <div className="row wrap">
            <input
              className="input"
              style={{ maxWidth: 320 }}
              placeholder="Quick-add an item…"
              value={quickTitle}
              onChange={(e) => setQuickTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && quickAdd()}
            />
            <select className="input" style={{ maxWidth: 190 }} value={quickProject} onChange={(e) => setQuickProject(e.target.value)}>
              <option value="">No project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <button className="btn primary" onClick={quickAdd} disabled={!quickTitle.trim()}>Add</button>
            <span className="faint small">Tip: pick a project so its uploads land in the project's Drive folder (no-project items go to Unsorted/).</span>
          </div>
        </div>
      )}

      {projects.length > 0 && (
        <div className="card mb8">
          <div className="spread mb8">
            <h3 style={{ margin: 0 }}>Projects</h3>
            {canWrite() && (
              <button className="btn small ghost" onClick={() => setNewProjectOpen(true)}>+ new</button>
            )}
          </div>
          <div className="chips">
            {projects.map((p) => {
              const count = items.filter((i) => i.projectId === p.id).length
              return (
                <button
                  key={p.id}
                  className={`chip ${projectFilter === p.id ? 'on' : ''}`}
                  onClick={() => setProjectFilter(projectFilter === p.id ? '' : p.id)}
                  title="Click to filter the board; double-click opens the project"
                  onDoubleClick={() => navigate('project/' + p.id)}
                >
                  {p.name} · {count}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {items.length === 0 ? (
        <Empty icon="▦">
          Nothing here yet. {canWrite() ? 'Add your first item above — it lands on Drive and in this board instantly.' : 'Items will appear once the team adds them.'}
        </Empty>
      ) : (
        <div className="kanban">
          {doc.settings.pipeline.map((col) => {
            const colItems = items.filter((i) => i.status === col.id)
            return (
              <div className="kanban-col" key={col.id}>
                <div className="kanban-col-head">
                  <h3>{col.label}</h3>
                  <span className="count">{colItems.length}</span>
                </div>
                {colItems.map((item) => (
                  <ItemCard key={item.id} item={item} projectName={item.projectId ? doc.projects[item.projectId]?.name : null} onOpen={() => setOpenItem(item.id)} />
                ))}
                {colItems.length === 0 && <div className="faint small">—</div>}
              </div>
            )
          })}
        </div>
      )}

      {openItem && <ItemDialog itemId={openItem} onClose={() => setOpenItem(null)} />}

      {newProjectOpen && (
        <NewProjectModal
          onClose={() => setNewProjectOpen(false)}
          onCreated={(id) => {
            setNewProjectOpen(false)
            navigate('project/' + id)
          }}
        />
      )}
    </div>
  )
}

function NewProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }): React.JSX.Element {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)

  const create = () => {
    const n = name.trim()
    if (!n) return
    void (async () => {
      try {
        const id = await createProject(n, { description: description.trim() })
        onCreated(id)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not create the project')
      }
    })()
  }

  return (
    <Modal title="New project" onClose={onClose}>
      {banner('info', 'A Drive folder is created for it automatically', 'Nexus/projects/<name>/ — uploads for this project\'s items land there.')}
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
      <div className="field">
        <label>Description (optional)</label>
        <input
          className="input"
          placeholder="What is this project about?"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
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

export function ItemCard({ item, projectName, onOpen }: { item: Item; projectName: string | null; onOpen: () => void }): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const overdue = item.dueAt !== null && new Date(item.dueAt) < new Date() && item.status !== 'completed'
  const assignee = item.assigneeAppId ? doc?.users.app.find((u) => u.id === item.assigneeAppId)?.name : null
  return (
    <div className={`item-card ${overdue ? 'overdue' : ''}`} onClick={onOpen}>
      <div className="title">
        {KIND_ICON[item.kind] ?? '◇'} {item.title}
      </div>
      <div className="meta">
        {projectName && <span>{projectName}</span>}
        {assignee && <span>· {assignee}</span>}
        {item.dueAt && <span>· due {new Date(item.dueAt).toLocaleDateString()}</span>}
        {item.fileIds.length > 0 && <span>· 📎{item.fileIds.length}</span>}
      </div>
      {(item.labels.length > 0 || true) && (
        <div className="chips mt8">
          {item.labels.map((l) => (
            <span key={l} className="badge label">{l}</span>
          ))}
        </div>
      )}
    </div>
  )
}

// Re-exported so pages that only need badges can import from here.
export { StatusBadge, KindBadge }
