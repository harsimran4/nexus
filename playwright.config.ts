import { defineConfig } from '@playwright/test'

// E2E against the REAL stack: vite build → wrangler dev (the actual Worker)
// → scripts/fake-s3.mjs (an S3-compatible stand-in for the bucket — the app's
// presign/multipart/parse code runs for real). Journeys assert UI outcomes
// only, so the P4 D1 cutover swaps the seed seam and touches no test.
//
// The stack is NOT a Playwright webServer: PW kills the shell wrapper on
// Windows, the node children survive, the URL keeps answering and the run
// hangs forever. Instead globalSetup starts the stack via
// scripts/e2e-stack.mjs (recording PIDs) and globalTeardown kills exactly
// those PIDs.
export default defineConfig({
  globalSetup: './scripts/e2e-global.mjs',
  globalTeardown: './scripts/e2e-teardown.mjs',
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e-report' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    locale: 'en-US',
    timezoneId: 'UTC',
  },
})
