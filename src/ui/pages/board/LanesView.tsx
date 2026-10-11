import { useState } from 'react'
import { setProjectStatus } from '../../../state/actions'
import { Icon } from '../../components'
import { ProjectCard } from './ProjectCard'
import type { BoardViewProps } from './types'

/** Lanes — the kanban rotated 90°: one full-width band per pipeline stage,
 *  cards flowing left-to-right and wrapping into rows. A huge Finished stage
 *  becomes a dense wall instead of an endless column. Drag between bands. */
export function LanesView({ doc, projects, colorByGroup, writable, onQuickAdd, onOpen }: BoardViewProps): React.JSX.Element {
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)

  return (
    <div className="lanes">
      {doc.settings.pipeline.map((col) => {
        const colProjects = projects.filter((p) => p.status === col.id)
        return (
          <section
            key={col.id}
            className={`lane${dragOver === col.id ? ' drag-over' : ''}`}
            onDragOver={(e) => {
              if (!writable || dragId === null) return
              e.preventDefault()
              setDragOver(col.id)
            }}
            onDragLeave={() => setDragOver((c) => (c === col.id ? null : c))}
            onDrop={(e) => {
              e.preventDefault()
              if (dragId && writable) {
                const p = doc.projects[dragId]
                if (p && p.status !== col.id) setProjectStatus(dragId, col.id)
              }
              setDragId(null)
              setDragOver(null)
            }}
          >
            <div className="lane-head">
              <h3>{col.label}</h3>
              <span className="row">
                <span className="count">{colProjects.length}</span>
                {writable && (
                  <button
                    className="btn ghost small"
                    title={`Add a project in ${col.label}`}
                    aria-label={`Add a project in ${col.label}`}
                    onClick={() => onQuickAdd(col.id)}
                  >
                    <Icon name="plus" size={12} />
                  </button>
                )}
              </span>
            </div>
            {colProjects.length > 0 ? (
              <div className="lane-grid">
                {colProjects.map((project) => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    groupName={doc.groups[project.groupId]?.name ?? null}
                    colorKey={colorByGroup[project.groupId] ?? ''}
                    canMove={writable}
                    draggable={writable}
                    dragging={dragId === project.id}
                    onDragStart={() => setDragId(project.id)}
                    onDragEnd={() => {
                      setDragId(null)
                      setDragOver(null)
                    }}
                    onOpen={() => onOpen(project.id)}
                  />
                ))}
              </div>
            ) : (
              <div className="faint small lane-empty">{writable ? 'Drag a card here' : '—'}</div>
            )}
          </section>
        )
      })}
    </div>
  )
}
