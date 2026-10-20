import { expect, test } from '@playwright/test'

// The theme journey — the regression class that shipped twice (hydration
// failure resetting html attributes, missing pre-paint script in production).
// Both are covered: OS-preference default + full-load persistence.

test.describe('theme journey', () => {
  test('first visit with a dark OS preference renders dark', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  })

  test('first visit with a light OS preference renders light', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/')
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark')
  })

  test('a manual toggle persists across full reloads (the shipped bug)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/')
    await page.locator('.desktop-tools .theme-toggle').click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

    // Full reload — the exact path that used to fall back to light.
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark', { timeout: 15_000 })
    // And back to light — the override still wins over the OS.
    await page.locator('.desktop-tools .theme-toggle').click()
    await page.reload()
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark')
  })

  test('no hydration errors on a plain load', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(String(e)))
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto('/')
    await expect(page.locator('.item-card').first()).toBeVisible({ timeout: 20_000 })
    expect(errors.filter((e) => /hydrat|Minified React error/i.test(e))).toEqual([])
  })
})
