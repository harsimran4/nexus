import { expect, test } from '@playwright/test'
import { login, waitSynced } from './helpers'

test.describe('script save + milestone journey', () => {
  test('create, edit, save, and freeze a Review milestone copy', async ({ page }) => {
    await login(page)
    await page.goto('/scripts')

    await page.getByRole('button', { name: 'New script' }).click()
    await page.getByPlaceholder('e.g. Q4 launch voiceover').fill('E2E Journey Script')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(page.locator('.script-title')).toHaveValue('E2E Journey Script')

    // Edit the body and save (the debounced writer confirms to storage).
    const body = page.getByPlaceholder('Write the script…')
    await body.fill('# E2E journey\n\nA line worth freezing.\n')
    await page.getByRole('button', { name: 'Save body' }).click()
    await expect(page.locator('.toast', { hasText: /saved|Saved/i }).or(page.getByText('Synced'))).toBeVisible({
      timeout: 20_000,
    })

    // Status → review: changeStatus saves the body first, then freezes the
    // milestone copy — no separate Save click needed (its button is disabled
    // when there's nothing dirty, which is correct).
    await page.locator('select.script-status').selectOption('review')
    await expect(page.locator('.script-copy')).toHaveCount(1, { timeout: 30_000 })
    await expect(page.locator('.script-copy')).toContainText('review', { ignoreCase: true })
    await waitSynced(page)
  })
})
