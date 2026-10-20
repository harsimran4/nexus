// Property + unit tests for sync/writeDecisions.ts — the write path's pure
// decision points, extracted from writer.ts. These rules decide whether a
// write is blind-safe, whether a remote read is skipped, and whether a
// pending edit may resurrect after a merge — the highest-consequence logic
// in the app, previously covered only by the (excellent) incident-driven
// review passes. Nothing here reads the wall clock.

import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import { applyDecision, reassertEntities, saveDecision, type SyncTokens } from '../src/sync/writeDecisions'
import { emptyDoc } from '../src/types/schema'
import type { NexusDoc } from '../src/types/schema'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** A token set where every field is defined or absent, per the arbitrary. */
const arbTokens: fc.Arbitrary<SyncTokens> = fc.record({
  headRevisionId: fc.option(fc.constantFrom('r1', 'r2', 'r3'), { nil: undefined, freq: 2 }),
  md5Checksum: fc.option(fc.constantFrom('m1', 'm2', 'm3'), { nil: undefined, freq: 2 }),
  version: fc.option(fc.constantFrom('v1', 'v2', 'v3'), { nil: undefined, freq: 2 }),
})

function atLeastOneRev(t: SyncTokens): boolean {
  return t.headRevisionId !== undefined || t.version !== undefined
}

function cloneDoc(doc: NexusDoc): NexusDoc {
  return structuredClone(doc)
}

// ---------------------------------------------------------------------------
// saveDecision — the blind-write gate
// ---------------------------------------------------------------------------

