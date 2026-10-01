import { createFileRoute } from '@tanstack/react-router'
import { Login } from '../ui/pages/Login'

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): { vw?: string } => ({
    vw: typeof search.vw === 'string' ? search.vw : undefined,
  }),
  component: () => {
    const { vw } = Route.useSearch()
    return <Login viewerTokenFromLink={vw ?? null} />
  },
})
