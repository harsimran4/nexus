import { expect, test } from '@playwright/test'
import { dismissRecovery, login, waitSynced } from './helpers'

// P5 — live push: a write in tab A must reach tab B through the hub's
// WebSocket, not the poller. The seeded doc polls every 60s, so any state
// arriving within seconds of the write is push-delivered; the '[hub] push'
// console line (nexus.hubDebug) is the direct evidence of the socket path.

test.describe('live push', () => {
  test('a rename in one tab appears in another without polling', async ({ browser }) => {
    // Receiver FIRST — it must be connected before the write happens.
    const receiver = await browser.newContext()
    const b = await receiver.newPage()
    await b.addInitScript(() => {
      try {
        localStorage.setItem('nexus.hubDebug', '1')
      } catch {
        /* private mode */
      }
    })
    const events: string[] = []
    const pushes = () => events.filter((e) => e.includes('[hub] push'))
    b.on('console', (msg) => {
      if (msg.text().includes('[hub]')) events.push(msg.text())
    })
    await login(b)
    // The socket must be open before the write, or the test would pass on
    // reconnect-poll alone.
    await expect
      .poll(() => events.some((e) => e.includes('open')), { timeout: 10_000, message: 'receiving tab never opened the hub socket' })
      .toBe(true)

    // Writer tab — a second, independent session.
    const writer = await browser.newContext()
    const a = await writer.newPage()
    await login(a)
    await a.goto('/project/prj_e2e_move')
    const name = a.locator('input[aria-label="Project name"]')
    await expect(name).toBeVisible({ timeout: 20_000 })

    // Only pushes caused by THIS write count.
    events.length = 0
    await name.fill('Push Renamed')
    await name.press('Enter')
    await waitSynced(a)

    // 1) The socket path fired (poller is 60s — it cannot be the deliverer).
    await expect
      .poll(() => pushes().length, { timeout: 5_000, message: 'receiving tab saw no [hub] push after the write' })
      .toBeGreaterThan(0)
    // 2) And the merge landed in B's UI without a reload.
    await expect(b.locator('.item-card', { hasText: 'Push Renamed' }).first()).toBeVisible({ timeout: 5_000 })

    // Leave the workspace exactly as later test files expect it: the bucket
    // persists for the whole run and login() greps for this card's name.
    await name.fill('E2E Move Target')
    await name.press('Enter')
    await waitSynced(a)
    await expect(b.locator('.item-card', { hasText: 'E2E Move Target' }).first()).toBeVisible({ timeout: 5_000 })
  })
})
