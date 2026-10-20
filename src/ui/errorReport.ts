// Client crash net: window error/rejection handlers plus a small
// authenticated beacon (POST /api/diagnostics/error). Deduped and
// rate-limited client-side; every send failure is swallowed — the last thing
// a crashing app needs is a reporter that throws.

const WORKER_TOKEN_KEY = 'nexus.workerToken'

const DEDUPE_MS = 60_000
const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 10

let installed = false
const seen = new Map<string, number>()
let sentInWindow = 0
let windowStart = 0

function token(): string | null {
  try {
    return sessionStorage.getItem(WORKER_TOKEN_KEY)
  } catch {
    return null
  }
}

function report(kind: string, message: string, extra: Record<string, unknown> = {}): void {
  const now = Date.now()
  if (now - windowStart > WINDOW_MS) {
    windowStart = now
    sentInWindow = 0
  }
  if (sentInWindow >= MAX_PER_WINDOW) return
  const key = kind + ':' + message
  if (now - (seen.get(key) ?? 0) < DEDUPE_MS) return
  seen.set(key, now)
  if (seen.size > 200) seen.clear()
  sentInWindow += 1
  const t = token()
  if (!t) return // not signed in — nowhere honest to send it
  const payload = {
    kind,
    message: message.slice(0, 500),
    url: location.href.slice(0, 300),
    at: new Date().toISOString(),
    ...extra,
  }
  void fetch('/api/diagnostics/error', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => {})
}

/** Install once, early in the client boot. */
export function installGlobalErrorHandlers(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('error', (e) => {
    report(
      'error',
      e.message || String(e.error ?? 'unknown error'),
      e.filename ? { source: `${e.filename}:${e.lineno}:${e.colno}` } : {},
    )
  })
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason
    report(
      'unhandledrejection',
      r instanceof Error ? r.message : String(r),
      r instanceof Error && r.stack ? { stack: r.stack.slice(0, 4000) } : {},
    )
  })
}

/** Render-crash reports carry the component stack — called from the boundary. */
export function reportRenderCrash(error: Error, componentStack: string): void {
  report('render', error.message, {
    stack: error.stack?.slice(0, 4000),
    componentStack: componentStack.slice(0, 2000),
  })
}
