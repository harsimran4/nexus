// GitHub Pages pins index.html in browsers for up to 10 minutes (max-age=600,
// not overridable on *.github.io). So the app self-checks: fetch the live
// index.html bypassing the cache, compare its appVersion to the running one,
// and surface "update available" when they differ. The admin deploys; users
// see a one-click refresh banner instead of silently running old code.

import { config } from '../config'

export async function checkForUpdate(): Promise<boolean> {
  try {
    const res = await fetch(`index.html?t=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) return false
    const text = await res.text()
    const match = text.match(/appVersion:\s*"([^"]+)"/)
    if (!match) return false
    return match[1] !== config.appVersion
  } catch {
    return false // offline — nothing to announce
  }
}
