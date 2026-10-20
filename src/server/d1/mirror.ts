// Worker-side D1 execution for the P4 shadow mirror.
//
// STAGE-1 CONTRACT: the bucket doc stays the only truth. The mirror NEVER
// throws into the write path — a failed mirror is logged (observability has
// it) and the next /api/debug/d1?op=diff run surfaces the drift. Re-import
// repairs; nothing here can corrupt the doc.

import type { SqlOp } from './tables'

// D1's binding type comes from the ambient declarations in src/env.d.ts.

/** Free-plan safety valve: D1 batches aren't size-capped publicly, so chunk
 *  hard at 40 statements — also keeps us under any per-request subrequest
 *  interpretation (each batch = one subrequest; 45 batches still fits the
 *  50 budget alongside the S3 calls). Bigger transitions than that are
 *  chunked AND logged; chunk borders are not atomic (acceptable at stage 1:
 *  the mirror converges, the diff check is the arbiter). */
const CHUNK = 40
const MAX_CHUNKS = 45

export async function applyOps(db: D1Database, ops: SqlOp[]): Promise<{ statements: number; batches: number }> {
  if (ops.length === 0) return { statements: 0, batches: 0 }
  let statements = 0
  let batches = 0
  for (let i = 0; i < ops.length; i += CHUNK) {
    if (batches === MAX_CHUNKS) throw new Error(`mirror transition too large: >${MAX_CHUNKS * CHUNK} statements — re-run the import`)
    const chunk = ops.slice(i, i + CHUNK).map((op) => op.args.length ? db.prepare(op.sql).bind(...op.args) : db.prepare(op.sql))
    await db.batch(chunk)
    statements += chunk.length
    batches += 1
  }
  return { statements, batches }
}

/** Mirror one confirmed doc transition (the doc PUT ALREADY SUCCEEDED).
 *  Never throws; returns what happened for logging. A rev-equal transition
 *  (idempotent re-put of an unchanged doc) is skipped outright. */
export async function mirrorDocChange(prev: unknown, next: unknown, why: string): Promise<{ statements: number; batches: number } | null> {
  try {
    const p = prev as { rev?: number } | null
    const n = next as { rev?: number } | null
    if (p && n && p.rev === n.rev) return { statements: 0, batches: 0 }
    const { env } = await import('cloudflare:workers')
    const db = env.DB
    if (!db) return null // no binding (pre-P4 deploy) — mirror silently off
    const tables = await import('./tables')
    let ops
    if (!prev) {
      ops = [...tables.docToOps(next as never), ...(await tables.importActivityOps(next as never))]
    } else {
      // ONE diff logic (wireDiff) + ONE compiler (apply.compileOps) — the
      // same pair the stage-2 gateway uses, so mirror and gateway cannot drift.
      const apply = await import('./apply')
      ops = await apply.compileOps(await tables.wireDiff(prev as never, next as never))
    }
    const res = await applyOps(db, ops)
    console.log(`[d1-mirror] ${why}: ${res.statements} statements in ${res.batches} batch(es)`)
    return res
  } catch (e) {
    // Loud, never fatal — the doc is already safely stored.
    console.error(`[d1-mirror] ${why}: mirror FAILED (diff check will show drift): ${e instanceof Error ? e.message : e}`)
    return null
  }
}
