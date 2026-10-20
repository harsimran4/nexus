import { expect, test } from '@playwright/test'
import { GUEST_TOKEN } from './helpers'

// The guest journey uses the SEEDED link (scripts/seed-dev.mjs owns the raw
// token) so the journey exercises exactly what a client receives: a bare
// /upload/<token> page, no shell, no login.

test.describe('guest upload journey', () => {
  test('a valid link uploads and reports honest completion', async ({ page }) => {
    await page.goto(`/upload/${GUEST_TOKEN}`)
    await expect(page.locator('h1')).toContainText('E2E Upload Target')
    await expect(page.locator('.chip.on')).toContainText('Raw')

    await page.locator('input[type="file"]').setInputFiles({
      name: 'guest-file.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('from your client, over the real presigned path'),
    })
    await expect(page.getByText('All done', { exact: false })).toBeVisible({ timeout: 30_000 })
  })

  test('a dead link says so honestly', async ({ page }) => {
    await page.goto('/upload/not-a-real-token')
    await expect(page.getByText('not valid or has expired')).toBeVisible({ timeout: 20_000 })
  })
})
