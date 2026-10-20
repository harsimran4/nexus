// P4 shadow-stage instrument — admin-only. The doc in the bucket stays the
// ONLY truth; this route verifies D1 against it and (re)imports.
//
//   GET /api/debug/d1?op=diff     → deep-compare live doc vs D1 regeneration
//   GET /api/debug/d1?op=regen    → the doc as D1 would regenerate it
//   POST /api/debug/d1            → full re-import (wipe + insert), then diff
//
// import touches ONLY D1 (derived copy) — the doc is never written here.

import { createFileRoute } from '@tanstack/react-router'
import type { SqlOp } from '../../../server/d1/tables'

// D1 binding type comes from the ambient declarations in src/env.d.ts.

const CHUNK = 40

async function applyChunked(db: D1Database, ops: SqlOp[]): Promise<number> {
  let statements = 0
  for (let i = 0; i < ops.length; i += CHUNK) {
    const chunk = ops.slice(i, i + CHUNK).map((op) => (op.args.length ? db.prepare(op.sql).bind(...op.args) : db.prepare(op.sql)))
    await db.batch(chunk)
    statements += chunk.length
  }
  return statements
}

export const Route = createFileRoute('/api/debug/d1')({
  server: {
    handlers: {
      GET: async ({ request }) => handle(request),
      POST: async ({ request }) => handle(request),
    },
  },
})

async function handle(request: Request): Promise<Response> {
  const { env } = await import('cloudflare:workers')
  const auth = await import('../../../server/auth')
  const session = await auth.verifyToken(env.SESSION_SECRET, auth.bearerFrom(request))
  console.log(`[d1-auth] secretLen=${env.SESSION_SECRET?.length ?? -1} session=${session ? session.uid : 'null'}`)
  if (!session || !(await auth.stillValid(session))) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (session.role !== 'admin') return Response.json({ error: 'admin only' }, { status: 403 })

  const db = env.DB
  if (!db) return Response.json({ error: 'no D1 binding' }, { status: 501 })

  const s3mod = await import('../../../server/s3')
  const tables = await import('../../../server/d1/tables')
  const regenMod = await import('../../../server/d1/regen')

  let actual: ReturnType<typeof JSON.parse>
  try {
    actual = JSON.parse(await s3mod.getText('master/nexus.json'))
  } catch (e) {
    return Response.json({ error: `doc unreadable: ${e instanceof Error ? e.message : e}` }, { status: 409 })
  }

  const url = new URL(request.url)
  const op = url.searchParams.get('op') ?? (request.method === 'POST' ? 'import' : 'diff')

  // The stage flip — admin-only, deliberate. To '2': re-import the current
  // doc (D1 ≡ doc at the flip instant), set meta.stage, write through. To
  // '1': set the row and write through the derived doc (the bucket doc and
  // the D1 regeneration should agree; the diff check confirms).
  if (op === 'set-stage') {
    const requested = url.searchParams.get('value')
    const value = requested === '2' || requested === '3' ? requested : '1'
    if (value === '2') {
      const ops: SqlOp[] = [...tables.wipeOps(), ...tables.docToOps(actual), ...(await tables.importActivityOps(actual))]
      await applyChunked(db, ops)
    }
    await applyChunked(db, [{ sql: `INSERT OR REPLACE INTO meta (key,value) VALUES ('stage',?)`, args: [value] }])
    const apply = await import('../../../server/d1/apply')
    const wt = await apply.writeThrough(db, s3mod, 'master/nexus.json')
    const rows = await regenMod.readAllRows(db)
    const report = await tables.diffDocs(actual, tables.rowsToDoc(rows))
    return Response.json({ ok: true, op: 'set-stage', stage: value, rev: wt.rev, diff: report }, { headers: { 'Cache-Control': 'no-store' } })
  }

  if (op === 'stage') {
    const apply = await import('../../../server/d1/apply')
    return Response.json({ ok: true, op: 'stage', stage: await apply.readStage(db) }, { headers: { 'Cache-Control': 'no-store' } })
  }

  if (op === 'import') {
    // Preserve the stage row — a re-import mid-stage-2 must not silently
    // demote the deployment back to shadow.
    const applyMod = await import('../../../server/d1/apply')
    const stage = await applyMod.readStage(db)
    const ops: SqlOp[] = [
      ...tables.wipeOps(),
      ...tables.docToOps(actual),
      ...(await tables.importActivityOps(actual)),
      { sql: `INSERT OR REPLACE INTO meta (key,value) VALUES ('stage',?)`, args: [String(stage)] },
    ]
    const statements = await applyChunked(db, ops)
    const rows = await regenMod.readAllRows(db)
    const report = await tables.diffDocs(actual, tables.rowsToDoc(rows))
    return Response.json({ ok: true, op: 'import', statements, diff: report }, { headers: { 'Cache-Control': 'no-store' } })
  }

  const rows = await regenMod.readAllRows(db)
  const regen = tables.rowsToDoc(rows)
  if (op === 'regen') return Response.json({ ok: true, op: 'regen', doc: regen }, { headers: { 'Cache-Control': 'no-store' } })

  const report = await tables.diffDocs(actual, regen)
  return Response.json({ ok: true, op: 'diff', diff: report }, { headers: { 'Cache-Control': 'no-store' } })
}
