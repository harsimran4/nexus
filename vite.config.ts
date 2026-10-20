import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'

// Version = semver + date + git SHA. The SHA matters: stale-build detection
// (src/diagnostics/update.ts) compares the served shell's app-version meta
// against the running bundle — a date alone made same-day deploys invisible.
function gitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim()
  } catch {
    return 'unknown'
  }
}

// SPA mode: the Worker never renders React (free-plan 10ms CPU budget);
// the prerendered shell loads, then the client router takes over. Server
// functions + server routes still run in the Worker.
export default defineConfig({
  plugins: process.env.VITEST
    ? [] // pure-helper tests don't need the framework pipeline
    : [cloudflare({ viteEnvironment: { name: 'ssr' } }), tanstackStart({ spa: { enabled: true } }), viteReact()],
  define: {
    __APP_VERSION__: JSON.stringify(`0.2.0+${new Date().toISOString().slice(0, 10)}.${gitSha()}`),
  },
  // Playwright's specs live in e2e/ — vitest must never pick them up.
  test: {
    exclude: ['**/node_modules/**', 'e2e/**'],
  },
})
