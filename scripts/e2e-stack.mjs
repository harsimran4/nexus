// The e2e stack, started/killed BY PID FILE so teardown never depends on
// shell process trees (Windows kills the cmd wrapper, not the node children
// — which hung Playwright forever because the URL kept answering).
//
//   node scripts/e2e-stack.mjs up    → build(if needed) + fake-s3 + seed + wrangler dev
//   node scripts/e2e-stack.mjs down  → kill exactly the PIDs `up` recorded
//
// PIDs land in .e2e/e2e-pids.json (outside test-results — Playwright wipes that dir per run). `up` waits until the app answers.

import { spawn, execSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'

const APP_PORT = 4173
const S3_PORT = 9399
const APP_URL = `http://127.0.0.1:${APP_PORT}/`
const PID_FILE = '.e2e/e2e-pids.json'
const WRANGLER_ENTRY = 'node_modules/wrangler/bin/wrangler.js'

const mode = process.argv[2] ?? 'up'

function psJson(script) {
  const out = execSync(`powershell -NoProfile -Command "${script}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const trimmed = out.trim()
  if (!trimmed) return []
  const parsed = JSON.parse(trimmed)
  return Array.isArray(parsed) ? parsed : [parsed]
}

/** Kill leftovers from earlier runs BEFORE starting — an orphaned fake-s3
 *  keeps serving STALE seed data on port 9399 (the new one dies on
 *  EADDRINUSE and nothing notices), and two wranglers on one sqlite dir
 *  corrupt it (SQLITE_IOERR_TRUNCATE). Identity-based, never pid-trust:
 *  1) node children that are demonstrably the e2e stack (fake-s3.mjs /
 *     seed-dev.mjs / a wrangler dev pinned to the e2e port),
 *  2) workerd whose PARENT IS GONE (a true orphan — the user's own live
 *     `npm run dev` has a live parent and is never touched),
 *  3) last resort, whatever still holds the two e2e ports. */
function sweepOrphans() {
  try {
    for (const row of psJson(`Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress`)) {
      const cl = String(row?.CommandLine ?? '')
      const ours = /fake-s3\.mjs/.test(cl) || /seed-dev\.mjs/.test(cl) || (/wrangler(\.exe|\.js)?/.test(cl) && /--port/.test(cl) && new RegExp(`--port ${APP_PORT}\\b`).test(cl))
      if (ours && row.ProcessId !== process.pid) {
        try {
          process.kill(row.ProcessId, 'SIGKILL')
          console.log(`[e2e] swept orphan node ${row.ProcessId}`)
        } catch {
          /* gone */
        }
      }
    }
  } catch {
    /* no powershell — nothing to sweep */
  }
  try {
    const alive = new Set(psJson('Get-CimInstance Win32_Process | Select-Object ProcessId, Name | ConvertTo-Json -Compress').map((r) => r.ProcessId))
    for (const row of psJson(`Get-CimInstance Win32_Process -Filter \\"Name='workerd.exe'\\" | Select-Object ProcessId, ParentProcessId, CommandLine | ConvertTo-Json -Compress`)) {
      const cl = String(row?.CommandLine ?? '')
      if (!alive.has(row.ParentProcessId) && /ContentManagement.Nexus/.test(cl)) {
        try {
          process.kill(row.ProcessId, 'SIGKILL')
          console.log(`[e2e] reaped orphaned workerd ${row.ProcessId}`)
        } catch {
          /* gone */
        }
      }
    }
  } catch {
    /* no workerd — nothing to reap */
  }
  for (const port of [APP_PORT, S3_PORT]) {
    try {
      const rows = psJson(`Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -First 1 OwningProcess | ConvertTo-Json -Compress`)
      const owner = rows[0]?.OwningProcess
      if (owner && owner !== process.pid) {
        process.kill(owner, 'SIGKILL')
        console.log(`[e2e] freed port ${port} (killed ${owner})`)
      }
    } catch {
      /* port already free */
    }
  }
}

function killRecorded() {
  if (!fs.existsSync(PID_FILE)) return
  const { pids } = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'))
  for (const pid of pids) {
    try {
      // PID files can go stale across runs and Windows REUSES pids — never
      // kill a process that isn't demonstrably ours (e2e-stack children run
      // this repo's wrangler/fake-s3 scripts). Verify via its command line.
      const out = execSync(
        `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"ProcessId=${pid}\\").CommandLine"`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      )
      const cl = String(out)
      if (!/e2e-stack|fake-s3|wrangler\.js|seed-dev/.test(cl)) {
        console.log(`[e2e] skipped pid ${pid} — not an e2e child anymore (${cl.trim().slice(0, 80)})`)
        continue
      }
      process.kill(pid, 'SIGKILL')
      console.log(`[e2e] killed ${pid}`)
    } catch {
      /* already gone or unqueryable */
    }
  }
  fs.rmSync(PID_FILE, { force: true })
  // wrangler dev's workerd children survive the node wrapper on Windows and
  // keep the D1 sqlite + port locked. Kill ONLY workerd instances whose
  // command line names THIS project's wrangler state.
  try {
    const out = execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'workerd.exe\'\\" | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress"',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
    const rows = out.trim() ? JSON.parse(out.trim()) : []
    for (const row of Array.isArray(rows) ? rows : [rows]) {
      if (typeof row?.CommandLine === 'string' && /ContentManagement.Nexus/.test(row.CommandLine) && /wrangler|v3/.test(row.CommandLine)) {
        try {
          process.kill(row.ProcessId, 'SIGKILL')
          console.log(`[e2e] reaped workerd ${row.ProcessId}`)
        } catch {
          /* gone */
        }
      }
    }
  } catch {
    /* no workerd or no powershell — nothing to reap */
  }
}

