// Per-entity last-writer-wins merge, keyed by (HLC(updatedAt), writerId).
// Framework-free and side-effect-free — this is the module whose correctness
// the whole app rests on, and the one the property tests hammer.
//
// Rules:
// - Entities (projects/items/scripts): per-key LWW. Unknown fields preserved
//   verbatim from whichever side won (and from the loser for keys the winner
//   simply doesn't know about — passthrough, never strip).
// - Deletions: entities carry deleted:{at,by}|null inline; tombstones[] also
//   record deletes so a stale peer can't resurrect a key it never saw.
//   A tombstone beats an entity only if its HLC is newer; a newer edit beats
//   an older tombstone and emits an "*.undelete" activity event.
// - users.app / users.viewers: array keyed by .id — per-entry LWW.
// - settings: whole-object LWW (single admin edits it; conflicts are rare).
// - activity: union by (at|actor|verb|ref) key, sorted, ring-buffer capped.
// - snapshots: union by fileId. tombstones: union by (type,id) keeping newest.

import { compareHlc, lwwWinner } from '../util/hlc'
import type { ActivityEvent, NexusDoc, Tombstone } from '../types/schema'

// Activity ring: the fastest-growing section of the doc (every action logs an
// event, and each edit re-uploads the whole file). 300 recent events is ample
// history for the feed while keeping nexus.json lean.
const RING_CAP = 300

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Unknown-field passthrough: winner wins known keys, loser's unknown keys survive. */
function passthrough<T>(winner: T, loser: unknown): T {
  if (!isRec(winner) || !isRec(loser)) return winner
  const out: Record<string, unknown> = { ...loser, ...winner }
  return out as T
}

function stampOf(entity: unknown): { updatedAt: string; writerId: string } {
  const r = isRec(entity) ? entity : {}
  return { updatedAt: String(r.updatedAt ?? ''), writerId: String(r.writerId ?? '') }
}

function mergeEntityMaps<T>(
  local: Record<string, T>,
  remote: Record<string, T>,
  localTombstones: Tombstone[],
  remoteTombstones: Tombstone[],
  undeletes: ActivityEvent[],
): Record<string, T> {
  const out: Record<string, T> = {}
  const keys = new Set([...Object.keys(local), ...Object.keys(remote)])
  const newestTombstoneFor = (tombstones: Tombstone[], id: string): Tombstone | undefined =>
    tombstones
      .filter((t) => t.id === id)
      .sort((a, b) => compareHlc(b.at, a.at))
      [0]

  for (const id of keys) {
    const a = local[id]
    const b = remote[id]

    if (a !== undefined && b !== undefined) {
      const sA = stampOf(a)
      const sB = stampOf(b)
      const winnerIsLocal = lwwWinner(sA.updatedAt, sA.writerId, sB.updatedAt, sB.writerId) === 'a'
      out[id] = winnerIsLocal ? passthrough(a, b) : passthrough(b, a)
      continue
    }

    // Present on one side only — check the OTHER side's tombstones so a key
    // deleted elsewhere doesn't resurrect here.
    const present = a !== undefined ? a : b
    const otherTombstones = a !== undefined ? remoteTombstones : localTombstones
    const tomb = newestTombstoneFor(otherTombstones, id)
    if (tomb) {
      const sP = stampOf(present)
      const entityIsNewer = compareHlc(sP.updatedAt, tomb.at) > 0
      if (entityIsNewer && (isRec(present) ? present.deleted : null) == null) {
        // Intentional edit after the delete — resurrect + make it visible.
        undeletes.push({
          at: sP.updatedAt,
          actor: sP.writerId,
          verb: '*.undelete',
          ref: id,
          meta: { from: 'tombstone' },
        })
        out[id] = present
      }
      // else: stay deleted — do not insert the key (or, if the entity carries
      // its own deleted marker and is newer, that's handled by the LWW path
      // when both sides have it; here we drop the missing-side resurrection).
      continue
    }

    const ownTombstones = a !== undefined ? localTombstones : remoteTombstones
    const ownTomb = newestTombstoneFor(ownTombstones, id)
    if (ownTomb && isRec(present) && present.deleted != null) {
      const entityIsNewer = compareHlc(stampOf(present).updatedAt, ownTomb.at) > 0
      if (!entityIsNewer) continue // tombstone is the latest word on this id
    }
    out[id] = present
  }
  return out
}

function mergeUsers<T extends { id: string }>(local: T[], remote: T[], tombstones: Tombstone[]): T[] {
  const out = new Map<string, T>()
  for (const u of remote) out.set(u.id, u)
  for (const u of local) {
    const other = out.get(u.id)
    if (!other) {
      out.set(u.id, u)
      continue
    }
    const sA = stampOf(u)
    const sB = stampOf(other)
    out.set(u.id, lwwWinner(sA.updatedAt, sA.writerId, sB.updatedAt, sB.writerId) === 'a' ? passthrough(u, other) : passthrough(other, u))
  }
  // A user tombstone newer than the entry's stamp deletes the user on both
  // sides — without this a stale peer would resurrect deleted users on the
  // next merge (users are absent-on-one-side in plain arrays otherwise).
  for (const [id, u] of [...out]) {
    const tomb = tombstones
      .filter((t) => t.type === 'user' && t.id === id)
      .sort((a, b) => compareHlc(b.at, a.at))[0]
    if (tomb && compareHlc(stampOf(u).updatedAt, tomb.at) <= 0) out.delete(id)
  }
  return [...out.values()]
}

