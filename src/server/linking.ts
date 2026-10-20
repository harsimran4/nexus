// Server-side upload linking — the durable record that "a file exists".
//
// The client's local commit of fileIds is UI-only feedback: the sync kernel's
// queued-write replay, IndexedDB draft discard, and stale-scratch re-assert
// can each roll that state back after the bytes are safely stored (this is
// how uploaded files kept vanishing from the Media tab). So the link is
// applied SERVER-SIDE, idempotently, at upload completion — verify-then-write
// with our own etag CAS (OCI ignores If-Match). The client commit stays as a
// belt-and-suspenders mirror; Set-dedupe makes it a no-op once the server doc
// holds the link.
//
// CONCURRENCY (the 97-files-lost incident, 2026-10): a guest uploading 100+
// files runs ~3 completions in parallel, each doing read-modify-write of the
// SAME doc. The verify-then-write CAS cannot be atomic (OCI ignores If-Match):
// a peer's put landing between our second head and our put is silently
// erased by ours. Two defenses make that survivable:
//   1. HERE — enough attempts with backoff to outlast a completion burst, an
//      immediate post-put re-read confirming OUR keys survived (a stale
//      overwrite that ate them loops and re-applies). This guards the
//      writer's own keys only — it narrows, not closes, the window.
//   2. UPSTREAM — the guest page runs a verify+repair pass over ALL its keys
//      once the batch drains (POST /api/upload/link-batch): one quiescent
//      read-modify-write that re-links anything a late clobber erased. App
//      users have the kernel mirror commit; sweep/adopt tooling recovers the
//      residual (guest closed the tab before repair — bytes are orphans).

import { hlcNow } from '../util/hlc'
import { ACTIVITY_LOCAL_BUFFER } from '../types/schema'
import { DOC_KEY } from './keys'
import { config } from '../config'

export interface UploadLinkInfo {
  key: string
  projectId?: string | null
  sectionId?: string | null
  actorUid?: string | null
  fileName?: string | null
}

export type LinkOutcome = 'linked' | 'already-linked' | 'no-project'

/** `added` = keys actually appended this call — the repair pass reports it so
 *  the owner sees exactly how many files needed a touch-up. */
export type LinkResult = { outcome: LinkOutcome; added: number }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
/** Attempts + backoff sized to outlast a completion burst: 3 parallel lanes
 *  churn the doc every few hundred ms; a writer that keeps losing the race
 *  waits out its peers instead of giving up after one round. Sleeps are wall
 *  time — free of the free plan's 10ms CPU budget. */
const MAX_ATTEMPTS = 6
const backoffMs = (attempt: number): number => 120 * 2 ** attempt + Math.floor(Math.random() * 150)

/** Record every `info.key` in the owning project's fileIds (+ mediaSectionOf)
 *  and write the workspace doc back — ONE read-modify-write for the whole
 *  set. Idempotent: already-linked keys are no-ops, so a CAS retry converges
 *  instead of duplicating. Throws only on storage errors or unreadable doc.
 *  Callers decide whether a throw is fatal: guest completions surface it
 *  (the client retries), app completions still backstop on the client commit,
 *  and /api/upload/link-batch re-runs the whole set as a repair. */
