import { useRef } from 'react'
import { useStore } from '../../../sync/store'
import { type Project } from '../../../types/schema'
import { Icon, Menu, MenuItem, StatusBadge } from '../../components'
import { setProjectStatus } from '../../../state/actions'
import { MediaThumb } from '../../MediaThumb'

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

/** The one project card every board view renders. A group's shade reads as
 *  a soft wash (colorKey → .sticky-N → --sticky mixed into the card). */
export function ProjectCard({
  project,
  groupName,
  colorKey,
  canMove,
  draggable = false,
  dragging = false,
  statusPill = false,
  onDragStart,
  onDragEnd,
  onOpen,
}: {
  project: Project
  groupName: string | null
  /** '' for sync-lag orphans or 'none' groups — the card then falls back to
   *  the neutral --card shade instead of pretending to be some group's color. */
  colorKey: string
  /** Gates the ⋮ move menu (editors+). Views without drop targets keep the
   *  menu — there it's the only way to change a card's status. */
  canMove: boolean
  /** HTML5 drag source (columns/lanes only — the views with drop targets). */
  draggable?: boolean
  dragging?: boolean
  /** Status pill in the meta row (views without status bands). */
  statusPill?: boolean
  onDragStart?: () => void
  onDragEnd?: () => void
  onOpen: () => void
}): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const due = project.dueAt !== null ? dueInfo(project.dueAt) : null
  const overdue = due?.overdue ?? false
  const assignee = project.assigneeAppId ? doc?.users.app.find((u) => u.id === project.assigneeAppId)?.name : null
  const cover = project.fileIds[0]
  const otherStages = doc?.settings.pipeline.filter((st) => st.id !== project.status) ?? []
  // When the ⋮ menu closes, the exit-animated panel can vanish under a fast
  // follow-up click and the card itself becomes the click target — opening the
  // project the user was only moving. A short guard swallows that stray click
  // (real card opens are deliberate, never within 500ms of a menu action).
  const menuActionAt = useRef(0)
  return (
    <div
      className={`item-card${colorKey ? ` ${colorKey}` : ''}${overdue ? ' overdue' : ''}${dragging ? ' dragging' : ''}`}
      draggable={draggable}
      onDragStart={
        onDragStart
          ? (e) => {
              e.dataTransfer.setData('text/plain', project.id)
              e.dataTransfer.effectAllowed = 'move'
              onDragStart()
            }
          : undefined
      }
      onDragEnd={onDragEnd}
      onClick={() => {
        if (Date.now() - menuActionAt.current < 500) return
        onOpen()
      }}
    >
      {cover && (
        <MediaThumb
          fileKey={cover}
          style={{ height: 64, borderRadius: 'var(--radius-sm)', marginBottom: 7, background: 'var(--panel-2)' }}
        />
      )}
      {statusPill && doc && (
        <div className="item-card-status">
          <StatusBadge doc={doc} status={project.status} />
        </div>
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
      {canMove && otherStages.length > 0 && (
        <span className="item-card-menu">
          <Menu
            label={`Move ${project.name}`}
            trigger={({ ref, onClick, 'aria-expanded': expanded, 'aria-haspopup': popup }) => (
              <button
                ref={ref}
                draggable={false}
                onClick={(e) => {
                  e.stopPropagation()
                  menuActionAt.current = Date.now()
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