function activityKey(e: ActivityEvent): string {
  return `${e.at}|${e.actor}|${e.verb}|${e.ref}`
}

export interface MergeInput {
  local: NexusDoc
  remote: NexusDoc
  /** ids of entities edited locally since the last confirmed save — re-asserted with fresh stamps by the writer afterwards */
}

export function mergeRemote(input: MergeInput): { merged: NexusDoc; undeletes: ActivityEvent[] } {
  const { local, remote } = input
  const undeletes: ActivityEvent[] = []

  const groups = mergeEntityMaps(local.groups, remote.groups, local.tombstones, remote.tombstones, undeletes)
  const projects = mergeEntityMaps(local.projects, remote.projects, local.tombstones, remote.tombstones, undeletes)
  const scripts = mergeEntityMaps(local.scripts, remote.scripts, local.tombstones, remote.tombstones, undeletes)

  // settings / top-level scalars: whole-value LWW
  const sL = stampOf(local.settings as unknown)
  const sR = stampOf(remote.settings as unknown)
  const settingsWinner =
    lwwWinner(sL.updatedAt, sL.writerId, sR.updatedAt, sR.writerId) === 'a' ? local.settings : remote.settings

  // users: per-entry LWW + user-tombstone support; viewers per-entry LWW
  const users = {
    app: mergeUsers(local.users.app, remote.users.app, [...local.tombstones, ...remote.tombstones]),
    viewers: mergeUsers(local.users.viewers, remote.users.viewers, []),
    studioSub: lwwWinner(
      local.updatedAt,
      local.writerId,
      remote.updatedAt,
      remote.writerId,
    ) === 'a'
      ? local.users.studioSub
      : remote.users.studioSub,
  }

  // tombstones: union by (type,id), newest wins
  const tombMap = new Map<string, Tombstone>()
  for (const t of [...remote.tombstones, ...local.tombstones]) {
    const k = `${t.type}|${t.id}`
    const prev = tombMap.get(k)
    if (!prev || compareHlc(t.at, prev.at) > 0) tombMap.set(k, t)
  }
  const tombstones = [...tombMap.values()]

  // activity: union (dedupe), newest last, capped ring
  const actMap = new Map<string, ActivityEvent>()
  for (const e of [...local.activity, ...remote.activity]) actMap.set(activityKey(e), e)
  const activity = [...actMap.values()].sort((a, b) => compareHlc(a.at, b.at)).slice(-RING_CAP)

  // snapshots: union by fileId
  const snapMap = new Map<string, NexusDoc['snapshots'][number]>()
  for (const s of [...remote.snapshots, ...local.snapshots]) snapMap.set(s.fileId, s)
  const snapshots = [...snapMap.values()]

  const merged: NexusDoc = {
    ...passthrough(remote, local), // top-level unknown fields preserved
    schema: Math.max(local.schema, remote.schema),
    rev: Math.max(local.rev, remote.rev),
    writerId: local.writerId,
    updatedAt: local.updatedAt,
    ids: local.ids.nexusFileId ? local.ids : remote.ids,
    users,
    settings: settingsWinner,
    groups,
    projects,
    scripts,
    tombstones,
    activity,
    snapshots,
    crypto: local.crypto ?? remote.crypto,
  }
  return { merged, undeletes }
}

/** Remove tombstones older than gcDays AND the deleted entities they cover. */
export function gcTombstones(doc: NexusDoc, gcDays: number, nowMs: number): NexusDoc {
  const cutoffMs = nowMs - gcDays * 24 * 3600 * 1000
  const kept: Tombstone[] = []
  const expiredIds = new Set<string>()
  for (const t of doc.tombstones) {
    const { ms } = { ms: Number(t.at.split('.')[0]) }
    if (Number.isFinite(ms) && ms < cutoffMs) expiredIds.add(`${t.type}|${t.id}`)
    else kept.push(t)
  }
  if (expiredIds.size === 0) return doc
  const out: NexusDoc = { ...doc, tombstones: kept }
  for (const key of expiredIds) {
    const [type, id] = key.split('|') as ['group' | 'project' | 'script' | 'user', string]
    if (type === 'group') {
      const e = out.groups[id]
      if (e && e.deleted) {
        const next = { ...out.groups }
        delete next[id]
        out.groups = next
      }
    } else if (type === 'project') {
      const e = out.projects[id]
      if (e && e.deleted) {
        const next = { ...out.projects }
        delete next[id]
        out.projects = next
      }
    } else if (type === 'script') {
      const e = out.scripts[id]
      if (e && e.deleted) {
        const next = { ...out.scripts }
        delete next[id]
        out.scripts = next
      }
    }
  }
  return out
}
