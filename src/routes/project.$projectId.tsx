import { createFileRoute } from '@tanstack/react-router'
import { ProjectPage } from '../ui/pages/ProjectPage'
import { parseMediaView } from '../util/mediaUrl'

export const Route = createFileRoute('/project/$projectId')({
  // Tab + media view state ride the URL (see util/mediaUrl.ts) — refresh,
  // Back/Forward, and shared links preserve the exact view.
  validateSearch: parseMediaView,
  component: () => {
    const { projectId } = Route.useParams()
    return <ProjectPage projectId={projectId} />
  },
})
