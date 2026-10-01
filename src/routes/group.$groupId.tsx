import { createFileRoute } from '@tanstack/react-router'
import { GroupView } from '../ui/pages/GroupView'

export const Route = createFileRoute('/group/$groupId')({
  component: () => {
    const { groupId } = Route.useParams()
    return <GroupView groupId={groupId} />
  },
})
