import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'
import { bindRouter } from './nav'

export function getRouter() {
  const router = createRouter({ routeTree })
  bindRouter(router)
  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
