// P5 client — one reconnecting WebSocket per tab. A push carries only {rev};
// the receiver runs the poller's exact pass (cheap meta check decides whether
// anything actually moved), so a push is a HINT, never a state change.
//
// Lifecycle: connect at boot, reconnect with capped jittered backoff, retry
// immediately when the tab becomes visible; the 30s poller is the backstop if
// the socket stays dead — a hub outage degrades to yesterday's behavior, not
// to staleness. Debug: localStorage 'nexus.hubDebug' = '1' logs open/close/
// push events (the e2e live-push journey asserts on these).

import { pollNow } from './poller'

let ws: WebSocket | null = null
let attempts = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let pushTimer: ReturnType<typeof setTimeout> | null = null
let stopped = false
let nexusId = ''

function debugLog(...args: unknown[]): void {
  try {
    if (localStorage.getItem('nexus.hubDebug') === '1') console.log('[hub]', ...args)
  } catch {
    /* storage can be blocked — debug logging is best-effort */
  }
}

export function startHub(id: string): void {
  nexusId = id
  stopped = false
  connect()
  document.addEventListener('visibilitychange', onVisibility)
}

export function stopHub(): void {
  stopped = true
  if (reconnectTimer) clearTimeout(reconnectTimer)
  if (pushTimer) clearTimeout(pushTimer)
  document.removeEventListener('visibilitychange', onVisibility)
  ws?.close()
  ws = null
}

function onVisibility(): void {
  // Coming back to the tab shouldn't wait out the backoff window.
  if (document.visibilityState === 'visible' && (!ws || ws.readyState === WebSocket.CLOSED)) {
    if (reconnectTimer) clearTimeout(reconnectTimer)
    connect()
  }
}

function connect(): void {
  if (stopped) return
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
  const url = new URL('/api/hub', location.href)
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  try {
    ws = new WebSocket(url)
  } catch {
    ws = null
    scheduleReconnect()
    return
  }
  ws.onopen = () => {
    attempts = 0
    debugLog('open')
  }
  ws.onmessage = onPush
  ws.onclose = () => {
    debugLog('closed')
    ws = null
    scheduleReconnect()
  }
  ws.onerror = () => {
    /* onclose always follows */
  }
}

function scheduleReconnect(): void {
  if (stopped) return
  const delay = Math.min(30_000, 1000 * 2 ** attempts) + Math.floor(Math.random() * 500)
  attempts += 1
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(connect, delay)
}

function onPush(ev: MessageEvent): void {
  let rev = 0
  try {
    rev = Number(JSON.parse(String(ev.data))?.rev ?? 0) || 0
  } catch {
    /* a malformed ping still warrants a pass */
  }
  debugLog('push rev=' + rev)
  // Coalesce bursts — a handful of quick writes means a handful of pings,
  // but one pass settles all of them (and dedupes against the poller for us).
  if (pushTimer) return
  pushTimer = setTimeout(() => {
    pushTimer = null
    pollNow(nexusId)
  }, 150)
}
