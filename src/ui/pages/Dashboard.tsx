import { useMemo, useState } from 'react'
import { useStore } from '../../sync/store'
import type { Project } from '../../types/schema'
import { compareHlc } from '../../util/hlc'
import { Empty, Icon, Menu, MenuItem, Modal, banner, PageQuote } from '../components'
import { ActivityFeed } from '../ActivityFeed'
import { createProject, setProjectStatus } from '../../state/actions'
import { canWrite } from '../../auth/session'
import { navigate } from '../../nav'
import { MediaThumb } from '../MediaThumb'

/** Humanized due text: "due today", "due in 3d", "2d overdue". */
export function dueInfo(dueAt: string): { text: string; overdue: boolean } {
  const due = new Date(dueAt)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const days = Math.round((due.getTime() - today.getTime()) / 86400000)
  if (days < 0) return { text: `${-days}d overdue`, overdue: true }
  if (days === 0) return { text: 'due today', overdue: false }
  if (days === 1) return { text: 'due tomorrow', overdue: false }
  if (days <= 7) return { text: `due in ${days}d`, overdue: false }
  return { text: `due ${due.toLocaleDateString()}`, overdue: false }
}

/** Wobbly hand-drawn ellipse, like someone circled the date in red pen. */
function ScribbleCircle(): React.JSX.Element {
  return (
    <svg className="scribble" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
      <path
        d="M10 22 C 20 8, 55 5, 78 11 C 97 16, 99 28, 74 33 C 48 38, 14 37, 6 27 C 1 21, 14 11, 34 8"
        fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" opacity="0.5"
      />
    </svg>
  )
}

