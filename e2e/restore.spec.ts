import { expect, test } from '@playwright/test'
import { login } from './helpers'

test.describe('snapshot restore journey', () => {
  test('Maintenance restores the seeded snapshot behind type-to-confirm', async ({ page }) => {
    await login(page)
    await page.goto('/admin')
    await page.getByRole('button', { name: 'Maintenance' }).click()

    const row = page.locator('.admin-row', { hasText: '2026-01-01' })
    await expect(row).toBeVisible({ timeout: 20_000 })
    await row.getByRole('button', { name: 'Restore' }).click()

    // Type-to-confirm gate (the destructive-action pattern).
    await expect(page.locator('.modal')).toContainText('Restore snapshot rev')
    await page.locator('.modal input.input').fill('restore')
    await page.getByRole('button', { name: 'Restore snapshot' }).click()

    await expect(page.getByText('Restored to rev 7')).toBeVisible({ timeout: 30_000 })
  })
})
