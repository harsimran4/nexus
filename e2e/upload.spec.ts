import { expect, test } from '@playwright/test'
import { login } from './helpers'

const FILE_NAME = 'e2e-upload.bin'
const FILE_BUFFER = Buffer.from('e2e upload payload — real bytes through real presigned PUTs'.repeat(64))

test.describe('upload journey', () => {
  test('media upload through the dialog lands a card in the grid', async ({ page }) => {
    await login(page)
    await page.goto('/project/prj_e2e_upload')
    // The Media tab is the default — wait for its toolbar.
    await expect(page.getByRole('button', { name: 'Upload' })).toBeVisible({ timeout: 20_000 })

    await page.getByRole('button', { name: 'Upload' }).click()
    await expect(page.locator('.modal')).toContainText('Upload media')

    await page.locator('.modal input[type="file"]').setInputFiles({ name: FILE_NAME, mimeType: 'application/octet-stream', buffer: FILE_BUFFER })
    // The roster shows per-file progress, then done.
    await expect(page.locator('.modal .upload-roster-row', { hasText: FILE_NAME })).toContainText('done', { timeout: 60_000 })
    await page.getByRole('button', { name: 'Close' }).first().click()

    // The file card is in the grid.
    await expect(page.locator('.media-card', { hasText: FILE_NAME })).toBeVisible({ timeout: 20_000 })
  })

  test('paste of a file uploads too (clipboard path)', async ({ page }) => {
    await login(page)
    await page.goto('/project/prj_e2e_upload')
    await expect(page.getByRole('button', { name: 'Upload' })).toBeVisible({ timeout: 20_000 })

    // The page-level drop veil handles drop events; simulate the drop with a
    // synthesized DataTransfer carrying a File.
    await page.evaluate(async (name) => {
      const file = new File([new TextEncoder().encode('pasted payload')], name, { type: 'text/plain' })
      const dt = new DataTransfer()
      dt.items.add(file)
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    }, 'e2e-pasted.txt')
    await expect(page.locator('.upload-tile')).toContainText('Uploading', { timeout: 20_000 })
    await expect(page.locator('.upload-tile')).toContainText('finished', { timeout: 30_000 })
    await expect(page.locator('.media-card', { hasText: 'e2e-pasted.txt' })).toBeVisible({ timeout: 30_000 })
  })
})