export async function linkUploadedFiles(infos: UploadLinkInfo[]): Promise<LinkResult> {
  if (infos.length === 0) return { outcome: 'already-linked', added: 0 }
  const s3 = await import('./s3')
  const auth = await import('./auth')
  const { parseDoc } = await import('../types/schema')

  // STAGE 2: the doc is derived from D1 — link as SQL (INSERT OR IGNORE is
  // atomic; the whole verify-then-write CAS dance below exists only because
  // the doc-era write couldn't be). Resolution still reads the doc (it is
  // kept true by write-through); the WRITE lands in D1, then write-through.
  try {
    const { env } = await import('cloudflare:workers')
    if (env.DB) {
      const apply = await import('./d1/apply')
      if ((await apply.readStage(env.DB)) === 2) return linkViaD1(env.DB, infos)
    }
  } catch {
    /* no binding or D1 hiccup → fall through to the doc-era path */
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(backoffMs(attempt))
    const before = await s3.head(DOC_KEY)
    if (!before) throw new Error('Workspace document missing')
    const raw = await s3.getText(DOC_KEY)
    const parsed = parseDoc(raw)
    if (!parsed.ok) throw new Error('Workspace document unreadable')
    // A newer client's schema would be STRIPPED by re-serializing our parsed
    // copy — same guard the client kernel applies before rebasing (writer.ts).
    if (parsed.doc.schema > config.maxKnownSchema) {
      throw new Error(`Workspace written by a newer Nexus (schema ${parsed.doc.schema}) — link skipped`)
    }
    const doc = parsed.doc
    // P4 shadow: pristine pre-mutation snapshot — the mutations below happen
    // IN PLACE on `doc`, and mirrorDocChange's rev-equal guard would see
    // prev.rev === next.rev and silently skip the transition otherwise.
    const docBefore = structuredClone(doc)

    // Exact id preferred; else the project whose folder prefix owns the key
    // (longest prefix wins — prefixes are nested groups/<gid>/<pid>/). The
    // set shares one destination (one link / one completion), so the first
    // info resolves the project for all of them.
    let project = infos[0].projectId ? doc.projects[infos[0].projectId as string] : undefined
    if (!project || project.deleted) {
      project = undefined
      let bestPrefix = ''
      for (const p of Object.values(doc.projects)) {
        const prefix = p.folderId
        if (p.deleted || !prefix || !infos[0].key.startsWith(prefix)) continue
        if (!project || prefix.length > bestPrefix.length) {
          project = p
          bestPrefix = prefix
        }
      }
    }
    if (!project) return { outcome: 'no-project', added: 0 }

    const have = new Set(project.fileIds)
    let changed = false
    let added = 0
    for (const info of infos) {
      if (!have.has(info.key)) {
        have.add(info.key)
        changed = true
        added += 1
      }
      if (info.sectionId && project.mediaSections.some((s) => s.id === info.sectionId)) {
        if (project.mediaSectionOf[info.key] !== info.sectionId) {
          project.mediaSectionOf[info.key] = info.sectionId
          changed = true
        }
      }
    }
    if (!changed) {
      console.log(`[upload-link] ${infos[0].key}: already-linked (attempt ${attempt})`)
      return { outcome: 'already-linked', added: 0 }
    }
    project.fileIds = [...have]

    const stamp = hlcNow()
    project.updatedAt = stamp
    project.writerId = 'upload'
    doc.rev += 1
    doc.updatedAt = stamp
    doc.writerId = 'upload'
    doc.activity = [
      ...doc.activity,
      ...infos.map((info) => ({
        at: stamp,
        actor: info.actorUid ?? 'system:upload',
        verb: 'project.attach',
        ref: project.id,
        meta: { fileId: info.key, fileName: info.fileName ?? null, sectionId: info.sectionId ?? null, via: 'upload' },
      })),
    ].slice(-ACTIVITY_LOCAL_BUFFER)

    // CAS on EVERY attempt: if another writer landed between our read and
    // now, re-read and re-apply — the links are idempotent so the retry
    // converges. (This narrows but cannot close the window: OCI ignores
    // If-Match, and no mutex spans Cloudflare isolates.)
    const after = await s3.head(DOC_KEY)
    if (after && after.etag !== before.etag) continue
    await s3.put(DOC_KEY, JSON.stringify(doc), { contentType: 'application/json' })
    auth.invalidateDocCache()

    // Post-put self-verification: a peer's put landing between our CAS check
    // and our put silently erased OUR keys — nothing rejected the stale
    // overwrite. Plain JSON.parse (no validation, no re-serialize — CPU
    // budget): writers only ever ADD keys, so if every key is present in the
    // current doc the write is durably good.
    try {
      const verifyDoc = JSON.parse(await s3.getText(DOC_KEY)) as { projects?: Record<string, { fileIds?: string[] }> }
      const verifyIds = verifyDoc.projects?.[project.id]?.fileIds ?? []
      if (infos.every((info) => verifyIds.includes(info.key))) {
        // P4 shadow: mirror the confirmed transition. verifyDoc is the doc AS
        // IT NOW STANDS (ours + any peer writes that landed meanwhile), so the
        // mirror converges D1 onto current truth, not just our slice. The
        // mirror never throws; a failure logs and the diff check surfaces it.
        const { mirrorDocChange } = await import('./d1/mirror')
        await mirrorDocChange(docBefore as never, verifyDoc as never, `link ${infos.length} file(s)`)
        await (await import('./hub')).notifyWorkspaceChange((verifyDoc as { rev?: number }).rev ?? 0) // P5 live push
        console.log(`[upload-link] ${infos[0].key}: linked (attempt ${attempt}, mirror done)`)
        return { outcome: 'linked', added }
      }
    } catch { /* unreadable verify read — treat as unverified and retry */ }
    // else: loop and re-apply (our keys were eaten by a late peer put)
  }
  console.error(`[upload-link] ${infos[0].key}: exhausted ${MAX_ATTEMPTS} attempts`)
  throw new Error('The workspace changed too quickly to link the upload')
}

