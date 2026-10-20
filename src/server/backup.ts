// P10 — the nightly human-readable export. A cron trigger (wrangler.jsonc
// `triggers.crons`) wakes the Worker once a day; this regenerates the doc
// from D1 (the same one-batch read the write-through uses) and lands it in
// the bucket under backups/ — dated files, pruned to the newest KEEP. The
// doc-era restore UX (Admin → Maintenance → snapshots) keeps working off the
// doc's own snapshot list; these exports are the disaster-recovery artifact
// that survives even if D1 itself is lost.
//
// Failure posture: NEVER throws into the scheduler — a failed export logs
// loudly and tries again tomorrow (plus the meta 'lastBackup' row makes the
// gap visible to the debug route). D1 Time Travel (PITR, included on free)
// is the PRIMARY recovery mechanism; see docs/backups.md for the drill.

import type { SqlArg } from './d1/tables'
import { canonicalJson } from './d1/tables'

export const BACKUP_PREFIX = 'backups/'
const BACKUP_KEEP = 14

export async function exportNightly(env: Env): Promise<void> {
  try {
    if (!env.DB) return
    const regen = await import('./d1/regen')
    const tables = await import('./d1/tables')
    const doc = tables.rowsToDoc(await regen.readAllRows(env.DB))
    const raw = JSON.stringify(doc)
    const s3 = await import('./s3')

    // One dated file per day. A same-day re-run (manual or retry) overwrites
    // — idempotent by key.
    const day = new Date().toISOString().slice(0, 10)
    const key = `${BACKUP_PREFIX}export-${day}.json`
    await s3.put(key, raw, { contentType: 'application/json' })

    // Prune to the newest KEEP exports (keys sort by date by construction).
    const page = await s3.list({ prefix: BACKUP_PREFIX, maxKeys: 1000 })
    const keys = page.contents.map((c) => c.key).filter((k) => k.endsWith('.json')).sort()
    for (const old of keys.slice(0, Math.max(0, keys.length - BACKUP_KEEP))) {
      await s3.del(old)
    }

    // Observability: the debug route and a wrangler query can see backup
    // freshness without listing the bucket.
    const stamp: Record<string, SqlArg> = { at: new Date().toISOString(), rev: doc.rev, key }
    await env.DB.prepare(`INSERT OR REPLACE INTO meta (key,value) VALUES ('lastBackup', ?)`).bind(canonicalJson(stamp)).run()
    console.log(`[backup] exported ${key} (rev ${doc.rev}, ${raw.length} bytes)`)
  } catch (e) {
    console.error(`[backup] nightly export failed: ${e instanceof Error ? e.message : e}`)
  }
}
