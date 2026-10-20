// Runtime environment for the Worker (server functions + server routes).
// Mirrors wrangler.jsonc [vars] + the wrangler secrets. Local dev reads the
// same names from .dev.vars (gitignored).
interface Env {
  OCI_S3_ENDPOINT: string
  OCI_S3_BUCKET: string
  OCI_S3_REGION: string
  PART_SIZE: string
  OCI_S3_ACCESS_KEY_ID: string
  OCI_S3_SECRET_ACCESS_KEY: string
  SESSION_SECRET: string
  SETUP_TOKEN?: string
  /** P4: D1 binding ("DB" in wrangler.jsonc). Optional in the type because
   *  a pre-binding deploy must still typecheck; server code treats absence
   *  as "mirror off". */
  DB?: D1Database
  /** P5: live-push hub ("HUB" in wrangler.jsonc). Optional for the same
   *  reason — without it the app simply keeps the poller-only behavior. */
  HUB?: DurableObjectNamespace
}

// Minimal D1 surface we use — kept local instead of pulling
// @cloudflare/workers-types (one small interface beats version drift).
interface D1Statement {
  bind(...args: unknown[]): D1Statement
  run<T = unknown>(): Promise<{ results: T[]; success: boolean; meta: unknown }>
}
interface D1Database {
  prepare(sql: string): D1Statement
  batch(stmts: D1Statement[]): Promise<unknown>
}

// P5 — minimal Durable Object surface (same policy as D1 above: a few small
// interfaces instead of a workers-types version pin). Hibernation APIs only —
// the hub never touches DO storage.
interface DurableObjectId {
  toString(): string
}
interface DurableObjectStub {
  fetch(request: Request): Promise<Response>
}
interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): DurableObjectStub
}
interface DurableObjectState {
  acceptWebSocket(ws: WebSocket): void
  getWebSockets(): WebSocket[]
}
// workerd upgrades a WebSocket by returning a 101 whose body carries the
// client pair — lib.dom's ResponseInit doesn't know the field; merge it.
interface ResponseInit {
  webSocket?: WebSocket
}
// The workerd runtime global that constructs that pair (workers-types only).
declare const WebSocketPair: { new (): { 0: WebSocket; 1: WebSocket } }

declare module 'cloudflare:workers' {
  export const env: Env
}
