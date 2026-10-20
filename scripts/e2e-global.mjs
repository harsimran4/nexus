// Playwright globalSetup — bring the stack up, then align D1 to the seeded
// doc (always) and — when E2E_STAGE=2 — flip the deployment to stage 2 so the
// WHOLE suite exercises the transactional gateway instead of the doc writer.
//
// The debug route needs an admin session: the stack runs on a FIXED session
// secret (--var beats .dev.vars — verified empirically), so the setup can
// forge a token (same HMAC format as src/server/auth.ts) instead of driving
// the login UI.
import { execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const APP_URL = 'http://127.0.0.1:4173/'
const E2E_SECRET = process.env.E2E_SESSION_SECRET ?? 'e2e-fixed-session-secret'

const b64url = (buf) => Buffer.from(buf).toString('base64url')

async function forgeAdminToken(secret) {
  // epoch must match the seeded admin's sessionEpoch (1) or stillValid rejects
  const payload = { uid: 'u_e2e_admin', name: 'E2E Admin', role: 'admin', epoch: 1, exp: Date.now() + 3600_000 }
  const body = b64url(JSON.stringify(payload))
  const sig = await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), new TextEncoder().encode(body))
  return body + '.' + b64url(new Uint8Array(sig))
}

export default async function globalSetup() {
  execSync(`${JSON.stringify(process.execPath)} scripts/e2e-stack.mjs up`, { stdio: 'inherit', env: { ...process.env, E2E_SESSION_SECRET: E2E_SECRET } })
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(APP_URL)
      if (res.ok) break
    } catch {
      /* retry */
    }
    await sleep(500)
  }

  // Align D1 with the freshly seeded doc, then flip (E2E_STAGE=2 or 3).
  const requested = process.env.E2E_STAGE
  const stage = requested === '2' || requested === '3' ? requested : '1'
  const token = await forgeAdminToken(E2E_SECRET)
  const res = await fetch(`${APP_URL}api/debug/d1?op=import`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token },
  })
  const imported = await res.json().catch(() => null)
  if (!imported?.ok) throw new Error(`globalSetup: D1 import failed: ${JSON.stringify(imported)}`)
  if (!imported.diff?.clean) throw new Error(`globalSetup: D1 diverges right after import: ${JSON.stringify(imported.diff?.divergences)}`)
  if (stage !== '1') {
    const flip = await fetch(`${APP_URL}api/debug/d1?op=set-stage&value=${stage}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
    })
    const flipped = await flip.json().catch(() => null)
    if (!flipped?.ok || flipped.stage !== stage) throw new Error(`globalSetup: stage-${stage} flip failed: ${JSON.stringify(flipped)}`)
    console.log(`[e2e] stage ${stage} engaged — suite runs on the mutation gateway${stage === '3' ? ' + D1 boot reads' : ''}`)
  }
  console.log(`[e2e] D1 aligned (stage ${stage})`)
}
