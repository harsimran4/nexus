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

/** Record `key` in the owning project's fileIds + mediaSectionOf and write
 *  the workspace doc back. Idempotent: an already-linked key is a no-op, so
 *  the CAS retry converges instead of duplicating. Throws only on storage
 *  errors or unreadable doc — callers treat link failure as non-fatal (the
 *  client commit backstops; sweep tooling can repair). */
export async function linkUploadedFile(info: UploadLinkInfo): Promise<LinkOutcome> {
  const s3 = await import('./s3')
  const auth = await import('./auth')
  const { parseDoc } = await import('../types/schema')

  for (let attempt = 0; attempt < 3; attempt++) {
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
    // (longest prefix wins — prefixes are nested groups/<gid>/<pid>/).
    let project = info.projectId ? doc.projects[info.projectId] : undefined
    if (!project || project.deleted) {
      project = undefined
      let bestPrefix = ''
      for (const p of Object.values(doc.projects)) {
        const prefix = p.folderId
        if (p.deleted || !prefix || !info.key.startsWith(prefix)) continue
        if (!project || prefix.length > bestPrefix.length) {
          project = p
          bestPrefix = prefix
        }
      }
    }
    if (!project) return 'no-project'

    let changed = false
    if (!project.fileIds.includes(info.key)) {
      project.fileIds = [...project.fileIds, info.key]
      changed = true
    }
    if (info.sectionId && project.mediaSections.some((s) => s.id === info.sectionId)) {
      if (project.mediaSectionOf[info.key] !== info.sectionId) {
        project.mediaSectionOf[info.key] = info.sectionId
        changed = true
      }
    }
    if (!changed) return 'already-linked'

    const stamp = hlcNow()
    project.updatedAt = stamp
    project.writerId = 'upload'
    doc.rev += 1
    doc.updatedAt = stamp
    doc.writerId = 'upload'
    doc.activity = [
      ...doc.activity,
      {
        at: stamp,
        actor: info.actorUid ?? 'system:upload',
        verb: 'project.attach',
        ref: project.id,
        meta: { fileId: info.key, fileName: info.fileName ?? null, sectionId: info.sectionId ?? null, via: 'upload' },
      },
    ].slice(-1500)

    // CAS on EVERY attempt: if another writer landed between our read and
    // now, re-read and re-apply — the link is idempotent so the retry
    // converges. (This narrows but cannot close the window: OCI ignores
    // If-Match, and no mutex spans Cloudflare isolates — the client's mirror
    // commit remains the backstop for the residual sliver.)
    const after = await s3.head(DOC_KEY)
    if (after && after.etag !== before.etag) continue
    await s3.put(DOC_KEY, JSON.stringify(doc), { contentType: 'application/json' })
    auth.invalidateDocCache()
    return 'linked'
  }
  throw new Error('The workspace changed too quickly to link the upload')
}
