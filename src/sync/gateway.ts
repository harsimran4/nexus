// Stage-2 client gateway: instead of shipping the WHOLE doc to docPutFn
// (verify-token-then-write + rebase), diff the local doc against the last
// synced state and send entity ops to the transactional mutateFn. The server
// applies them under LWW/tombstone guards in ONE D1 transaction and writes
// the doc through, so the CAS race that lost 97 files is structurally gone.
//
// MODE: the client doesn't know the deployment's stage up front. The first
// save probes mutateFn — `{applied:false, stage:1}` flips this session to the
// legacy whole-doc writer ('doc' mode); an applied batch locks 'd1' mode.
//
// syncedDoc is the last local state known to be reflected in D1. It advances
// only on a CONFIRMED gateway flush (to the exact snapshot that was sent —
// commits landing mid-flight stay pending). Peer changes arriving via the
// poller while syncedDoc lags simply get re-sent as redundant ops — harmless:
// LWW guards no-op same-stamp writes and activity dedupes by hash.

import { mutateFn } from '../server/fns'
import { wireDiff } from '../server/d1/tables'
import type { NexusDoc } from '../types/schema'

export type GatewayMode = 'unknown' | 'd1' | 'doc'
export type GatewayVerdict = 'applied' | 'noop' | 'fallback' | 'failed'

let mode: GatewayMode = 'unknown'
let bootDoc: NexusDoc | null = null
let syncedDoc: NexusDoc | null = null

export function gatewayMode(): GatewayMode {
  return mode
}

/** The doc as loaded at boot is the first-sync baseline (D1 was mirrored to
 *  it by the shadow stage). Called by boot.ts after every fresh install. */
export function gatewayNoteDoc(doc: NexusDoc): void {
  if (!bootDoc && mode !== 'doc') {
    bootDoc = structuredClone(doc)
    syncedDoc = null // fresh baseline — next flush diffs from the boot state
  }
}

/** The confirmed state after a legacy (stage-1) write — the gateway baseline
 *  must follow it or the first stage-2 flush would resend everything. */
export function gatewayNoteSynced(doc: NexusDoc): void {
  if (mode !== 'doc') syncedDoc = structuredClone(doc)
}

export function gatewayDemote(): void {
  mode = 'doc'
  bootDoc = null
  syncedDoc = null
}

/** Try one gateway flush. Never throws — 'failed' means retryable (queued). */
export async function gatewayFlush(): Promise<GatewayVerdict> {
  if (mode === 'doc') return 'fallback'
  const store = (await import('./store')).storeGet()
  const current = store.doc
  if (!current) return 'fallback'
  const prev = syncedDoc ?? bootDoc
  if (!prev) return 'fallback' // no baseline yet (pre-boot commit?) — legacy path

  let ops
  try {
    ops = await wireDiff(prev as never, current as never, undefined, { gateway: true })
  } catch {
    return 'failed'
  }
  if (ops.length === 0) {
    syncedDoc = structuredClone(current)
    return 'noop'
  }

  const sent = structuredClone(current)
  if (typeof localStorage !== 'undefined' && localStorage.getItem('nexus.gatewayDebug')) {
    console.log(`[gateway] flush ${ops.length} op(s) rev ${String((prev as { rev?: number }).rev)}->${String((current as { rev?: number }).rev)}`)
  }
  let res
  try {
    res = await mutateFn({ data: { ops } })
  } catch (e) {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('nexus.gatewayDebug')) console.log(`[gateway] mutateFn threw: ${String(e)}`)
    return 'failed'
  }
  if (!res.ok) {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('nexus.gatewayDebug')) {
      console.log(`[gateway] rejected kind=${res.kind} msg=${res.message}`)
    }
    // Retryable = transient (server busy, derived-doc churn). Anything else
    // (validation, permission) won't fix itself — hand the edit to the legacy
    // writer, which surfaces failures honestly instead of looping.
    if (res.kind === 'conflict' || res.kind === 'rateLimit') return 'failed'
    gatewayDemote()
    return 'fallback'
  }
  if (!res.data.applied) {
    gatewayDemote() // deployment is stage 1 — legacy writer owns this session
    return 'fallback'
  }
  mode = 'd1'
  syncedDoc = sent
  // The write-through moved the bucket etag — adopt it so reads/poller see a
  // consistent base instead of Rebasing against ourselves.
  if (res.data.etag) store.setBase({ headRevisionId: res.data.etag })
  return 'applied'
}