/** Single-file convenience wrapper — the per-completion path. */
export async function linkUploadedFile(info: UploadLinkInfo): Promise<LinkResult> {
  return linkUploadedFiles([info])
}

// ---------------------------------------------------------------------------
// Stage-2 link path — the incident's machinery, gone: one D1 transaction.
// ---------------------------------------------------------------------------

/** Resolve the owning project the same way the doc path does (exact id, else
 *  longest folder-prefix), then link every key as guarded SQL. Resolution
 *  reads the bucket doc (kept true by write-through) so the semantics match
 *  the stage-1 path exactly. */
async function linkViaD1(db: D1Database, infos: UploadLinkInfo[]): Promise<LinkResult> {
  const auth = await import('./auth')
  const doc = await auth.loadNexusDoc()
  if (!doc) throw new Error('Workspace document missing')

  let project = infos[0].projectId ? doc.projects[infos[0].projectId] : undefined
  if (!project || project.deleted) {
    project = undefined
    let bestPrefix = ''
    for (const p of Object.values(doc.projects)) {
      const prefix = p.folderId
      if (p.deleted || !prefix || !infos[0].key.startsWith(prefix)) continue
      if (!project || prefix.length > bestPrefix.length) {
        project = p
        bestPrefix = prefix
      }
    }
  }
  if (!project) return { outcome: 'no-project', added: 0 }

  const { hlcNow } = await import('../util/hlc')
  const { canonicalJson, activityHash } = await import('./d1/tables')
  const stamp = hlcNow()
  const have = new Set(project.fileIds)
  const sectionIds = new Set(project.mediaSections.map((s) => s.id))
  const stmts: { sql: string; args: (string | number | null)[] }[] = []
  let added = 0
  for (const info of infos) {
    const section = info.sectionId && sectionIds.has(info.sectionId) ? info.sectionId : null
    if (!have.has(info.key)) {
      have.add(info.key)
      added += 1
      stmts.push({
        sql: `INSERT OR IGNORE INTO project_files (project_id,file_key,section_id,added_at,added_by) VALUES (?,?,?,?,?)`,
        args: [project.id, info.key, section, stamp, info.actorUid ?? 'upload'],
      })
    } else if (section) {
      stmts.push({ sql: `UPDATE project_files SET section_id = ? WHERE project_id = ? AND file_key = ?`, args: [section, project.id, info.key] })
    }
    const event = {
      at: stamp,
      actor: info.actorUid ?? 'system:upload',
      verb: 'project.attach',
      ref: project.id,
      meta: { fileId: info.key, fileName: info.fileName ?? null, sectionId: info.sectionId ?? null, via: 'upload' },
    }
    stmts.push({
      sql: `INSERT OR IGNORE INTO activity (at,actor,verb,ref,meta,h) VALUES (?,?,?,?,?,?)`,
      args: [event.at, event.actor, event.verb, event.ref, canonicalJson(event.meta), await activityHash(event)],
    })
  }
  if (added === 0 && stmts.length === 0) return { outcome: 'already-linked', added: 0 }

  const apply = await import('./d1/apply')
  const batched = [...apply.bookkeepingOps('upload', stamp), ...stmts].map((op) =>
    op.args.length ? db.prepare(op.sql).bind(...op.args) : db.prepare(op.sql),
  )
  await db.batch(batched)
  const s3 = await import('./s3')
  const wt = await apply.writeThrough(db, s3, DOC_KEY)
  await (await import('./hub')).notifyWorkspaceChange(wt.rev) // P5 live push
  auth.invalidateDocCache()
  console.log(`[upload-link] stage2: linked ${added}/${infos.length} key(s) into ${project.id}`)
  return { outcome: 'linked', added }
}