describe('saveDecision', () => {
  it('identical known tokens → write (the fast path)', () => {
    expect(saveDecision({ headRevisionId: 'r1', version: 'v1' }, { headRevisionId: 'r1', version: 'v1' })).toBe('write')
    expect(saveDecision({ headRevisionId: 'r1' }, { headRevisionId: 'r1' })).toBe('write')
    expect(saveDecision({ version: 'v1' }, { version: 'v1' })).toBe('write')
  })

  it('any token difference → rebase', () => {
    expect(saveDecision({ headRevisionId: 'r2' }, { headRevisionId: 'r1' })).toBe('rebase')
    expect(saveDecision({ version: 'v2' }, { version: 'v1' })).toBe('rebase')
    // EITHER token matching is enough: Drive revisions/versions strictly
    // increase per write, so a match on one proves the file didn't move.
    expect(saveDecision({ headRevisionId: 'r1', version: 'v9' }, { headRevisionId: 'r1', version: 'v1' })).toBe('write')
    expect(saveDecision({ headRevisionId: 'r2', version: 'v2' }, { headRevisionId: 'r1', version: 'v1' })).toBe('rebase')
  })

  it('ambiguous remote tokens (both undefined) → rebase, never a blind write', () => {
    expect(saveDecision({}, { headRevisionId: 'r1' })).toBe('rebase')
    expect(saveDecision({}, {})).toBe('rebase')
  })

  it('base without tokens but remote known+new → rebase (nothing verified yet)', () => {
    expect(saveDecision({ headRevisionId: 'r1' }, {})).toBe('rebase')
  })

  // The invariant the write path rests on: a blind write happens ONLY when
  // the remote meta equals a base we verified, and at least one token exists.
  it('PROPERTY: write ⟺ remote known ∧ remote == base on some token', () => {
    fc.assert(
      fc.property(arbTokens, arbTokens, (remote, base) => {
        const decision = saveDecision(remote, base)
        const identical =
          (base.headRevisionId !== undefined && remote.headRevisionId === base.headRevisionId) ||
          (base.version !== undefined && remote.version === base.version)
        if (decision === 'write') {
          expect(atLeastOneRev(remote)).toBe(true)
          expect(identical).toBe(true)
        } else {
          expect(atLeastOneRev(remote) && identical).toBe(false)
        }
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// applyDecision — the read-skip gate
// ---------------------------------------------------------------------------

describe('applyDecision', () => {
  it('identical tokens with a known base → unchanged', () => {
    expect(applyDecision({ headRevisionId: 'r1', version: 'v1' }, { headRevisionId: 'r1', version: 'v1' })).toBe(
      'unchanged',
    )
  })

  it('revision/version movement → read', () => {
    expect(applyDecision({ headRevisionId: 'r2' }, { headRevisionId: 'r1' })).toBe('read')
    expect(applyDecision({ version: 'v2' }, { version: 'v1' })).toBe('read')
  })

  it('md5 mismatch counts ONLY when both sides carry one', () => {
    const base = { headRevisionId: 'r1', md5Checksum: 'm1' }
    expect(applyDecision({ headRevisionId: 'r1', md5Checksum: 'm2' }, base)).toBe('read')
    // remote has no md5 → no signal → unchanged
    expect(applyDecision({ headRevisionId: 'r1' }, base)).toBe('unchanged')
    // base has no md5 → comparison meaningless → unchanged
    expect(applyDecision({ headRevisionId: 'r1', md5Checksum: 'm2' }, { headRevisionId: 'r1' })).toBe('unchanged')
  })

  it('base never verified (no headRevisionId) → always read', () => {
    expect(applyDecision({}, {})).toBe('read')
    expect(applyDecision({ headRevisionId: 'r1' }, {})).toBe('read')
  })

  // applyDecision must never return 'unchanged' when saveDecision would ALSO
  // have refused the fast path for movement reasons — the poller relies on
  // this gate being at least as eager as the writer's.
  it('PROPERTY: any revision/version difference is always a read', () => {
    fc.assert(
      fc.property(arbTokens, arbTokens, (remote, base) => {
        const moved =
          remote.headRevisionId !== base.headRevisionId ||
          remote.version !== base.version ||
          (remote.md5Checksum !== undefined &&
            remote.md5Checksum !== base.md5Checksum &&
            base.md5Checksum !== undefined)
        if (moved) expect(applyDecision(remote, base)).toBe('read')
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// reassertEntities — tombstone-vs-resurrection rules
// ---------------------------------------------------------------------------

const MAPS = ['groups', 'projects', 'scripts'] as const
void MAPS

describe('reassertEntities', () => {
  it('a pending edit for a LIVE entity lands with the fresh stamp', () => {
    const doc = cloneDoc(emptyDoc())
    doc.projects['p0'] = { id: 'p0', name: 'peer edit' } as never
    reassertEntities(doc, [{ map: 'projects', entity: { id: 'p0', name: 'mine' } }], { at: 'T2', by: 'w-me' })
    const landed = doc.projects['p0'] as Record<string, unknown>
    expect(landed.name).toBe('mine')
    expect(landed.updatedAt).toBe('T2')
    expect(landed.writerId).toBe('w-me')
  })

  it('a pending soft-delete re-asserts as deleted:{fresh at,by}', () => {
    const doc = cloneDoc(emptyDoc())
    doc.projects['p0'] = { id: 'p0', name: 'peer edit' } as never
    reassertEntities(doc, [{ map: 'projects', entity: { id: 'p0', deleted: { at: 'T1', by: 'w-me' } } }], {
      at: 'T2',
      by: 'w-me',
    })
    const landed = doc.projects['p0'] as Record<string, unknown>
    expect(landed.deleted).toEqual({ at: 'T2', by: 'w-me' })
  })

  it('THE PURGE RULE: absent + tombstoned stays purged (no resurrection)', () => {
    const doc = cloneDoc(emptyDoc())
    doc.tombstones = [{ type: 'project', id: 'p0', at: 'T1', by: 'w-me' }]
    reassertEntities(doc, [{ map: 'projects', entity: { id: 'p0', name: 'zombie' } }], { at: 'T2', by: 'w-me' })
    expect(doc.projects['p0']).toBeUndefined()
  })

  it('absent with NO tombstone re-asserts (create raced a merge)', () => {
    const doc = cloneDoc(emptyDoc())
    doc.tombstones = [{ type: 'group', id: 'g0', at: 'T1', by: 'w-me' }] // different type
    reassertEntities(doc, [{ map: 'projects', entity: { id: 'p0', name: 'new' } }], { at: 'T2', by: 'w-me' })
    expect((doc.projects['p0'] as Record<string, unknown>).name).toBe('new')
  })

  it('the NEWEST tombstone for the key decides', () => {
    const doc = cloneDoc(emptyDoc())
    doc.tombstones = [
      { type: 'project', id: 'p0', at: 'T0', by: 'w-a' },
      { type: 'project', id: 'p0', at: 'T3', by: 'w-b' },
    ]
    reassertEntities(doc, [{ map: 'projects', entity: { id: 'p0', name: 'zombie' } }], { at: 'T2', by: 'w-me' })
    // newest tombstone (T3) covers the key — stays purged even though the
    // edit is newer than the OLDER tombstone.
    expect(doc.projects['p0']).toBeUndefined()
  })

  it('PROPERTY: tombstoned-pending never resurrects, live-pending always lands, for any interleaving', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('p0', 'p1', 'p2'), { minLength: 0, maxLength: 6 }),
        fc.constantFrom('w-a', 'w-b'),
        (tombstonedIds, tombBy) => {
          const doc = cloneDoc(emptyDoc())
          const tombs = [...new Set<string>(tombstonedIds)]
          doc.tombstones = tombs.map((id, i) => ({
            type: 'project' as const,
            id,
            at: `T${10 + i}`,
            by: tombBy,
          }))
          const pending = ['p0', 'p1', 'p2', 'p3'].map((id) => ({
            map: 'projects' as const,
            entity: { id, name: `mine-${id}` },
          }))
          reassertEntities(doc, pending, { at: 'T99', by: 'w-me' })
          for (const p of pending) {
            const id = String(p.entity.id)
            const tombstoned = tombs.includes(id)
            const landed = doc.projects[id] as Record<string, unknown> | undefined
            if (tombstoned) expect(landed).toBeUndefined()
            else {
              expect(landed).toBeDefined()
              expect(landed?.name).toBe(`mine-${id}`)
            }
          }
        },
      ),
    )
  })

  it('input docs are never aliased: pending entities are copied, not referenced', () => {
    const doc = cloneDoc(emptyDoc())
    const entity = { id: 'p0', name: 'mine' }
    reassertEntities(doc, [{ map: 'projects', entity }], { at: 'T2', by: 'w-me' })
    entity.name = 'mutated afterwards'
    expect((doc.projects['p0'] as Record<string, unknown>).name).toBe('mine')
  })
})
