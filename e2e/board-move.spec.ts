import { expect, test } from '@playwright/test'
import { cardInColumn, dismissRecovery, login, waitSynced } from './helpers'

const CARD = 'E2E Move Target'
const STAGES = ['Pending', 'In process', 'Completed']

/** The card's current column label (its ancestor .kanban-col head). */
async function currentColumn(page: import('@playwright/test').Page): Promise<string> {
  const col = page.locator('.kanban-col', { has: page.locator('.item-card', { hasText: CARD }) }).first()
  return (await col.locator('.kanban-col-head h3').textContent()) ?? ''
}

test.describe('board move journey', () => {
  // Tests are state-independent: each finds the card WHEREVER the previous
  // test left it (the worker caches the doc for up to 60s, so reseeding
  // mid-run is invisible) and moves it to a DIFFERENT stage.

  test('⋮ menu moves a card between stages and the move persists', async ({ page }) => {
    await login(page)
    const card = page.locator('.item-card', { hasText: CARD }).first()
    await expect(card).toBeVisible()
    const from = await currentColumn(page)

    // The ⋮ button is hover-revealed (pointer-events off until hover).
    await card.hover()
    await page.getByRole('button', { name: `Move ${CARD} to another stage` }).click()
    const items = page.getByRole('menuitem', { name: /^Move to / })
    // The menu only lists stages the card ISN'T in — pick the first.
    const targetLabel = ((await items.first().textContent()) ?? '').replace('Move to ', '').trim()
    expect(targetLabel).not.toBe(from)
    await items.first().click()
    // A stray click from the closing menu can open the project page — return
    // to the board (the move itself is already applied).
    if (page.url().includes('/project/')) await page.goto('/')

    await expect(cardInColumn(page, targetLabel, CARD)).toBeVisible()
    await waitSynced(page)
    // Persisted: a full reload re-reads from storage.
    await page.reload()
    await dismissRecovery(page)
    await expect(cardInColumn(page, targetLabel, CARD)).toBeVisible({ timeout: 20_000 })
  })

  test('HTML5 drag between columns lands the card', async ({ page }) => {
    await login(page)
    const card = page.locator('.item-card', { hasText: CARD }).first()
    await expect(card).toBeVisible()
    const from = await currentColumn(page)
    const target = STAGES.find((s) => s !== from) as string
    const targetCol = page.locator('.kanban-col', { has: page.locator('.kanban-col-head', { hasText: target }) })

    const dataTransfer = await page.evaluateHandle(() => new DataTransfer())
    await card.dispatchEvent('dragstart', { dataTransfer })
    await targetCol.dispatchEvent('dragenter', { dataTransfer })
    await targetCol.dispatchEvent('dragover', { dataTransfer })
    await targetCol.dispatchEvent('drop', { dataTransfer })
    await card.dispatchEvent('dragend', { dataTransfer })

    await expect(cardInColumn(page, target, CARD)).toBeVisible()
    await waitSynced(page)
    await page.reload()
    await dismissRecovery(page)
    await expect(cardInColumn(page, target, CARD)).toBeVisible({ timeout: 20_000 })
  })
})
