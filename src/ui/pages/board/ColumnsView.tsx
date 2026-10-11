import { useState } from 'react'
import { setProjectStatus } from '../../../state/actions'
import { Icon } from '../../components'
import { ProjectCard } from './ProjectCard'
import type { BoardViewProps } from './types'

/** Columns — the original kanban: one narrow column per pipeline stage,
 *  vertical stacks, drag between columns. Best when every stage is small. */
export function ColumnsView({ doc, projects, colorByGroup, writable, onQuickAdd, onOpen }: BoardViewProps): React.JSX.Element {
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverCol, setDragOverCol] = useState<string | null>(null)

  const drop = (status: string) => {
    if (dragId && writable) {
      const p = doc.projects[dragId]
      if (p && p.status !== status) setProjectStatus(dragId, status)
    }
    setDragId(null)
    setDragOverCol(null)
  }

  return (
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
                    onClick={() => onQuickAdd(col.id)}
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
                colorKey={colorByGroup[project.groupId] ?? ''}
                canMove={writable}
                draggable={writable}
                dragging={dragId === project.id}
                onDragStart={() => setDragId(project.id)}
                onDragEnd={() => {
                  setDragId(null)
                  setDragOverCol(null)
                }}
                onOpen={() => onOpen(project.id)}
              />
            ))}
            {colProjects.length === 0 && <div className="faint small">{writable ? 'Drag a card here' : '—'}</div>}
          </div>
        )
      })}
    </div>
  )
}
