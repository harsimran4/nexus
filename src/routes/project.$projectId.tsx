import { createFileRoute } from '@tanstack/react-router'
import { ProjectPage } from '../ui/pages/ProjectPage'

export const Route = createFileRoute('/project/$projectId')({
  component: () => {
    const { projectId } = Route.useParams()
    return <ProjectPage projectId={projectId} />
  },
})
