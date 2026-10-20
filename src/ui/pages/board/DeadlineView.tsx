import { useMemo } from 'react'
import type { Project } from '../../../types/schema'
import { Icon } from '../../components'
import { dueInfo } from './ProjectCard'
import type { BoardViewProps } from './types'

/** Deadline — projects WITH due dates, bucketed by urgency: Overdue / This
 *  week / Next week / Later. Projects without a due date stay on the other
 *  views (they'd be noise here). Buckets recompute per render — the counts
 *  are small and the board re-renders on every doc change anyway. */

const DAY = 86_400_000

interface Bucket {
  id: string
  label: string
  projects: Project[]
}

function bucketOf(dueAt: string, startOfToday: number): string {
  const due = new Date(dueAt)
  due.setHours(0, 0, 0, 0)
  const days = Math.round((due.getTime() - startOfToday) / DAY)
  if (days < 0) return 'overdue'
  if (days <= 6) return 'this-week'
  if (days <= 13) return 'next-week'
  return 'later'
}

export function DeadlineView({ doc, projects, onOpen }: BoardViewProps): React.JSX.Element {
  const buckets = useMemo<Bucket[]>(() => {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    const startOfToday = start.getTime()
    const b: Record<string, Bucket> = {
      overdue: { id: 'overdue', label: 'Overdue', projects: [] },
      'this-week': { id: 'this-week', label: 'This week', projects: [] },
      'next-week': { id: 'next-week', label: 'Next week', projects: [] },
      later: { id: 'later', label: 'Later', projects: [] },
    }
    for (const p of projects) {
      if (p.deleted !== null || p.dueAt === null) continue
      b[bucketOf(p.dueAt, startOfToday)].projects.push(p)
    }
    // Soonest first inside every bucket.
    for (const k of Object.keys(b)) {
      b[k].projects.sort((a, c) => (a.dueAt ?? '') < (c.dueAt ?? '') ? -1 : 1)
    }
    return [b.overdue, b['this-week'], b['next-week'], b.later]
  }, [projects])

  const withDue = buckets.reduce((n, b) => n + b.projects.length, 0)

  return (
    <div className="lanes">
      {withDue === 0 && (
        <div className="card">
          <span className="muted small">
            Nothing on the clock — projects appear here the moment they carry a due date.
          </span>
        </div>
      )}
      {buckets.map((b) =>
        b.projects.length === 0 && b.id !== 'overdue' ? null : (
          <section key={b.id} className={`lane${b.id === 'overdue' && b.projects.length > 0 ? ' deadline-overdue' : ''}`}>
            <div className="lane-head">
              <h3>
                {b.id === 'overdue' && b.projects.length > 0 && <Icon name="alert" size={12} />} {b.label}
              </h3>
              <span className="count">{b.projects.length}</span>
            </div>
            {b.projects.length === 0 ? (
              <div className="lane-empty faint small">Nothing overdue.</div>
            ) : (
              <div className="deadline-grid">
                {b.projects.map((p) => {
                  const due = p.dueAt !== null ? dueInfo(p.dueAt) : null
                  const group = doc.groups[p.groupId]
                  return (
                    <button
                      key={p.id}
                      className="deadline-card"
                      onClick={() => onOpen(p.id)}
                      title={p.notes || undefined}
                    >
                      <span className="deadline-name">{p.name}</span>
                      <span className={`deadline-due${due?.overdue ? ' overdue' : ''}`}>
                        {due?.text ?? ''}
                      </span>
                      <span className="deadline-meta small faint">
                        {group?.name ?? ''}
                        {p.assigneeAppId ? ` · ${doc.users.app.find((u) => u.id === p.assigneeAppId)?.name ?? ''}` : ''}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </section>
        ),
      )}
    </div>
  )
}
