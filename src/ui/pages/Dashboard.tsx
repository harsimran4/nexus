import { useMemo, useState } from 'react'
import { useStore } from '../../sync/store'
import type { Project } from '../../types/schema'
import { compareHlc } from '../../util/hlc'
import { Empty, Modal, banner } from '../components'
import { createProject, setProjectStatus } from '../../state/actions'
import { canWrite } from '../../auth/session'
import { navigate } from '../../App'

export function Dashboard(): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const [search, setSearch] = useState('')
  const [groupFilter, setGroupFilter] = useState<string>('')
  const [labelFilter, setLabelFilter] = useState<string>('')
  const [assigneeFilter, setAssigneeFilter] = useState<string>('')
  // Quick-add: launched from the header (status = first column) or a column "+".
  const [quickAdd, setQuickAdd] = useState<{ status: string } | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverCol, setDragOverCol] = useState<string | null>(null)
  const writable = canWrite()

  const projects = useMemo(() => {
    if (!doc) return []
    const q = search.trim().toLowerCase()
    return Object.values(doc.projects)
      .filter((p) => p.deleted === null && p.archivedAt === null)
      .filter((p) => (groupFilter ? p.groupId === groupFilter : true))
      .filter((p) => (labelFilter ? p.labels.includes(labelFilter) : true))
      .filter((p) => (assigneeFilter ? p.assigneeAppId === assigneeFilter : true))
      .filter((p) => (q ? p.name.toLowerCase().includes(q) || p.notes.toLowerCase().includes(q) : true))
      .sort((a, b) => compareHlc(b.updatedAt, a.updatedAt))
  }, [doc, search, groupFilter, labelFilter, assigneeFilter])

  if (!doc) return <></>

  const groups = Object.values(doc.groups).filter((g) => g.deleted === null)
  const labels = [...new Set(Object.values(doc.projects).flatMap((p) => p.labels))].sort()

  const drop = (status: string) => {
    if (dragId && writable) {
      const p = doc.projects[dragId]
      if (p && p.status !== status) setProjectStatus(dragId, status)
    }
    setDragId(null)
    setDragOverCol(null)
  }

  return (
    <div>
      <div className="content-header">
        <div>
          <h1>Board</h1>
          <div className="sub">
            {projects.length} project{projects.length === 1 ? '' : 's'} on the board ·{' '}
            <a href="#/groups">manage groups</a> · <a href="#/scripts">scripts</a>
          </div>
        </div>
        <div className="row">
          {writable && (
            <button className="btn primary" onClick={() => setQuickAdd({ status: doc.settings.pipeline[0]?.id ?? 'pending' })}>
              + New project
            </button>
          )}
        </div>
      </div>

      <div className="card mb8">
        <div className="row wrap">
          <input
            className="input"
            style={{ maxWidth: 240 }}
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select className="input" style={{ maxWidth: 180 }} value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}>
            <option value="">All groups</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          <select className="input" style={{ maxWidth: 160 }} value={assigneeFilter} onChange={(e) => setAssigneeFilter(e.target.value)}>
            <option value="">Anyone</option>
            {doc.users.app.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
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

      {projects.length === 0 ? (
        <Empty icon="▦">
          No projects on the board yet.{' '}
          {writable ? 'Create one with "+ New project" — or drag cards between columns once you have a few.' : ''}
        </Empty>
      ) : (
        <div className="kanban">
          {doc.settings.pipeline.map((col) => {
            const colProjects = projects.filter((p) => p.status === col.id)
            return (
              <div
                key={col.id}
                className={`kanban-col ${dragOverCol === col.id ? 'drag-over' : ''}`}
                onDragOver={(e) => {
                  if (!writable || dragId === null) return
                  e.preventDefault()
                  setDragOverCol(col.id)
                }}
                onDragLeave={() => setDragOverCol((c) => (c === col.id ? null : c))}
                onDrop={(e) => {
                  e.preventDefault()
                  drop(col.id)
                }}
              >
                <div className="kanban-col-head">
                  <h3>{col.label}</h3>
                  <span className="row">
                    <span className="count">{colProjects.length}</span>
                    {writable && (
                      <button
                        className="btn ghost small"
                        title={`Add a project in ${col.label}`}
                        onClick={() => setQuickAdd({ status: col.id })}
                      >
                        +
                      </button>
                    )}
                  </span>
                </div>
                {colProjects.map((project) => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    groupName={doc.groups[project.groupId]?.name ?? null}
                    draggable={writable}
                    dragging={dragId === project.id}
                    onDragStart={() => setDragId(project.id)}
                    onDragEnd={() => {
                      setDragId(null)
                      setDragOverCol(null)
                    }}
                    onOpen={() => navigate('project/' + project.id)}
                  />
                ))}
                {colProjects.length === 0 && <div className="faint small">{writable ? 'Drag a card here' : '—'}</div>}
              </div>
            )
          })}
        </div>
      )}

      {quickAdd && (
        <QuickAddModal
          presetStatus={quickAdd.status}
          defaultGroup={groupFilter}
          onClose={() => setQuickAdd(null)}
          onCreated={(id) => {
            setQuickAdd(null)
            navigate('project/' + id)
          }}
        />
      )}
    </div>
  )
}

