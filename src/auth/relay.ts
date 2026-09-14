// Write-relay client. When a relay URL is baked in, editors can write without
// any Google session: they sign in with their Nexus secret as usual, the app
// exchanges it at the relay for a 7-day HMAC write ticket, and every save
// posts the merged doc to the relay — which verifies the ticket and writes to
// Drive as the studio account. The ticket lives in localStorage (possession
// IS the identity, same pattern as viewer tokens).

import { config } from '../config'
import type { NexusDoc } from '../types/schema'

const TICKET_KEY = 'nexus.relayTicket'

export function relayConfigured(): boolean {
  return config.relayUrl !== ''
}

export function getRelayTicket(): string | null {
  try {
    return localStorage.getItem(TICKET_KEY)
  } catch {
    return null
  }
}

export function clearRelayTicket(): void {
  try {
    localStorage.removeItem(TICKET_KEY)
  } catch {
    /* ignore */
  }
}

/** Exchange the Nexus secret for a write ticket. Silent best-effort at login —
 *  a failed verify just means the next write surfaces a clear reconnect. */
export async function relayVerify(secret: string): Promise<void> {
  if (!relayConfigured()) return
  const res = await fetch(config.relayUrl + '/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: secret.trim() }),
  })
  if (!res.ok) return // 401 wrong secret, 5xx relay down — no ticket either way
  const body = (await res.json()) as { ticket?: string; role?: string }
  if (!body.ticket || body.role === 'viewer') return // viewers never get write tickets
  try {
    localStorage.setItem(TICKET_KEY, body.ticket)
  } catch {
    /* ignore */
  }
}

export type RelayWriteResult =
  | { ok: true; version: string; md5Checksum?: string }
  | { ok: false; kind: 'auth' } // ticket missing/expired/revoked
  | { ok: false; kind: 'conflict'; remote: string } // server doc moved — merge + retry
  | { ok: false; kind: 'error'; message: string }

/**
 * Push the whole merged doc through the relay. The same verify-token-then-write
 * contract as the direct path: the server compares its Drive `version` against
 * `baseVersion` and refuses to overwrite a moved file (409 + current doc).
 */
export async function relayWriteDoc(doc: NexusDoc, baseVersion: string | undefined): Promise<RelayWriteResult> {
  const ticket = getRelayTicket()
  if (!ticket) return { ok: false, kind: 'auth' }
  try {
    const res = await fetch(config.relayUrl + '/write', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + ticket, 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseVersion: baseVersion ?? null, doc: JSON.stringify(doc) }),
    })
    if (res.status === 401) {
      clearRelayTicket()
      return { ok: false, kind: 'auth' }
    }
    if (res.status === 409) {
      const body = (await res.json()) as { doc?: string; version?: string }
      return { ok: false, kind: 'conflict', remote: body.doc ?? '' }
    }
    if (!res.ok) {
      let message = `Relay error ${res.status}`
      try {
        const body = (await res.json()) as { error?: string }
        if (body.error) message = body.error
      } catch {
        /* non-JSON error body */
      }
      return { ok: false, kind: 'error', message }
    }
    const body = (await res.json()) as { version?: string; md5Checksum?: string }
    return { ok: true, version: body.version ?? '', md5Checksum: body.md5Checksum }
  } catch (e) {
    return { ok: false, kind: 'error', message: e instanceof Error ? e.message : 'Relay unreachable' }
  }
}
