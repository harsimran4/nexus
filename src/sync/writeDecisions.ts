// Pure decision points extracted from writer.ts so they can be property-
// tested — the write path is the highest-consequence logic in the app and its
// rebase rules had zero coverage. No I/O, no module state: every function is
// a pure function of its arguments, and writer.ts delegates to these so the
// tested version IS the shipped version.

import type { NexusDoc } from '../types/schema'

export interface SyncTokens {
  headRevisionId?: string
  md5Checksum?: string
  version?: string
}

/** saveLoop's fork: verified-unchanged → write on top of the verified etag;
 *  anything else — moved, or tokens unknown — rebases first. Ambiguous
 *  change tokens (both undefined) NEVER write blind. */
export function saveDecision(remote: SyncTokens, base: SyncTokens): 'write' | 'rebase' {
  const tokensKnown = remote.headRevisionId !== undefined || remote.version !== undefined
  const unchanged =
    (base.headRevisionId !== undefined && remote.headRevisionId === base.headRevisionId) ||
    (base.version !== undefined && remote.version === base.version)
  return tokensKnown && unchanged ? 'write' : 'rebase'
}

/** applyRemoteIfChanged's cheaper fork: skip the read only when the meta
 *  proves nothing moved. The md5 guard fires only when BOTH sides carry one —
 *  a meta lacking md5 must never mask a real change. */
export function applyDecision(remote: SyncTokens, base: SyncTokens): 'unchanged' | 'read' {
  const changed =
    remote.headRevisionId !== base.headRevisionId ||
    remote.version !== base.version ||
    (remote.md5Checksum !== undefined && remote.md5Checksum !== base.md5Checksum && base.md5Checksum !== undefined)
  if (!changed && base.headRevisionId !== undefined) return 'unchanged'
  return 'read'
}

export interface PendingEntity {
  map: 'groups' | 'projects' | 'scripts' | 'beats' | 'scenes' | 'shots'
  entity: Record<string, unknown>
}

export interface ReassertStamp {
  at: string
  by: string
}

/** Re-assert pending edits onto a freshly-merged doc. Rules:
 *  - the entity lands with the FRESH stamp — it is being re-written now;
 *  - a soft-deleted entity re-asserts as deleted:{at,by};
 *  - a key that's absent AND tombstoned stays purged (re-assertion must not
 *    resurrect what the user explicitly removed);
 *  - an absent key with NO tombstone re-asserts (a create raced a merge). */
export function reassertEntities(doc: NexusDoc, pending: PendingEntity[], stamp: ReassertStamp): void {
  for (const { map, entity } of pending) {
    const fresh = { ...entity, updatedAt: stamp.at, writerId: stamp.by } as Record<string, unknown>
    if (fresh.deleted) fresh.deleted = { at: stamp.at, by: stamp.by }
    const target = doc[map] as Record<string, unknown>
    if (target[String(fresh.id)] === undefined) {
      const type =
        map === 'groups' ? 'group'
        : map === 'projects' ? 'project'
        : map === 'scripts' ? 'script'
        : map === 'beats' ? 'beat'
        : map === 'scenes' ? 'scene'
        : 'shot'
      const tomb = doc.tombstones
        .filter((t) => t.type === type && t.id === fresh.id)
        .sort((a, b) => (a.at > b.at ? -1 : 1))[0]
      if (tomb) continue
    }
    target[String(fresh.id)] = fresh
  }
}
