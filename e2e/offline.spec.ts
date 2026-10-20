import { expect, test } from '@playwright/test'
import { dismissRecovery, login } from './helpers'

// P6 — offline reads + instant boot. A reload whose workspace reads all fail
// paints the last good snapshot (IndexedDB boot cache) labelled Offline, and
// a normal reload still lands Synced. The interception blocks the workspace
// READS (server fns + the public doc route) rather than the whole network —
// setOffline(true) would keep the SPA shell itself from loading, which is a
// browser-cache concern, not the boot path under test.

test.describe('offline reads', () => {
  test('reload with unreachable workspace paints the cached snapshot, labelled offline', async ({ page }) => {
    await login(page) // normal load — the boot cache is populated

    await page.context().route('**/_serverFn/**', (r) => r.abort())
    await page.context().route('**/files/**', (r) => r.abort())
    await page.reload()

    // The cached snapshot painted the board.
    await expect(page.locator('.item-card', { hasText: 'E2E Move Target' })).toBeVisible({ timeout: 20_000 })
    // …and the honest label: the Offline pill + the banner with the stale age.
    await expect(page.locator('.pill.offline')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('Showing your workspace as of', { exact: false })).toBeVisible()
  })

  test('a normal reload still lands Synced (cache paints first, revalidate replaces)', async ({ page }) => {
    await login(page)
    await page.reload()
    await dismissRecovery(page)
    await expect(page.locator('.pill', { hasText: 'Synced' })).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.item-card', { hasText: 'E2E Move Target' })).toBeVisible({ timeout: 20_000 })
  })
})