function ProjectCard({
  project,
  groupName,
  draggable,
  dragging,
  onDragStart,
  onDragEnd,
  onOpen,
}: {
  project: Project
  groupName: string | null
  draggable: boolean
  dragging: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onOpen: () => void
}): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const overdue = project.dueAt !== null && new Date(project.dueAt) < new Date()
  const assignee = project.assigneeAppId ? doc?.users.app.find((u) => u.id === project.assigneeAppId)?.name : null
  return (
    <div
      className={`item-card ${overdue ? 'overdue' : ''}`}
      style={dragging ? { opacity: 0.45 } : undefined}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', project.id)
        e.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      onClick={onOpen}
    >
      <div className="title">{project.name}</div>
      <div className="meta">
        {groupName && <span>{groupName}</span>}
        {assignee && <span>· {assignee}</span>}
        {project.dueAt && <span style={overdue ? { color: 'var(--red)' } : undefined}>· due {new Date(project.dueAt).toLocaleDateString()}</span>}
        {project.fileIds.length > 0 && <span>· 📎{project.fileIds.length}</span>}
      </div>
      {project.labels.length > 0 && (
        <div className="chips mt8">
          {project.labels.map((l) => <span key={l} className="badge label">{l}</span>)}
        </div>
      )}
    </div>
  )
}

function QuickAddModal({
  presetStatus,
  defaultGroup,
  onClose,
  onCreated,
}: {
  presetStatus: string
  defaultGroup: string
  onClose: () => void
  onCreated: (id: string) => void
}): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const [name, setName] = useState('')
  const [groupId, setGroupId] = useState(defaultGroup)
  const [error, setError] = useState<string | null>(null)
  const groups = Object.values(doc?.groups ?? {}).filter((g) => g.deleted === null)

  if (!doc) return <></>

  const create = () => {
    const n = name.trim()
    if (!n) return
    if (!groupId) {
      setError('Pick a group — projects always live in a group folder on Drive.')
      return
    }
    void (async () => {
      try {
        const id = await createProject({ groupId, name: n })
        const { setProjectStatus } = await import('../../state/actions')
        if (presetStatus) setProjectStatus(id, presetStatus)
        onCreated(id)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not create the project')
      }
    })()
  }

  return (
    <Modal title="New project" onClose={onClose}>
      <div className="field">
        <label>Name</label>
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
        <label>Group (required — it picks the Drive folder)</label>
        <select className="input" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
          <option value="">Pick a group…</option>
          {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        {groups.length === 0 && banner('warn', 'No groups yet', 'Create one on the Groups page first.')}
      </div>
      {error && banner('error', error)}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!name.trim()} onClick={create}>Create project</button>
      </div>
    </Modal>
  )
}