async function waitReady(url, what, tries = 180) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { method: 'HEAD' })
      if (res.status < 500) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`${what} never became ready at ${url}`)
}

async function up() {
  fs.mkdirSync('.e2e', { recursive: true })

  if (process.env.SKIP_BUILD !== '1') {
    console.log('[e2e] building…')
    const { execSync } = await import('node:child_process')
    execSync('npx vite build', { stdio: 'inherit' })
  }

  const pids = []
  // Children log to a FILE and are unref'd: execSync (globalSetup) waits for
  // stdio to CLOSE, not just process exit — inherited stdio from a long-lived
  // server never closes and the whole run hangs. The log is the debugging
  // surface; teardown kills the recorded PIDs.
  const logFd = fs.openSync('.e2e/e2e-server.log', 'a')
  const spawnNode = (script, args) => {
    const p = spawn(process.execPath, [script, ...args], { stdio: ['ignore', logFd, logFd], detached: true })
    p.unref()
    pids.push(p.pid)
    return p
  }

  console.log('[e2e] starting fake-s3…')
  spawnNode('scripts/fake-s3.mjs', [String(S3_PORT), '.e2e-bucket'])
  await waitReady(`http://127.0.0.1:${S3_PORT}/nexus/`, 'fake-s3')

  // P4 shadow stage: local D1 must have the schema before wrangler dev starts.
  // Idempotent (IF NOT EXISTS); -y skips the apply prompt (non-TTY safe).
  console.log('[e2e] applying d1 schema…')
  const { execSync: sx1 } = await import('node:child_process')
  sx1(`node ${JSON.stringify(WRANGLER_ENTRY)} d1 execute nexus --local --file migrations/0001-schema.sql -y`, { stdio: 'ignore' })

  console.log('[e2e] seeding…')
  fs.writeFileSync(PID_FILE, JSON.stringify({ pids })) // seed must be killable too
  const { execSync: sx } = await import('node:child_process')
  sx(`${JSON.stringify(process.execPath)} scripts/seed-dev.mjs http://127.0.0.1:${S3_PORT} nexus`, { stdio: 'inherit' })

  console.log('[e2e] starting wrangler dev…')
  // SESSION_SECRET must be stable across the run (HMAC tokens). --var works
  // for every binding in dev, so no .dev.vars is needed (or touched). The S3
  // credentials MUST be passed too: locally .dev.vars happens to supply real
  // ones, but CI has no .dev.vars (it holds real secrets) and the worker's
  // S3 client then had no accessKeyId (CI run 39466536896). fake-s3 ignores
  // signatures — anything works.
  const secret = process.env.E2E_SESSION_SECRET ?? crypto.randomBytes(32).toString('base64')
  const wrangler = spawn(process.execPath, [
    WRANGLER_ENTRY,
    'dev',
    '--port',
    String(APP_PORT),
    '--var',
    `OCI_S3_ENDPOINT:http://127.0.0.1:${S3_PORT}`,
    '--var',
    'OCI_S3_BUCKET:nexus',
    '--var',
    'OCI_S3_REGION:e2e',
    '--var',
    'OCI_S3_ACCESS_KEY_ID:e2e-fake-key',
    '--var',
    'OCI_S3_SECRET_ACCESS_KEY:e2e-fake-secret',
    '--var',
    `SESSION_SECRET:${secret}`,
    '--var',
    'SETUP_TOKEN:e2e-setup-token',
  ], { stdio: ['ignore', logFd, logFd], detached: true })
  wrangler.unref()
  pids.push(wrangler.pid)
  fs.writeFileSync(PID_FILE, JSON.stringify({ pids }))

  await waitReady(APP_URL, 'app')
  console.log('[e2e] ready on', APP_URL, '— pids:', pids.join(','))
}

if (mode === 'up') {
  sweepOrphans() // leftovers from hung/killed runs must not poison this one
  killRecorded() // a stale pid file from a hung run must not leak
  await up()
} else {
  killRecorded()
  sweepOrphans()
}
