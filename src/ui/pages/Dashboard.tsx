import { useMemo, useState } from 'react'
import { useStore } from '../../sync/store'
import type { Project } from '../../types/schema'
import { compareHlc } from '../../util/hlc'
import { Empty, Modal, banner } from '../components'
import { ProjectDialog } from './ProjectDialog'
import { createProject, createGroup } from '../../state/actions'
import { canWrite } from '../../auth/session'
import { navigate } from '../../App'

export function Dashboard(): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const [search, setSearch] = useState('')
  const [groupFilter, setGroupFilter] = useState<string>('')
  const [labelFilter, setLabelFilter] = useState<string>('')
  const [assigneeFilter, setAssigneeFilter] = useState<string>('')
  const [openProject, setOpenProject] = useState<string | null>(null)
  const [quickName, setQuickName] = useState('')
  const [quickGroup, setQuickGroup] = useState('')
  const [newGroupOpen, setNewGroupOpen] = useState(false)
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

  const quickAdd = () => {
    const name = quickName.trim()
    if (!name || !writable) return
    if (!quickGroup) {
      // Group is compulsory — nudge instead of failing silently.
      alert('Pick a group for this project first (the dropdown next to the input).')
      return
    }
    void (async () => {
      const id = await createProject({ groupId: quickGroup, name })
      setQuickName('')
      setOpenProject(id)
    })()
  }

  return (
    <div>
      <div className="content-header">
        <div>
          <h1>Dashboard</h1>
          <div className="sub">
            {projects.length} project{projects.length === 1 ? '' : 's'} · {groups.length} group{groups.length === 1 ? '' : 's'}
          </div>
        </div>
        <div className="row">
          <button className="btn" onClick={() => setNewGroupOpen(true)}>+ New group</button>
        </div>
      </div>

      <div className="card mb8">
        <div className="row wrap">
          <input
            className="input"
            style={{ maxWidth: 260 }}
            placeholder="Search projects and notes…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select className="input" style={{ maxWidth: 190 }} value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}>
            <option value="">All groups</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          <select className="input" style={{ maxWidth: 170 }} value={assigneeFilter} onChange={(e) => setAssigneeFilter(e.target.value)}>
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

      {writable && (
        <div className="card mb8">
          <div className="row wrap">
            <input
              className="input"
              style={{ maxWidth: 300 }}
              placeholder="New project name…"
              value={quickName}
              onChange={(e) => setQuickName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && quickAdd()}
            />
            <select className="input" style={{ maxWidth: 190 }} value={quickGroup} onChange={(e) => setQuickGroup(e.target.value)}>
              <option value="">Pick a group…</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
            <button className="btn primary" onClick={quickAdd} disabled={!quickName.trim() || !quickGroup}>Add</button>
            <span className="faint small">Group is required — projects always live in a group's folder on Drive.</span>
          </div>
        </div>
      )}

      {groups.length > 0 && (
        <div className="card mb8">
          <div className="spread mb8">
            <h3 style={{ margin: 0 }}>Groups</h3>
            <span className="faint small">click to filter · double-click to open</span>
          </div>
          <div className="chips">
            {groups.map((g) => {
              const count = Object.values(doc.projects).filter((p) => p.groupId === g.id && p.deleted === null).length
              return (
                <button
                  key={g.id}
                  className={`chip ${groupFilter === g.id ? 'on' : ''}`}
                  onClick={() => setGroupFilter(groupFilter === g.id ? '' : g.id)}
                  onDoubleClick={() => navigate('group/' + g.id)}
                >
                  {g.name} · {count}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {projects.length === 0 ? (
        <Empty icon="▦">
          No projects yet.{' '}
          {writable
            ? 'Add one above — pick a group, name it, and it appears on this board with its own Drive folder.'
            : 'Projects will appear here as the team adds them.'}
        </Empty>
      ) : (
        <div className="kanban">
          {doc.settings.pipeline.map((col) => {
            const colProjects = projects.filter((p) => p.status === col.id)
            return (
              <div className="kanban-col" key={col.id}>
                <div className="kanban-col-head">
                  <h3>{col.label}</h3>
                  <span className="count">{colProjects.length}</span>
                </div>
                {colProjects.map((project) => (
                  <ProjectCard key={project.id} project={project} groupName={doc.groups[project.groupId]?.name ?? null} onOpen={() => setOpenProject(project.id)} />
                ))}
                {colProjects.length === 0 && <div className="faint small">—</div>}
              </div>
            )
          })}
        </div>
      )}

      {openProject && <ProjectDialog projectId={openProject} onClose={() => setOpenProject(null)} />}

      {newGroupOpen && (
        <NewGroupModal
          onClose={() => setNewGroupOpen(false)}
          onCreated={(id) => {
            setNewGroupOpen(false)
            setQuickGroup(id)
            setGroupFilter(id)
          }}
        />
      )}
    </div>
  )
}

function ProjectCard({ project, groupName, onOpen }: { project: Project; groupName: string | null; onOpen: () => void }): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const overdue = project.dueAt !== null && new Date(project.dueAt) < new Date()
  const assignee = project.assigneeAppId ? doc?.users.app.find((u) => u.id === project.assigneeAppId)?.name : null
  return (
    <div className={`item-card ${overdue ? 'overdue' : ''}`} onClick={onOpen}>
      <div className="title">{project.name}</div>
      <div className="meta">
        {groupName && <span>{groupName}</span>}
        {assignee && <span>· {assignee}</span>}
        {project.dueAt && <span>· due {new Date(project.dueAt).toLocaleDateString()}</span>}
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

function NewGroupModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }): React.JSX.Element {
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
