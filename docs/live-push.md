# P5 — live push (Durable Object + WebSocket hibernation)

Status: **BUILT + VERIFIED (2026-10-20)** — the full e2e suite passes with the live-push journey included (28 specs at the time; wrangler dev logs show `GET /api/hub 101 Switching Protocols`, the upgrade working through the entry intercept). tsc clean, 102/102 unit tests, build green, worker 1.05 MB gzip / 2.50 MB limit, emitted worker exports `WorkspaceHub` + the intercepting default fetch + the `scheduled` handler.

## What exists

- **`src/server/hub.ts`** — `WorkspaceHub` (one SQLite-backed Durable Object, id name `'workspace'`): a hibernating WebSocket per open tab. `broadcast` relays `{rev}` to every socket (`getWebSockets()` wakes hibernated sockets on send — no keep-alive traffic ever). Client messages are ignored; closes/errors need no cleanup.
- **`src/server/worker-entry.ts`** — the new wrangler `main`. Two jobs: export the DO class (the runtime discovers DOs among the worker's exports) and intercept `GET /api/hub` BEFORE Start sees it — a WebSocket upgrade wants the raw request in and the raw 101 out, so it never routes through framework machinery. Everything else forwards to Start's handler untouched.
- **`notifyWorkspaceChange(rev)`** — fire-and-forget fan-out, called post-commit from EVERY confirmed write site: `initFn`, `docPutFn` (stage 1/2 whole-doc writes), `mutateFn` (stage 2+, after write-through so reacting tabs see the fresh derived doc), and both `linking.ts` branches. NEVER throws into the write path (mirror posture); a push is an optimization, the poller is the correctness backstop. Worker→DO auth is the session secret as a shared key (`x-hub-key`) — the request never leaves the machine.
- **`src/sync/hubClient.ts`** — one reconnecting WebSocket per tab: capped jittered backoff (1s→30s), immediate retry on visibility, 150ms push coalescing. A push carries only `{rev}`; the receiver runs the poller's EXACT pass (cheap meta check decides whether anything moved) — a push is a hint, never a state change. Debug: `localStorage.nexus.hubDebug = '1'` logs open/close/push.
- **Poller demoted to fallback** — default interval 10s → 30s (schema default + runtime fallback), still the home of auto-archive sweep + session re-verification. A dead hub degrades to yesterday's behavior, not to staleness.

## Access model (deliberate, documented)

The upgrade is UNAUTHENTICATED: the doc read route (`/files`) is already public (boot reads it anonymously), and a `{rev}` ping discloses strictly less than the doc does — the hub cannot leak anything the app doesn't already publish. Broadcast is server-only. No cookies, no ticket flow, nothing new to protect.

## Free-plan fit

SQLite-backed DOs are on the Workers free plan; hibernation means an idle open socket meters nothing — only actual messages/requests count. A small team's volume is orders of magnitude under the daily request quota. (This is the whole reason P5 is a DO and not SSE: SSE would hold isolate wall-clock around the clock, ~the entire free daily duration budget for one 24/7 tab.)

## wrangler.jsonc

```jsonc
"durable_objects": { "bindings": [{ "name": "HUB", "class_name": "WorkspaceHub" }] },
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["WorkspaceHub"] }]
```

Local dev + e2e run the DO in wrangler's built-in miniflare — no account needed. On first DEPLOY the migration applies automatically. `HUB` is optional in `Env` — a pre-binding deploy keeps poller-only behavior.

## Stage independence

Live push works at ALL P4 stages: stage-1/2 writes broadcast from `docPutFn`/`linking`, stage-2/3 writes from `mutateFn`. The spec (`e2e/live.spec.ts`) runs in the default stage-1 suite and equally under `E2E_STAGE=2/3`.

## Verification

- **Automated:** `npx playwright test` (full suite) — `e2e/live.spec.ts` opens TWO sessions: the receiver logs in first and waits for `[hub] open`, then the writer renames `prj_e2e_move`. The seeded doc polls every 60s, so the assertions (push console line within 5s + the renamed card appearing in the receiver's UI without reload) can only be satisfied by the push path.
- **Manual (`npm run dev`):** two tabs side by side; set `localStorage.nexus.hubDebug = '1'` in both; edit in one — the other logs `[hub] push rev=…` and re-renders within a second, no poll interval involved.
- The e2e run itself was declined during the build session and handed to the owner.

## Retire / later

- If Start ever gives the entry trouble, the intercept could move to a TanStack route — but the entry is the one place guaranteed raw passthrough; leave it.
- The `{rev}` payload is deliberately minimal. Per-entity deltas (only the changed rows) would cut bootstraps on push — a P6 concern (offline reads + instant boot build on the same snapshot shape).
