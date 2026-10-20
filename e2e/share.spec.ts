import { expect, test } from '@playwright/test'

// P8 — scoped client share links. The seeded scoped viewer (token below, scope
// = prj_e2e_upload) opens /share/<token>. The ENFORCEMENT proof is at the
// network level: every server-fn response this session receives — across
// navigation AND reloads — is captured, and none of them may contain any
// other project. The scoped session persists (nexus.scopedSession), so a
// reload of /project/<id> re-enters the SCOPED boot (sync/scoped.ts) instead
// of the public full-workspace boot — test 2 is exactly that regression: it
// used to paint the whole workspace (found by hand in review, 2026-10-20).

const SCOPED_TOKEN = 'e2e-scoped-token-0123456789abcdef'
const OTHER_PROJECT = 'E2E Move Target'

async function captureServerFns(page: import('@playwright/test').Page, bodies: string[]): Promise<void> {
  await page.route('**/_serverFn/**', async (route) => {
    const res = await route.fetch()
    if (route.request().method() === 'POST') bodies.push(await res.text())
    await route.fulfill({ response: res })
  })
}

test.describe('scoped share link', () => {
  test('the server serves ONLY the scoped project to this session', async ({ page }) => {
    const bodies: string[] = []
    await captureServerFns(page, bodies)

    await page.goto(`/share/${SCOPED_TOKEN}`)
    // The scoped project rendered, read-only.
    await expect(page.locator('input[aria-label="Project name"]')).toHaveValue(/E2E Upload Target/, { timeout: 20_000 })

    // The scoped bootstrap answer was captured…
    const scoped = bodies.find((b) => b.includes('E2E Upload Target'))
    expect(scoped, 'the scoped bootstrap response was seen').toBeTruthy()
    // …and NOTHING the server sent this session contains another project.
    for (const b of bodies) expect(b, 'a server-fn response leaked another project').not.toContain(OTHER_PROJECT)
  })

  test('a reload of the project URL stays scoped (no public full-doc boot)', async ({ page }) => {
    const bodies: string[] = []
    await captureServerFns(page, bodies)

    await page.goto(`/share/${SCOPED_TOKEN}`)
    await expect(page.locator('input[aria-label="Project name"]')).toHaveValue(/E2E Upload Target/, { timeout: 20_000 })

    // THE leak that used to exist: on /project/<id> a reload ran the normal
    // boot → public doc read → the whole workspace in this tab. The persisted
    // scoped session must divert that boot through the scoped fn instead.
    await page.reload()
    await expect(page.locator('input[aria-label="Project name"]')).toHaveValue(/E2E Upload Target/, { timeout: 20_000 })
    // The scoped chrome: Groups/Scripts/Archive are gone from the sidebar.
    await expect(page.locator('.sidebar .nav-item', { hasText: 'Groups' })).toHaveCount(0)

    // And the other project is unreachable BY URL — the subset doc doesn't
    // contain it, so the project page renders its not-found state.
    await page.goto('/project/prj_e2e_move')
    await expect(page.getByText("This project doesn't exist or was deleted")).toBeVisible({ timeout: 20_000 })

    for (const b of bodies) expect(b, 'a server-fn response leaked another project').not.toContain(OTHER_PROJECT)
  })

  test('an unknown token is refused, not empty', async ({ page }) => {
    await page.goto('/share/xxxxxxxxxxxxxxxxxxxxxxxx')
    await expect(page.getByText('This link is not valid')).toBeVisible({ timeout: 20_000 })
  })
})
