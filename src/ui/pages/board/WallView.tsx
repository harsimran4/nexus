import { ProjectCard } from './ProjectCard'
import type { BoardViewProps } from './types'

/** Wall — no sections at all: every project is one card in a single dense
 *  grid. The card carries the group shade as a wash and its own status pill;
 *  the chips above filter down to a slice. Respects the header sort
 *  (recent / due / name). */
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
          onOpen={() => onOpen(project.id)}
        />
      ))}
    </div>
  )
}
