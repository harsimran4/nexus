import { useMemo, useState } from 'react'
import { useStore } from '../../sync/store'
import { compareHlc } from '../../util/hlc'
import { groupColorMap } from '../../util/groups'
import { Empty, Icon, Modal, banner, PageQuote } from '../components'
import { ActivityFeed } from '../ActivityFeed'
import { createProject } from '../../state/actions'
import { canWrite } from '../../auth/session'
import { navigate } from '../../nav'
import { ColumnsView } from './board/ColumnsView'
import { LanesView } from './board/LanesView'
import { ShelvesView } from './board/ShelvesView'
import { WallView } from './board/WallView'
import { LedgerView } from './board/LedgerView'

/** The board layouts. Pick per browser — persisted like nexus.theme. */
const VIEWS = [
  { id: 'columns', label: 'Columns' },
  { id: 'lanes', label: 'Lanes' },
  { id: 'shelves', label: 'Shelves' },
  { id: 'wall', label: 'Wall' },
  { id: 'ledger', label: 'Ledger' },
] as const
type BoardView = (typeof VIEWS)[number]['id']
const VIEW_KEY = 'nexus.board.view'

function readBoardView(): BoardView {
  try {
    if (typeof window === 'undefined') return 'columns'
    const v = localStorage.getItem(VIEW_KEY)
    return VIEWS.some((x) => x.id === v) ? (v as BoardView) : 'columns'
  } catch {
    return 'columns'
  }
}

/** Card order inside the views (wall uses it directly; lanes/shelves/columns
 *  within each band). Due sorts soonest-first, undated last. */
const SORTS = [
  { id: 'recent', label: 'Recently updated' },
  { id: 'due', label: 'Due date' },
  { id: 'name', label: 'Name' },
] as const
type BoardSort = (typeof SORTS)[number]['id']
const SORT_KEY = 'nexus.board.sort'

function readBoardSort(): BoardSort {
  try {
    if (typeof window === 'undefined') return 'recent'
    const s = localStorage.getItem(SORT_KEY)
    return SORTS.some((x) => x.id === s) ? (s as BoardSort) : 'recent'
  } catch {
    return 'recent'
  }
}

export function Dashboard(): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const [view, setView] = useState<BoardView>(readBoardView)
  const [sort, setSort] = useState<BoardSort>(readBoardSort)
  const [search, setSearch] = useState('')
  const [groupFilter, setGroupFilter] = useState<string>('')
  const [labelFilter, setLabelFilter] = useState<string>('')
  const [assigneeFilter, setAssigneeFilter] = useState<string>('')
  const [overdueOnly, setOverdueOnly] = useState(false)
  // Quick-add: launched from the header (first column), a column/lanes "+"
  // (status preset) or a shelf "+" (group preset).
  const [quickAdd, setQuickAdd] = useState<{ status?: string; groupId?: string } | null>(null)
  const [activityOpen, setActivityOpen] = useState(false)
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
      .sort((a, b) => {
        if (sort === 'name') return a.name.localeCompare(b.name)
        if (sort === 'due') {
          if (a.dueAt === null && b.dueAt === null) return compareHlc(b.updatedAt, a.updatedAt)
          if (a.dueAt === null) return 1
          if (b.dueAt === null) return -1
          return new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime()
        }
        return compareHlc(b.updatedAt, a.updatedAt)
      })
  }, [doc, search, groupFilter, labelFilter, assigneeFilter, overdueOnly, sort])

  // Group shade per card — explicit group colors win, the rest share what's
  // left (see groupColorMap). Hooks stay above the doc early-return.
  const colorByGroup = useMemo(() => {
    if (!doc) return {}
    return groupColorMap(Object.values(doc.groups).filter((g) => g.deleted === null))
  }, [doc])

  if (!doc) return <></>

  const groups = Object.values(doc.groups).filter((g) => g.deleted === null)
  const labels = [...new Set(Object.values(doc.projects).flatMap((p) => p.labels))].sort()

  const openProject = (id: string): void => navigate('project/' + id)
  const openGroup = (id: string): void => navigate('group/' + id)
  const pickView = (v: BoardView): void => {
    setView(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      /* private mode — the switch just won't persist */
    }
  }
  const pickSort = (s: BoardSort): void => {
    setSort(s)
    try {
      localStorage.setItem(SORT_KEY, s)
    } catch {
      /* same */
    }
  }

  const viewProps = {
    doc,
    projects,
    groups,
    colorByGroup,
    writable,
    onQuickAdd: (status?: string, groupId?: string) => setQuickAdd({ status, groupId }),
    onOpen: openProject,
    onOpenGroup: openGroup,
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
            <button
              className="btn primary"
              onClick={() => setQuickAdd({ status: doc.settings.pipeline[0]?.id })}
            >
              <Icon name="plus" size={14} /> New project
            </button>
          )}
        </div>
      </div>

      <PageQuote topic="board" />

      <div className="board-views" role="group" aria-label="Board layout">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            className={`chip ${view === v.id ? 'on' : ''}`}
            aria-pressed={view === v.id}
            title={VIEW_TITLES[v.id]}
            onClick={() => pickView(v.id)}
          >
            {v.label}
          </button>
        ))}
        <span className="row board-sort">
          <label className="faint small" htmlFor="board-sort">Sort</label>
          <select
            id="board-sort"
            className="input board-sort-select"
            value={sort}
            onChange={(e) => pickSort(e.target.value as BoardSort)}
          >
            {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </span>
      </div>

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
      ) : view === 'columns' ? (
        <ColumnsView {...viewProps} />
      ) : view === 'lanes' ? (
        <LanesView {...viewProps} />
      ) : view === 'shelves' ? (
        <ShelvesView {...viewProps} />
      ) : view === 'wall' ? (
        <WallView {...viewProps} />
      ) : (
        <LedgerView {...viewProps} />
      )}

      {quickAdd && (
        <QuickAddModal
          presetStatus={quickAdd.status ?? doc.settings.pipeline[0]?.id ?? 'pending'}
          defaultGroup={quickAdd.groupId ?? groupFilter}
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

const VIEW_TITLES: Record<BoardView, string> = {
  columns: 'Classic kanban — one column per stage',
  lanes: 'Full-width status bands — cards wrap into rows',
  shelves: 'One band per group, status pills on cards',
  wall: 'One dense grid of every project — filter with the chips',
  ledger: 'Account-book rows — densest scan',
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
