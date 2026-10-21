import { expect, test } from '@playwright/test'
import { login, waitSynced } from './helpers'

test.describe('script save + milestone journey', () => {
  test('create, edit the manuscript, save, and freeze a Review milestone copy', async ({ page }) => {
    await login(page)
    await page.goto('/scripts')

    await page.getByRole('button', { name: 'New script' }).click()
    await page.getByPlaceholder('e.g. Q4 launch voiceover').fill('E2E Journey Script')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    // Creating navigates straight into the script's workspace.
    await expect(page.locator('.script-title')).toHaveValue('E2E Journey Script')

    // The prose body lives on the Manuscript tab.
    await page.getByRole('tab', { name: 'Manuscript' }).click()
    const body = page.getByPlaceholder('Write the script…')
    await body.fill('# E2E journey\n\nA line worth freezing.\n')
    await page.getByRole('button', { name: 'Save body' }).click()
    await expect(page.locator('.toast', { hasText: /saved|Saved/i }).or(page.getByText('Synced'))).toBeVisible({
      timeout: 20_000,
    })

    // Status → review: the header flushes unsaved manuscript edits first,
    // then freezes the milestone copy.
    await page.locator('select.script-status').selectOption('review')
    await expect(page.locator('.script-copy')).toHaveCount(1, { timeout: 30_000 })
    await expect(page.locator('.script-copy')).toContainText('review', { ignoreCase: true })
    await waitSynced(page)
  })

  test('the creative system: brief fields, seeded acts, beat and scene', async ({ page }) => {
    await login(page)
    await page.goto('/scripts')

    await page.getByRole('button', { name: 'New script' }).click()
    await page.getByPlaceholder('e.g. Q4 launch voiceover').fill('E2E Structure Script')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(page.locator('.script-title')).toHaveValue('E2E Structure Script')

    // Brief: a field commits on blur.
    await page.getByPlaceholder(/What are you trying to express/).fill('A film about finishing things.')
    await page.getByPlaceholder(/What are you trying to express/).blur()

    // Story: the Opening/Middle/Ending trio seeds on first visit.
    await page.getByRole('tab', { name: 'Story' }).click()
    await expect(page.locator('.story-act')).toHaveCount(3, { timeout: 15_000 })
    await expect(page.locator('.story-act-head h3').first()).toContainText('Opening')

    // Add a beat to the first act, name it, and hang a scene off it.
    await page.getByRole('button', { name: 'Add beat' }).first().click()
    const beatTitle = page.getByLabel('Beat title')
    await beatTitle.fill('Cold open')
    await expect(page.getByLabel('Beat title')).toHaveValue('Cold open')

    await page.getByRole('button', { name: 'Add scene' }).click()
    const sceneTitle = page.getByLabel('Scene title')
    await sceneTitle.fill('Rooftops at dawn')
    await expect(page.getByLabel('Scene title')).toHaveValue('Rooftops at dawn')

    // Brief-level inspiration strip renders (empty state).
    await page.getByRole('tab', { name: 'Brief' }).click()
    await expect(page.getByText(/Nothing attached yet/i)).toBeVisible()

    // The Graph tab renders the canvas with the structure built above.
    await page.getByRole('tab', { name: 'Graph' }).click()
    const canvas = page.getByTestId('story-graph')
    await expect(canvas).toBeVisible({ timeout: 20_000 })
    await expect(canvas.locator('.sgraph-node')).toHaveCount(6, { timeout: 20_000 }) // concept + 2 acts + beat + scene… act lanes included
    await expect(canvas.locator('.sgraph-node', { hasText: 'Cold open' })).toBeVisible()

    // Clicking a node opens the side panel.
    await canvas.locator('.sgraph-node', { hasText: 'Cold open' }).click()
    await expect(canvas.locator('.sgraph-panel')).toBeVisible()
    await expect(canvas.locator('.sgraph-panel')).toContainText('Cold open')

    await waitSynced(page)

    // The library slip reads back the structure counts.
    await page.goto('/scripts')
    await expect(page.locator('.script-slip', { hasText: 'E2E Structure Script' })).toContainText(/1 beat/)
  })
})
