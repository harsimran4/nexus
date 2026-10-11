import { compareHlc } from '../../../util/hlc'
import { Icon } from '../../components'
import { ProjectCard } from './ProjectCard'
import type { BoardViewProps } from './types'

/** Shelves — the board organized by GROUP instead of status: one tinted
 *  band per group (the group's chosen paper shade), cards carrying a status
 *  pill. Projects spread across many groups, so nothing piles up; status
 *  changes go through the card's ⋮ menu. Group order matches the Groups
 *  page (recently updated first). */
export function ShelvesView({ doc, projects, groups, colorByGroup, writable, onQuickAdd, onOpen, onOpenGroup }: BoardViewProps): React.JSX.Element {
  const ordered = [...groups].sort((a, b) => compareHlc(b.updatedAt, a.updatedAt))
  // Live project whose group is missing/tombstoned (sync-lag) — park it in
  // an explicit Ungrouped shelf instead of dropping it silently.
  const orphans = projects.filter((p) => {
    const g = doc.groups[p.groupId]
    return !g || g.deleted !== null
  })

  const renderCards = (shelfProjects: typeof projects) => (
    <div className="lane-grid">
      {shelfProjects.map((project) => (
        <ProjectCard
          key={project.id}
          project={project}
          groupName={null}
          colorKey={colorByGroup[project.groupId] ?? ''}
          canMove={writable}
          statusPill
          onOpen={() => onOpen(project.id)}
        />
      ))}
    </div>
  )

  return (
    <div className="shelves">
      {ordered.map((g) => {
        const shelfProjects = projects.filter((p) => p.groupId === g.id)
        return (
          <section key={g.id} className={`shelf${shelfProjects.length === 0 ? ' shelf-empty' : ''}`}>
            <div className={`shelf-head ${colorByGroup[g.id] ?? ''}`}>
              {/* The name link is the real control; the card-level patterns
                  elsewhere don't apply — this band isn't clickable itself. */}
              <a
                href={`/group/${g.id}`}
                className="shelf-title"
                onClick={(e) => {
                  e.preventDefault()
                  onOpenGroup(g.id)
                }}
              >
                {g.name}
              </a>
              <span className="row">
                <span className="count">{shelfProjects.length}</span>
                {writable && (
                  <button
                    className="btn ghost small"
                    title={`Add a project in ${g.name}`}
                    aria-label={`Add a project in ${g.name}`}
                    onClick={() => onQuickAdd(undefined, g.id)}
                  >
                    <Icon name="plus" size={12} />
                  </button>
                )}
              </span>
            </div>
            {shelfProjects.length > 0 ? (
              renderCards(shelfProjects)
            ) : (
              <div className="faint small shelf-empty-note">
                {writable ? 'No active projects — “+” adds one here.' : 'No active projects.'}
              </div>
            )}
          </section>
        )
      })}
      {orphans.length > 0 && (
        <section className="shelf">
          <div className="shelf-head">
            <span className="shelf-title">Ungrouped</span>
            <span className="count">{orphans.length}</span>
          </div>
          {renderCards(orphans)}
        </section>
      )}
    </div>
  )
}
