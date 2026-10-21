import { Outlet } from '@tanstack/react-router'
import { createFileRoute } from '@tanstack/react-router'

// Layout route: '/scripts' renders the library (scripts.index), and
// '/scripts/$scriptId' renders the script workspace as its child.
export const Route = createFileRoute('/scripts')({ component: () => <Outlet /> })
