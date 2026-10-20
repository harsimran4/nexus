// Playwright globalTeardown — kill exactly the PIDs `up` recorded.
import { execSync } from 'node:child_process'

export default async function globalTeardown() {
  execSync(`${JSON.stringify(process.execPath)} scripts/e2e-stack.mjs down`, { stdio: 'inherit' })
}
