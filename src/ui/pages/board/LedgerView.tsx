import { StatusBadge } from '../../components'
import { dueInfo } from './ProjectCard'
import type { BoardViewProps } from './types'

/** Ledger — one account-book row per project: densest possible view, built
 *  for scanning a big Finished pile. Sort comes from the header select
 *  (recent / due date / name); rows open the project. */
export function LedgerView({ doc, projects, colorByGroup, onOpen }: BoardViewProps): React.JSX.Element {
  return (
    <div className="card board-ledger-card">
      <table className="table ledger">
        <thead>
          <tr>
            <th>Name</th>
            <th>Group</th>
            <th>Status</th>
            <th>Due</th>
            <th>Files</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => {
            const due = p.dueAt !== null ? dueInfo(p.dueAt) : null
            return (
              <tr key={p.id} className="clickable" onClick={() => onOpen(p.id)}>
                <td className="ledger-name">
                  {/* The name is the real control: keyboard + screen-reader
                      activation; the row-level onClick is a mouse shortcut. */}
                  <a
                    href={`/project/${p.id}`}
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      onOpen(p.id)
                    }}
                  >
                    {p.name}
                  </a>
                </td>
                <td className="muted small">
                  <span className={`group-dot ${colorByGroup[p.groupId] ?? ''}`} aria-hidden="true" />
                  {doc.groups[p.groupId]?.name ?? '—'}
                </td>
                <td><StatusBadge doc={doc} status={p.status} /></td>
                <td className={`small${due?.overdue ? ' ledger-overdue' : ''}`}>
                  {due ? due.text : '—'}
                </td>
                <td className="small muted">{p.fileIds.length}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
