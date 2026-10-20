// Custom Worker entry: Start's handler (the SPA shell + server fns/routes)
// PLUS the P5 hub PLUS the P10 cron export. Three jobs here:
//  1. Export the WorkspaceHub Durable Object class — the runtime discovers
//     DOs among the deployed worker's exports, so the class must ride the
//     same entry module as the fetch handler (see wrangler.jsonc `main`).
//  2. Intercept /api/hub BEFORE Start sees it. A WebSocket upgrade wants the
//     raw request in and the raw 101 out — routing it through the entry's
//     own fetch (rather than a framework route handler) guarantees neither
//     gets buffered or wrapped. The upgrade is deliberately unauthenticated
//     (access model documented in hub.ts); without a HUB binding the path
//     falls through to the app and 404s, and clients just keep the poller.
//  3. The scheduled handler — the P10 nightly export (backup.ts).
import start from '@tanstack/react-start/server-entry'
import { HUB_NAME, WorkspaceHub } from './hub'

export { WorkspaceHub }

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<Response> {
    if (new URL(request.url).pathname === '/api/hub' && env.HUB) {
      return env.HUB.get(env.HUB.idFromName(HUB_NAME)).fetch(request)
    }
    // Start's entry types fetch as the standard 1-2-arg fetch; workerd hands
    // us the 3-arg worker signature — the entry forwards all of them.
    return (start.fetch as (req: Request, e: unknown, c: unknown) => Promise<Response>)(request, env, ctx)
  },

  async scheduled(
    _controller: { cron: string; scheduledTime: number },
    env: Env,
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<void> {
    const { exportNightly } = await import('./backup')
    ctx.waitUntil(exportNightly(env))
  },
}
