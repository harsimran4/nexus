// Stage-2 mutation core: validate a batch of wire ops from the client
// gateway, apply them in ONE D1 transaction under the kernel's LWW/tombstone
// rules, then write through — regenerate the doc from D1 and put it, so
// pre-flip tabs (and rollback) keep a truthful nexus.json.
//
// WHY THIS KILLS THE CAS RACE (the 97-files incident's root): the doc is no
// longer authoritative — it's DERIVED from D1. Two gateways submitting
// concurrently are serialized by D1's transaction; each write-through
// regenerates from post-merge truth, so neither can erase the other's change.
// The residual bucket-put race only ever clobbers the DERIVED copy with a
// slightly older derived copy, self-heals on the next write-through, and the
// diff check polices it.
//
// GUARDS (the kernel's correctness work, compiled into SQL):
//   - LWW entities (groups/projects/scripts/users/viewers/links/refs): the
//     upsert lands only if incoming updated_at (HLC) is newer than the row's.
//   - Entity deletes carry the deleting stamp and refuse to erase a NEWER row.
//   - Tombstones insert (type,id)-keyed, so the offline outbox's
//     "NOT EXISTS deletions" resurrection rule keeps working server-side.
//   - Activity appends are hash-deduped → replay-safe.
//   - rev/docStamps are server-authoritative — the client never sends them.

import type { SqlArg, SqlOp } from './tables'
import {
  GATEWAY_MAX_OPS,
  GATEWAY_META_KEYS,
  TABLE_SPECS,
  activityHash,
  canonicalJson,
} from './tables'

import { type WireOp } from './tables'
export type { WireOp } from './tables'
// (WireOp is defined in tables.ts next to wireDiff — the client gateway
// imports the diff from there; apply.ts owns only the SQL compilation.)

export type ValidateResult = { ok: true } | { ok: false; error: string }

const isSqlArg = (v: unknown): v is SqlArg => v === null || typeof v === 'string' || typeof v === 'number'

/** Validate the whole batch against the registry BEFORE touching D1 — one
 *  bad op rejects the call (never half-apply). Returns the batch typed.
 *  `allowStrong` is admin-only: a snapshot restore is a wholesale doc
 *  replacement and arrives as unguarded deletes; ordinary edits may not. */
export function validateOps(ops: unknown, opts: { allowStrong?: boolean } = {}): WireOp[] {
  if (!Array.isArray(ops)) throw new Error('ops must be an array')
  if (ops.length > GATEWAY_MAX_OPS) throw new Error(`too many ops in one batch (${ops.length} > ${GATEWAY_MAX_OPS})`)
  const batch: WireOp[] = []
  for (const op of ops as unknown[]) {
    if (!op || typeof op !== 'object') throw new Error('op must be an object')
    const o = op as Record<string, unknown>
    if (o.t === 'put') {
      const spec = TABLE_SPECS[o.table as keyof typeof TABLE_SPECS]
      if (!spec) throw new Error(`unknown table ${String(o.table)}`)
      const row = o.row as Record<string, unknown>
      if (!row || typeof row !== 'object') throw new Error('put.row must be an object')
      const keys = Object.keys(row)
      for (const k of keys) {
        if (!spec.cols.includes(k)) throw new Error(`column ${k} not allowed on ${String(o.table)}`)
        if (!isSqlArg(row[k])) throw new Error(`column ${k} has a non-primitive value`)
      }
      for (const pk of spec.pk) {
        if (!keys.includes(pk) || row[pk] === null) throw new Error(`put.${String(o.table)} missing pk column ${pk}`)
      }
      if (spec.lww && (typeof row.updated_at !== 'string' || row.updated_at === '')) {
        throw new Error(`put.${String(o.table)} requires an updated_at stamp (LWW guard)`)
      }
    } else if (o.t === 'del') {
      const spec = TABLE_SPECS[o.table as keyof typeof TABLE_SPECS]
      if (!spec) throw new Error(`unknown table ${String(o.table)}`)
      if (o.strong === true && !opts.allowStrong) {
        throw new Error('strong deletes are for the mirror and admin restores; ordinary edits send guarded deletes')
      }
      // Prefix keys are legal for CHILD tables (delete all copies of a script
      // by script_id); guarded LWW deletes must name the full key — the guard
      // stamps the row that exactly matches.
      if (!Array.isArray(o.pk) || o.pk.length < 1 || o.pk.length > spec.pk.length || !o.pk.every(isSqlArg)) {
        throw new Error(`del.${String(o.table)} pk must be 1..${spec.pk.length} primitive(s)`)
      }
      if (spec.lww && !o.strong && o.pk.length !== spec.pk.length) {
        throw new Error(`guarded del.${String(o.table)} requires the full ${spec.pk.length}-column key`)
      }
    } else if (o.t === 'meta-del' || o.t === 'activity-del') {
      // mirror bookkeeping + admin restores rewind these; treat them like
      // strong deletes (admin-only from the wire)
      if (!opts.allowStrong) throw new Error(`${o.t} is server-only (mirror/admin restores)`)
    } else if (o.t === 'meta') {
      if (!GATEWAY_META_KEYS.includes(o.key as never)) throw new Error(`meta key ${String(o.key)} is not client-writable`)
      if (typeof o.value !== 'string') throw new Error('meta.value must be a string')
    } else if (o.t === 'activity') {
      if (!Array.isArray(o.events) || o.events.length === 0) throw new Error('activity.events must be a non-empty array')
      for (const e of o.events) {
        const ev = e as Record<string, unknown>
        if (typeof ev.at !== 'string' || typeof ev.actor !== 'string' || typeof ev.verb !== 'string' || typeof ev.ref !== 'string') {
          throw new Error('activity event needs at/actor/verb/ref strings')
        }
      }
    } else if (o.t === 'tombstone') {
      const t = o.tombstone as Record<string, unknown>
      if (!t || typeof t.type !== 'string' || typeof t.id !== 'string' || typeof t.at !== 'string' || typeof t.by !== 'string') {
        throw new Error('tombstone needs type/id/at/by strings')
      }
    } else {
      throw new Error(`unknown op type ${String(o.t)}`)
    }
    batch.push(op as WireOp)
  }
  return batch
}

