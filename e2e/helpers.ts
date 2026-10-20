import { execSync } from 'node:child_process'
import { expect, type Page } from '@playwright/test'

export const ADMIN_PASSWORD = 'e2e admin passphrase'
export const GUEST_TOKEN = 'e2e-guest-token-0123456789abcdef'

/** Re-seed the bucket so board tests start from a deterministic state (the
 *  bucket persists across tests within a run — moves would otherwise leak). */
export function reseed(): void {
  execSync(`${JSON.stringify(process.execPath)} scripts/seed-dev.mjs http://127.0.0.1:9399 nexus`, {
    stdio: 'ignore',
  })
}

/** Sign in through the real /login form (browser stretches the password). */
export async function login(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('nexus.gatewayDebug', '1')
    } catch {
      /* private mode */
    }
  })
  page.on('console', (msg) => {
    if (msg.text().includes('[gateway]')) console.log(`  [browser] ${msg.text()}`)
  })
  await page.goto('/login')
  await page.getByPlaceholder('nexus token or password').fill(ADMIN_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  // The board is the landing surface after login — wait for a seeded card.
  await expect(page.locator('.item-card', { hasText: 'E2E Move Target' })).toBeVisible({ timeout: 20_000 })
  await dismissRecovery(page)
}

/** A prior test closing its tab mid-debounce leaves an IndexedDB draft — the
 *  app (correctly) offers recovery on the next load. Discard it so tests get
 *  a clean page; the draft's changes belong to a throwaway run anyway. */
export async function dismissRecovery(page: Page): Promise<void> {
  const modal = page.locator('.modal', { hasText: 'Unsaved changes from last session' })
  try {
    await modal.waitFor({ state: 'visible', timeout: 4000 })
    await modal.getByRole('button', { name: 'Discard' }).click()
    await expect(modal).toBeHidden()
  } catch {
    /* no draft — nothing to dismiss */
  }
}

/** Wait until every local change confirmed to storage (no draft left behind
 *  for the next test's page load). */
export async function waitSynced(page: Page): Promise<void> {
  await expect(page.locator('.pill').first()).toContainText('Synced', { timeout: 20_000 })
}

/** The card locator inside a named kanban column. */
export function cardInColumn(page: Page, column: string, card: string) {
  return page
    .locator('.kanban-col', { has: page.locator('.kanban-col-head', { hasText: column }) })
    .locator('.item-card', { hasText: card })
}

/** P4 shadow gate — call the debug route from inside the page (its sessionStorage
 *  token authenticates the admin). Returns the parsed JSON response. */
export async function debugD1(page: Page, op: 'diff' | 'regen' | 'import' = 'diff') {
  return page.evaluate(async (op) => {
    const token = sessionStorage.getItem('nexus.workerToken')
    const res = await fetch(`/api/debug/d1?op=${op}`, {
      method: op === 'import' ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + token },
    })
    return res.json()
  }, op)
}

/** Assert D1 mirrors the doc exactly — the shadow-stage invariant. EVENTUAL:
 *  the kernel debounces saves (400ms in the fixture), so a UI action that
 *  just committed may still be in-flight — poll until clean or timeout. */
export async function expectDiffClean(page: Page): Promise<void> {
  let last: { res: unknown; json: { diff?: { clean?: boolean; divergences?: unknown[] } } | null } | null = null
  for (let attempt = 0; attempt < 16; attempt++) {
    const res = await debugD1(page, 'diff')
    last = { res, json: res }
    if (res?.diff?.clean) return
    await page.waitForTimeout(500)
  }
  throw new Error(`D1 diverged from the doc after polling:\n${JSON.stringify(last?.json?.diff?.divergences ?? last?.json ?? last?.res, null, 2)}`)
}
