// The deployed Worker serves the prerendered SPA shell for `/` (asset-cached,
// so browsers can pin it for a while). The app self-checks: fetch the shell
// bypassing the cache, read its app-version meta tag, and surface "update
// available" when it differs from the running bundle's version. The admin
// deploys; users see a one-click refresh banner instead of running old code.

import { config } from '../config'

export async function checkForUpdate(): Promise<boolean> {
  try {
    const res = await fetch(`/?t=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) return false
    const text = await res.text()
    const match = text.match(/<meta[^>]+name="app-version"[^>]+content="([^"]+)"/)
    if (!match) return false // older shell without the tag — nothing to compare
    return match[1] !== config.appVersion
  } catch {
    return false // offline — nothing to announce
  }
}
