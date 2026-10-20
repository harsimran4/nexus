import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'
import { bindRouter } from './nav'
import { RouteError } from './ui/components/ErrorBoundary'

export function getRouter() {
  const router = createRouter({
    routeTree,
    // A crash inside any page replaces just that page with a recovery screen
    // and beacons — the shell, sidebar and session all stay alive. Without a
    // defaultErrorComponent, TanStack installs NO boundary at all and an
    // uncaught render error unmounts React to a blank screen.
    defaultErrorComponent: RouteError,
  })
  bindRouter(router)
  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
