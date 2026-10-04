// Guest upload-link resolution — shared by the public info route, the upload
// init's guest branch, and the completion-time re-check, so the validity
// rules can't drift between them. The raw token is verified by sha256 against
// the stored hash (never stored raw); one generic external message covers
// unknown/expired/revoked so a holder can't probe link state.

import type { NexusDoc, Project, UploadLink } from '../types/schema'

export type LinkVerdict =
  | { ok: true; link: UploadLink; project: Project }
  | { ok: false; status: number; log: string; message: string }

const GENERIC = 'This upload link is not valid or has expired'

export function linkIsActive(link: UploadLink, project: Project | undefined, nowMs: number): boolean {
  if (link.revokedAt) return false
  if (Number.isFinite(Date.parse(link.expiresAt)) && Date.parse(link.expiresAt) <= nowMs) return false
  if (!project || project.deleted) return false
  return true
}

export async function resolveUploadLink(doc: NexusDoc, raw: string, nowMs: number): Promise<LinkVerdict> {
  const auth = await import('./auth')
  let link: UploadLink | undefined
  for (const l of doc.uploadLinks ?? []) {
    if (await auth.verifyStaticToken(raw, l.tokenHash)) {
      link = l
      break
    }
  }
  if (!link) return { ok: false, status: 401, log: 'no hash match', message: GENERIC }
  const project = doc.projects[link.projectId]
  if (!linkIsActive(link, project, nowMs)) {
    const why = link.revokedAt ? 'revoked' : Date.parse(link.expiresAt) <= nowMs ? 'expired' : 'project gone'
    return { ok: false, status: 401, log: why, message: GENERIC }
  }
  return { ok: true, link, project }
}
