import { expect, test } from '@playwright/test'
import { ADMIN_PASSWORD, login } from './helpers'

test.describe('sign-in journey', () => {
  test('wrong password shows the error banner, no session', async ({ page }) => {
    await page.goto('/login')
    await page.getByPlaceholder('nexus token or password').fill('totally wrong password')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.locator('.banner.error')).toBeVisible()
  })

  test('correct password lands on the board, session survives a reload', async ({ page }) => {
    await login(page)
    await page.reload()
    // Session cookie/token persisted — the board still shows the signed-in user.
    await expect(page.locator('.nav-user')).toContainText('E2E Admin')
    await expect(page.locator('.nav-user')).toContainText('admin ·')
  })

  test('sign out drops back to the logged-out board', async ({ page }) => {
    await login(page)
    await page.locator('.nav-user').getByText('sign out').click()
    await expect(page.locator('.nav-user')).toContainText('Not signed in')
  })
})
