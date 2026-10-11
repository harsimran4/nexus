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
    if (!changed) return { outcome: 'already-linked', added: 0 }
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
    ].slice(-1500)

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
      if (infos.every((info) => verifyIds.includes(info.key))) return { outcome: 'linked', added }
    } catch { /* unreadable verify read — treat as unverified and retry */ }
    // else: loop and re-apply (our keys were eaten by a late peer put)
  }
  throw new Error('The workspace changed too quickly to link the upload')
}

/** Single-file convenience wrapper — the per-completion path. */
export async function linkUploadedFile(info: UploadLinkInfo): Promise<LinkResult> {
  return linkUploadedFiles([info])
}