export function Dashboard(): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const [search, setSearch] = useState('')
  const [groupFilter, setGroupFilter] = useState<string>('')
  const [labelFilter, setLabelFilter] = useState<string>('')
  const [assigneeFilter, setAssigneeFilter] = useState<string>('')
  const [overdueOnly, setOverdueOnly] = useState(false)
  // Quick-add: launched from the header (status = first column) or a column "+".
  const [quickAdd, setQuickAdd] = useState<{ status: string } | null>(null)
  const [activityOpen, setActivityOpen] = useState(false)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverCol, setDragOverCol] = useState<string | null>(null)
  const writable = canWrite()

  const projects = useMemo(() => {
    if (!doc) return []
    const q = search.trim().toLowerCase()
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    return Object.values(doc.projects)
      .filter((p) => p.deleted === null && p.archivedAt === null)
      .filter((p) => (groupFilter ? p.groupId === groupFilter : true))
      .filter((p) => (labelFilter ? p.labels.includes(labelFilter) : true))
      .filter((p) => (assigneeFilter ? p.assigneeAppId === assigneeFilter : true))
      .filter((p) => (overdueOnly ? p.dueAt !== null && new Date(p.dueAt) < today : true))
      .filter((p) => (q ? p.name.toLowerCase().includes(q) || p.notes.toLowerCase().includes(q) : true))
      .sort((a, b) => compareHlc(b.updatedAt, a.updatedAt))
  }, [doc, search, groupFilter, labelFilter, assigneeFilter, overdueOnly])

  if (!doc) return <></>

  const groups = Object.values(doc.groups).filter((g) => g.deleted === null)
  const labels = [...new Set(Object.values(doc.projects).flatMap((p) => p.labels))].sort()
  // Sticky-note shade per group — a group reads as one paper color on the
  // wall. Indexes map to the --sticky-N tokens via the sticky-N classes.
  const stickyByGroup: Record<string, number> = {}
  groups.forEach((g, i) => { stickyByGroup[g.id] = (i % 5) + 1 })

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
            <a href="/groups" onClick={(e) => { e.preventDefault(); navigate('groups') }}>manage groups</a>
            {' · '}
            <a href="/scripts" onClick={(e) => { e.preventDefault(); navigate('scripts') }}>scripts</a>
          </div>
        </div>
        <div className="row">
          <button className="btn" onClick={() => setActivityOpen(true)} title="Recent workspace changes">
            Activity
          </button>
          {writable && (
            <button className="btn primary" onClick={() => setQuickAdd({ status: doc.settings.pipeline[0]?.id ?? 'pending' })}>
              <Icon name="plus" size={14} /> New project
            </button>
          )}
        </div>
      </div>

      <PageQuote topic="board" />
      <div className="card mb8 board-filters">
        <div className="row wrap">
          <input
            className="input board-search"
            aria-label="Search projects"
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select className="input board-group-select" aria-label="Filter by group" value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}>
            <option value="">All groups</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          <select className="input board-assignee-select" aria-label="Filter by assignee" value={assigneeFilter} onChange={(e) => setAssigneeFilter(e.target.value)}>
            <option value="">Anyone</option>
            {doc.users.app.filter((u) => !u.disabled).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          {labels.length > 0 && (
            <div className="chips">
              {labels.map((l) => (
                <button key={l} className={`chip ${labelFilter === l ? 'on' : ''}`} aria-pressed={labelFilter === l} onClick={() => setLabelFilter(labelFilter === l ? '' : l)}>
                  {l}
                </button>
              ))}
            </div>
          )}
          <button className={`chip ${overdueOnly ? 'on' : ''} overdue`} aria-pressed={overdueOnly} onClick={() => setOverdueOnly(!overdueOnly)}>
            Overdue
          </button>
        </div>
      </div>

      {projects.length === 0 ? (
        <Empty icon="▦">
          No projects on the board yet.{' '}
          {writable
            ? 'Create one with “+ New project” — then drag cards between columns, or use a card’s ⋮ menu (that one works on touch too).'
            : ''}
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
                        aria-label={`Add a project in ${col.label}`}
                        onClick={() => setQuickAdd({ status: col.id })}
                      >
                        <Icon name="plus" size={12} />
                      </button>
                    )}
                  </span>
                </div>
                {colProjects.map((project) => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    groupName={doc.groups[project.groupId]?.name ?? null}
                    stickyIndex={stickyByGroup[project.groupId]}
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

      {activityOpen && (
        <Modal title="Recent activity" onClose={() => setActivityOpen(false)} wide>
          <ActivityFeed collapsedCount={30} />
        </Modal>
      )}
    </div>
  )
}

function ProjectCard({
  project,
  groupName,
  stickyIndex,
  draggable,
  dragging,
  onDragStart,
  onDragEnd,
  onOpen,
}: {
  project: Project
  groupName: string | null
  /** Undefined for sync-lag orphans — the card then falls back to the
   *  neutral --card shade instead of pretending to be group 1's color. */
  stickyIndex?: number
  draggable: boolean
  dragging: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onOpen: () => void
}): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const due = project.dueAt !== null ? dueInfo(project.dueAt) : null
  const overdue = due?.overdue ?? false
  const assignee = project.assigneeAppId ? doc?.users.app.find((u) => u.id === project.assigneeAppId)?.name : null
  const cover = project.fileIds[0]
  const otherStages = doc?.settings.pipeline.filter((st) => st.id !== project.status) ?? []
  return (
    <div
      className={`item-card${stickyIndex ? ` sticky-${stickyIndex}` : ''}${overdue ? ' overdue' : ''}${dragging ? ' dragging' : ''}`}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', project.id)
        e.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      onClick={onOpen}
    >
      {cover && (
        <MediaThumb
          fileKey={cover}
          style={{ height: 64, borderRadius: 'var(--radius-xs)', marginBottom: 7, background: 'rgba(255,255,255,0.4)' }}
        />
      )}
      <div className="title">
        {/* The title link is the card's keyboard + screen-reader open; the
            card-level onClick stays as the mouse shortcut. */}
        <a
          href={`/project/${project.id}`}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onOpen()
          }}
        >
          {project.name}
        </a>
      </div>
      <div className="meta">
        {groupName && <span>{groupName}</span>}
        {assignee && <span>· {assignee}</span>}
        {due && (
          <span className={`due-wrap${overdue ? ' overdue' : ''}`}>
            {overdue && <ScribbleCircle />}
            · {due.text}
          </span>
        )}
        {project.fileIds.length > 0 && (
          <span className="row">
            · <Icon name="paperclip" size={11} />
            {project.fileIds.length}
          </span>
        )}
      </div>
      {project.labels.length > 0 && (
        <div className="chips mt8">
          {project.labels.map((l) => <span key={l} className="badge label">{l}</span>)}
        </div>
      )}
      {draggable && otherStages.length > 0 && (
        <span className="item-card-menu">
          <Menu
            label={`Move ${project.name}`}
            trigger={({ ref, onClick, 'aria-expanded': expanded, 'aria-haspopup': popup }) => (
              <button
                ref={ref}
                draggable={false}
                onClick={(e) => {
                  e.stopPropagation()
                  onClick(e)
                }}
                aria-expanded={expanded}
                aria-haspopup={popup}
                className="item-card-menu-btn"
                title="Move to another stage"
                aria-label={`Move ${project.name} to another stage`}
              >
                <Icon name="dots" size={13} />
              </button>
            )}
          >
            {otherStages.map((st) => (
              <MenuItem key={st.id} icon="move" onSelect={() => setProjectStatus(project.id, st.id)}>
                Move to {st.label}
              </MenuItem>
            ))}
          </Menu>
        </span>
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
        // Status rides the create — one commit/save instead of two.
        const id = await createProject({ groupId, name: n, status: presetStatus || undefined })
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
