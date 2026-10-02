// Navigate bridge: the pages all import { navigate } — one tiny module so
// they don't each need the router instance. router.tsx binds the real
// router at startup.

let bound: { navigate: (to: string) => void } | null = null

export function bindRouter(r: { navigate: (opts: { to: string }) => void }): void {
  bound = {
    navigate: (to: string) => {
      void r.navigate({ to })
    },
  }
}

/** Old hash-style paths ('dash', 'project/<id>') → real paths. 'dash' has no
 *  route of its own — the Board IS '/'. */
export function navigate(to: string): void {
  const clean = to.replace(/^\/+/, '').replace(/^#\/?/, '')
  const path = clean === 'dash' || clean === '' ? '/' : '/' + clean
  if (bound) bound.navigate(path)
  else location.href = path
}
