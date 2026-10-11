import { ProjectCard } from './ProjectCard'
import type { BoardViewProps } from './types'

/** Wall — no sections at all: every project is one card in a single dense
 *  grid, like a corkboard. The tape strip carries the status bucket color,
 *  the paper carries the group shade; the chips above filter down to a
 *  slice. Respects the header sort (recent / due / name). */
export function WallView({ doc, projects, colorByGroup, writable, onOpen }: BoardViewProps): React.JSX.Element {
  return (
    <div className="wall-grid">
      {projects.map((project) => (
        <ProjectCard
          key={project.id}
          project={project}
          groupName={doc.groups[project.groupId]?.name ?? null}
          colorKey={colorByGroup[project.groupId] ?? ''}
          canMove={writable}
          statusPill
          statusTape
          onOpen={() => onOpen(project.id)}
        />
      ))}
    </div>
  )
}
