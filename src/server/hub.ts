// P5 — live push. One SQLite-backed Durable Object ("WorkspaceHub") holds a
// hibernating WebSocket per open tab; every confirmed workspace write
// broadcasts {rev} and all other tabs re-check within milliseconds. Workers
// free plan: DO requests/messages are metered per event, and hibernation
// means an idle open socket costs nothing — which is exactly why this is a
// DO and not SSE (SSE would hold isolate wall-clock around the clock).
//
// Access model, deliberately simple and honestly documented:
//  - The UPGRADE is unauthenticated. The doc read route (/files) is already
//    public (boot reads it anonymously), and a {rev} ping discloses strictly
//    less than the doc does — so the hub cannot leak anything the app
//    doesn't already publish. Disabled/expired sessions lose nothing they
//    could still read anyway.
//  - BROADCAST is server-only: the caller must present the session secret
//    as a shared key. The request never leaves the machine (Worker → DO in
//    the same runtime), so the secret never crosses a network.
//
// Failure posture mirrors the D1 mirror: notifyWorkspaceChange NEVER throws
// into the write path — a push is an optimization, the 30s poller is the
// correctness backstop. 'cloudflare:workers' is imported lazily (inside the
// try / inside fetch) because this module loads in plain Node too (vitest
// exercises the write paths that call notifyWorkspaceChange) — a top-level
// import would fail module resolution there, and the linker's retry loop
// would then treat a SUCCESSFUL link as unverified and re-run it.

export const HUB_NAME = 'workspace'

export class WorkspaceHub {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- env is
  // part of the workerd constructor contract even when unused.
  constructor(private state: DurableObjectState, _env: unknown) {}

  async fetch(request: Request): Promise<Response> {
    const { env } = await import('cloudflare:workers')
    const url = new URL(request.url)
    if (url.pathname.endsWith('/broadcast')) {
      if (request.headers.get('x-hub-key') !== env.SESSION_SECRET) {
        return Response.json({ error: 'unauthorized' }, { status: 401 })
      }
      let rev = 0
      try {
        rev = Number((await request.json())?.rev ?? 0) || 0
      } catch {
        /* a malformed body still warrants a generic ping */
      }
      this.broadcast(rev)
      return Response.json({ ok: true, sockets: this.state.getWebSockets().length })
    }
    if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') {
      return Response.json({ error: 'websocket upgrade expected' }, { status: 426 })
    }
    const pair = new WebSocketPair()
    this.state.acceptWebSocket(pair[1])
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  /** Relay {rev} to every connected tab. Hibernated sockets are woken by
   *  send() — no keep-alive traffic is ever needed. */
  private broadcast(rev: number): void {
    const msg = JSON.stringify({ rev })
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(msg)
      } catch {
        // one dead socket must not starve the rest
      }
    }
  }

  webSocketMessage(): void {
    // push-only hub — client messages are ignored (no pong needed; the
    // runtime's hibernation API tracks liveness for us)
  }

  webSocketClose(): void {
    // nothing to release; closed sockets drop out of getWebSockets()
  }

  webSocketError(): void {
    // the runtime closes the socket after this — same as webSocketClose
  }
}

/** Fire-and-forget fan-out after a confirmed workspace write. Safe to call
 *  from every write site; never throws, never blocks the write's success. */
export async function notifyWorkspaceChange(rev: number): Promise<void> {
  try {
    const { env } = await import('cloudflare:workers')
    if (!env.HUB) return // no binding → poller-only behavior
    const stub = env.HUB.get(env.HUB.idFromName(HUB_NAME))
    const res = await stub.fetch(
      new Request('https://hub.internal/broadcast', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-key': env.SESSION_SECRET },
        body: JSON.stringify({ rev }),
      }),
    )
    if (!res.ok) console.error(`[hub] broadcast refused: ${res.status}`)
  } catch (e) {
    console.error(`[hub] broadcast failed: ${e instanceof Error ? e.message : e}`)
  }
}