/** Compile validated wire ops into SQL statements. LWW guard semantics live
 *  here. Async only because activity identity is sha256(canonical JSON) — the
 *  SAME identity the shadow mirror uses, so stage 1 and stage 2 share one
 *  keyspace. Returns plain {sql,args} — the caller runs them as one batch
 *  (one D1 transaction) prefixed by bookkeepingOps. */
export async function compileOps(ops: WireOp[]): Promise<SqlOp[]> {
  const out: SqlOp[] = []
  for (const op of ops) {
    if (op.t === 'put') {
      const spec = TABLE_SPECS[op.table]
      const cols = spec.cols.filter((c) => op.row[c] !== undefined)
      const placeholders = cols.map(() => '?').join(',')
      if (spec.lww) {
        const sets = cols.filter((c) => !spec.pk.includes(c)).map((c) => `${c} = excluded.${c}`)
        // Upsert with the LWW guard. Stamps come in two dialects: HLCs
        // ('1792428039281.0000' — digits/dots only, the kernel's format) and
        // legacy ISO stamps ('2026-01-01T…'). Lexical compare alone would
        // rank EVERY HLC below every ISO stamp ('1' < '2') — so encode the
        // kernel's actual rule: an HLC always beats a non-HLC stamp; within
        // a dialect, lexical compare.
        out.push({
          sql: `INSERT INTO ${op.table} (${cols.join(',')}) VALUES (${placeholders}) ` +
            `ON CONFLICT(${spec.pk.join(',')}) DO UPDATE SET ${sets.join(',')} ` +
            `WHERE excluded.updated_at > ${op.table}.updated_at ` +
            `OR (excluded.updated_at NOT GLOB '*[^0-9.]*' AND ${op.table}.updated_at GLOB '*[^0-9.]*')`,
          args: cols.map((c) => op.row[c] ?? null),
        })
      } else {
        out.push({
          sql: `INSERT OR REPLACE INTO ${op.table} (${cols.join(',')}) VALUES (${placeholders})`,
          args: cols.map((c) => op.row[c] ?? null),
        })
      }
    } else if (op.t === 'del') {
      const spec = TABLE_SPECS[op.table]
      // WHERE covers a PREFIX of the PK: child-table deletes arrive by parent
      // id only (DELETE all copies of a script), while client-guarded dels
      // always carry the full key (validateOps enforces that).
      const where = spec.pk.slice(0, op.pk.length).map((c) => `${c} = ?`).join(' AND ')
      if (spec.lww && !op.strong) {
        // A delete refuses to erase a row written after the delete's stamp —
        // same two-dialect rule as the upsert guard (HLC beats legacy ISO).
        out.push({
          sql: `DELETE FROM ${op.table} WHERE ${where} AND (updated_at IS NULL OR updated_at <= ? ` +
            `OR (? NOT GLOB '*[^0-9.]*' AND updated_at GLOB '*[^0-9.]*'))`,
          args: [...op.pk, op.at ?? '', op.at ?? ''],
        })
      } else {
        out.push({ sql: `DELETE FROM ${op.table} WHERE ${where}`, args: [...op.pk] })
      }
    } else if (op.t === 'meta') {
      out.push({ sql: `INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)`, args: [op.key, op.value] })
    } else if (op.t === 'meta-del') {
      out.push({ sql: `DELETE FROM meta WHERE key = ?`, args: [op.key] })
    } else if (op.t === 'activity-del') {
      // restores can remove many events at once — one statement per batch
      out.push({ sql: `DELETE FROM activity WHERE h IN (${op.hashes.map(() => '?').join(',')})`, args: [...op.hashes] })
    } else if (op.t === 'activity') {
      // Hash-keyed: replays and merge echoes dedupe to a no-op.
      for (const e of op.events) {
        out.push({
          sql: `INSERT OR IGNORE INTO activity (at,actor,verb,ref,meta,h) VALUES (?,?,?,?,?,?)`,
          args: [e.at, e.actor, e.verb, e.ref, canonicalJson(e.meta ?? {}), await activityHash(e)],
        })
      }
    } else if (op.t === 'tombstone') {
      out.push({ sql: `INSERT OR REPLACE INTO deletions (type,id,at,by) VALUES (?,?,?,?)`, args: [op.tombstone.type, op.tombstone.id, op.tombstone.at, op.tombstone.by] })
    }
  }
  return out
}

