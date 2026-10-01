// Navigate bridge: the pages all import { navigate } — one tiny module so
// they don't each need the router instance. router.tsx binds the real
// router at startup.

import type { Router } from '@tanstack/react-router'

let bound: { navigate: (to: string) => void } | null = null

export function bindRouter(r: { navigate: (opts: { to: string }) => void }): void {
  bound = {
    navigate: (to: string) => {
      void r.navigate({ to })
    },
  }
}

/** Old hash-style paths ('dash', 'project/<id>') → real paths. */
export function navigate(to: string): void {
  const path = '/' + to.replace(/^\/+/, '').replace(/^#\/?/, '')
  if (bound) bound.navigate(path)
  else location.href = path
}
