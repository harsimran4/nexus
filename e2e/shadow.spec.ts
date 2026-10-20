import { expect, test } from '@playwright/test'
import { debugD1, expectDiffClean, login, waitSynced } from './helpers'

// P4 stage 1 (shadow): the bucket doc stays the only truth; every confirmed
// write ALSO mirrors into D1. This spec is the local gate for the cutover:
// import the seeded workspace, then drive one of each mutation class through
// the REAL UI (kernel writer, upload linking, restore) and require the diff
// route to report D1 ≡ doc after each step.

const FILE = Buffer.from('shadow payload — real bytes through the mirror'.repeat(32))

test.describe.serial('d1 shadow consistency', () => {
  test('import seeds D1 and the diff is clean', async ({ page }) => {
    await login(page)
    const res = await debugD1(page, 'import')
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(res.diff.clean, JSON.stringify(res.diff?.divergences ?? res)).toBe(true)
  })

  test('rename project (doc-only mutation) keeps the mirror clean', async ({ page }) => {
    await login(page)
    await page.goto('/project/prj_e2e_upload')
    const name = page.locator('input[aria-label="Project name"]')
    await expect(name).toBeVisible({ timeout: 20_000 })
    await name.fill('Shadow Renamed')
    await name.press('Enter')
    await waitSynced(page)
    await expectDiffClean(page)
  })

  test('notes edit (Settings tab) keeps the mirror clean', async ({ page }) => {
    await login(page)
    await page.goto('/project/prj_e2e_upload?tab=settings')
    const notes = page.locator('textarea')
    await expect(notes).toBeVisible({ timeout: 20_000 })
    await notes.fill('shadow mirror check note')
    await notes.blur()
    await waitSynced(page)
    await expectDiffClean(page)
  })

  test('adding a reference keeps the mirror clean', async ({ page }) => {
    await login(page)
    await page.goto('/project/prj_e2e_upload?tab=refs')
    await page.getByRole('button', { name: 'Add reference' }).click()
    const url = page.locator('.modal input[placeholder="https://…"]')
    await expect(url).toBeVisible()
    await url.fill('https://example.com/shadow')
    // Enter submits the form (the modal's own onKeyDown path)
    await url.press('Enter')
    await expect(page.locator('.card', { hasText: 'example.com/shadow' })).toBeVisible({ timeout: 20_000 })
    await waitSynced(page)
    await expectDiffClean(page)
  })

  test('script create + milestone copy keeps the mirror clean', async ({ page }) => {
    await login(page)
    await page.goto('/scripts')
    await page.getByRole('button', { name: 'New script' }).click()
    await page.getByPlaceholder('e.g. Q4 launch voiceover').fill('Shadow Mirror Script')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(page.locator('.script-title')).toHaveValue('Shadow Mirror Script')
    const body = page.getByPlaceholder('Write the script…')
    await body.fill('# shadow\n\nmirrored line\n')
    await page.locator('select.script-status').selectOption('review')
    await expect(page.locator('.script-copy')).toHaveCount(1, { timeout: 30_000 })
    await waitSynced(page)
    await expectDiffClean(page)
  })

  test('a real upload (server-side linking) keeps the mirror clean', async ({ page }) => {
    await login(page)
    await page.goto('/project/prj_e2e_upload')
    await expect(page.getByRole('button', { name: 'Upload' })).toBeVisible({ timeout: 20_000 })
    await page.getByRole('button', { name: 'Upload' }).click()
    await page.locator('.modal input[type="file"]').setInputFiles({
      name: 'shadow-mirror.bin',
      mimeType: 'application/octet-stream',
      buffer: FILE,
    })
    await expect(page.locator('.modal .upload-roster-row', { hasText: 'shadow-mirror.bin' })).toContainText('done', { timeout: 60_000 })
    await page.getByRole('button', { name: 'Close' }).first().click()
    await waitSynced(page)
    await expectDiffClean(page)
  })

  test('snapshot restore (wholesale doc replace) keeps the mirror clean', async ({ page }) => {
    await login(page)
    await page.goto('/admin')
    await page.getByRole('button', { name: 'Maintenance' }).click()
    const row = page.locator('.admin-row', { hasText: '2026-01-01' })
    await expect(row).toBeVisible({ timeout: 20_000 })
    await row.getByRole('button', { name: 'Restore' }).click()
    await expect(page.locator('.modal')).toContainText('Restore snapshot rev')
    await page.locator('.modal input.input').fill('restore')
    await page.getByRole('button', { name: 'Restore snapshot' }).click()
    await expect(page.getByText('Restored to rev 7')).toBeVisible({ timeout: 30_000 })
    // The kernel may re-assert post-snapshot local state on top — settle first.
    await waitSynced(page)
    await expectDiffClean(page)
    // The regenerated doc from D1 must itself parse as the same rev.
    const regen = await debugD1(page, 'regen')
    expect(regen.ok).toBe(true)
    expect(regen.doc.rev).toBeGreaterThan(0)
  })

  test('comment + approve (P7) keeps the mirror clean', async ({ page }) => {
    await login(page)
    await page.goto('/project/prj_e2e_upload?tab=discussion')
    const body = page.locator('textarea[aria-label="New comment"]')
    await expect(body).toBeVisible({ timeout: 20_000 })
    await body.fill('shadow comment — the cut looks good')
    await page.getByRole('button', { name: 'Comment' }).click()
    await expect(page.locator('.card', { hasText: 'shadow comment' })).toBeVisible({ timeout: 20_000 })
    await waitSynced(page)
    // Approval is the project's single-slot LWW field.
    await page.getByRole('button', { name: 'Approve', exact: true }).click()
    await expect(page.locator('.chip', { hasText: 'Approved' })).toBeVisible({ timeout: 20_000 })
    await waitSynced(page)
    await expectDiffClean(page)
  })
})