/** Server bookkeeping prepended to every batch: bump rev and stamp the
 *  transition. Runs INSIDE the same transaction as the ops. */
export function bookkeepingOps(writerId: string, stamp: string): SqlOp[] {
  return [
    { sql: `UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'rev'`, args: [] },
    {
      sql: `INSERT OR REPLACE INTO meta (key,value) VALUES ('docStamps', ?)`,
      args: [canonicalJson({ updatedAt: stamp, writerId })],
    },
  ]
}

// ---------------------------------------------------------------------------
// Write-through — regenerate the doc from D1 and put it (stage-2 contract:
// pre-flip tabs and rollback keep a truthful nexus.json)
// ---------------------------------------------------------------------------

/** The stage flag — meta row 'stage', '1' by default. mutateFn refuses ops
 *  below 2; bootstrapFn falls back below 3; docPut refuses at 3. */
export async function readStage(db: D1Database): Promise<1 | 2 | 3> {
  const res = (await db.prepare(`SELECT value FROM meta WHERE key = 'stage'`).run()) as { results: { value?: string }[] }
  const v = res.results?.[0]?.value
  return v === '3' ? 3 : v === '2' ? 2 : 1
}

/** Regenerate the doc from current D1 and put it to the bucket. The CAS is
 *  verify-then-write with our own etag (OCI ignores If-Match) — but unlike
 *  the doc-era writers, a lost put here only clobbers the DERIVED copy with
 *  an older derived copy: self-healing on the next write-through, policed by
 *  the diff check. Retries ≤3, re-regenerating each time. */
export async function writeThrough(db: D1Database, s3mod: typeof import('../s3'), docKey: string): Promise<{ rev: number; etag: string }> {
  const { readAllRows } = await import('./regen')
  const { rowsToDoc } = await import('./tables')
  for (let attempt = 0; attempt < 3; attempt++) {
    const doc = rowsToDoc(await readAllRows(db))
    const raw = JSON.stringify(doc)
    await s3mod.put(docKey, raw, { contentType: 'application/json' })
    const current = await s3mod.getText(docKey)
    if (current === raw) return { rev: doc.rev, etag: (await s3mod.head(docKey))?.etag ?? '' }
    // a peer landed between put and verify — re-regenerate and retry
  }
  throw new Error('writeThrough: the derived doc kept changing under us')
}

