// Property + unit tests for sync/merge.ts — the module the whole app rests on.
// All HLC stamps are built deterministically via encodeHlc(ms, c); nothing here
// reads the wall clock. Docs are built with emptyDoc() clones, never parsed
// fixtures, so a schema change that breaks merge shape shows up here first.
//
// Convergence note used by the fast-check property: each side writes with its
// own constant writerId ('w-aaa' / 'w-bbb'), so even when two edits land on the
// same item with the same millisecond, the writerId tie-break is deterministic
// and both merge directions must agree.

import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import { gcTombstones, mergeRemote } from '../src/sync/merge'
import { emptyDoc, parseDoc } from '../src/types/schema'
import type { AppUser, Item, NexusDoc } from '../src/types/schema'
import { encodeHlc } from '../src/util/hlc'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const BASE_MS = 1_000
const ITEM_IDS = ['i0', 'i1', 'i2', 'i3'] as const
type ItemId = (typeof ITEM_IDS)[number]

function baseDoc(): NexusDoc {
  return emptyDoc()
}

function cloneDoc(doc: NexusDoc): NexusDoc {
  return structuredClone(doc)
}

function makeItem(id: string, title: string, ms: number, writer: string, deleted: Item['deleted'] = null): Item {
  return {
    id,
    projectId: null,
    title,
    kind: 'video',
    status: 'pending',
    labels: [],
    fileIds: [],
    assigneeAppId: null,
    dueAt: null,
    notes: '',
    createdAt: encodeHlc(ms, 0),
    updatedAt: encodeHlc(ms, 0),
    writerId: writer,
    deleted,
    archivedAt: null,
  }
}

/** A base doc with four live items, identical on every side of a merge. */
function seededBase(): NexusDoc {
  const doc = baseDoc()
  for (const id of ITEM_IDS) doc.items[id] = makeItem(id, `base ${id}`, BASE_MS, 'base')
  return doc
}

function editItem(doc: NexusDoc, id: string, title: string, ms: number, writer: string): void {
  doc.items[id] = { ...doc.items[id], title, updatedAt: encodeHlc(ms, 0), writerId: writer, deleted: null }
}

function isLive(doc: NexusDoc, id: string): boolean {
  const item = doc.items[id]
  return item !== undefined && item.deleted === null
}

/** Set a field the current schema does not know about (forward-compat payload). */
function setUnknown(target: object, key: string, value: unknown): void {
  ;(target as Record<string, unknown>)[key] = value
}

type StampedAppUser = AppUser & { updatedAt: string; writerId: string }

function appUser(id: string, name: string, ms: number, writer: string): StampedAppUser {
  return {
    id,
    name,
    role: 'editor',
    disabled: false,
    auth: { kind: 'token', hash: `sha256$${id}` },
    createdAt: encodeHlc(ms, 0),
    createdBy: 'tests',
    updatedAt: encodeHlc(ms, 0),
    writerId: writer,
  }
}

// ---------------------------------------------------------------------------
// mergeRemote — deterministic scenarios
// ---------------------------------------------------------------------------

describe('mergeRemote', () => {
  it('keeps non-conflicting concurrent edits to different items', () => {
    const base = seededBase()
    const a = cloneDoc(base)
    editItem(a, 'i1', 'alpha from a', 5_000, 'w-aaa')
    const b = cloneDoc(base)
    editItem(b, 'i2', 'bravo from b', 5_000, 'w-bbb')

    const ab = mergeRemote({ local: a, remote: b }).merged
    expect(ab.items['i1'].title).toBe('alpha from a')
    expect(ab.items['i2'].title).toBe('bravo from b')
    expect(ab.items['i0'].title).toBe('base i0') // untouched item passes through

    const ba = mergeRemote({ local: b, remote: a }).merged
    expect(ba.items['i1'].title).toBe('alpha from a')
    expect(ba.items['i2'].title).toBe('bravo from b')
  })

  it('applies last-writer-wins on the same field with a writerId tie-break', () => {
    const base = seededBase()
    const newer = cloneDoc(base)
    editItem(newer, 'i1', 'newer title', 9_000, 'w-aaa')
    const older = cloneDoc(base)
    editItem(older, 'i1', 'older title', 3_000, 'w-bbb')

    expect(mergeRemote({ local: newer, remote: older }).merged.items['i1'].title).toBe('newer title')
    expect(mergeRemote({ local: older, remote: newer }).merged.items['i1'].title).toBe('newer title')

    // Equal stamps: the higher writerId wins, no matter which side it is on.
    const zed = cloneDoc(base)
    editItem(zed, 'i1', 'zed was here', 5_000, 'w-zzz')
    const aaa = cloneDoc(base)
    editItem(aaa, 'i1', 'aaa was here', 5_000, 'w-aaa')

    expect(mergeRemote({ local: zed, remote: aaa }).merged.items['i1'].title).toBe('zed was here')
    expect(mergeRemote({ local: aaa, remote: zed }).merged.items['i1'].title).toBe('zed was here')
  })

  it('a tombstone prevents resurrection of a deleted item', () => {
    const base = seededBase()
    const stale = cloneDoc(base) // remote still has i1, untouched since the base
    const deleter = cloneDoc(base)
    deleter.items['i1'] = {
      ...deleter.items['i1'],
      deleted: { at: encodeHlc(6_000, 0), by: 'w-aaa' },
      updatedAt: encodeHlc(6_000, 0),
      writerId: 'w-aaa',
    }
    deleter.tombstones = [{ type: 'item', id: 'i1', at: encodeHlc(6_001, 0), by: 'w-aaa' }]

    // The writer keeps the key with its deleted marker — merged must not be live.
    expect(isLive(mergeRemote({ local: deleter, remote: stale }).merged, 'i1')).toBe(false)
    expect(isLive(mergeRemote({ local: stale, remote: deleter }).merged, 'i1')).toBe(false)

    // A peer that already dropped the key must not have it resurrected either.
    const gone = cloneDoc(deleter)
    delete gone.items['i1']
    expect('i1' in mergeRemote({ local: gone, remote: stale }).merged.items).toBe(false)
    expect('i1' in mergeRemote({ local: stale, remote: gone }).merged.items).toBe(false)
  })

  it('a newer edit beats an older tombstone and emits an undelete event', () => {
    const base = seededBase()
    const tombstoned = cloneDoc(base)
    delete tombstoned.items['i1']
    tombstoned.tombstones = [{ type: 'item', id: 'i1', at: encodeHlc(2_000, 0), by: 'w-bbb' }]

    const revived = cloneDoc(base)
    editItem(revived, 'i1', 'revived title', 3_000, 'w-aaa')

    const ab = mergeRemote({ local: revived, remote: tombstoned })
    expect(isLive(ab.merged, 'i1')).toBe(true)
    expect(ab.merged.items['i1'].title).toBe('revived title')
    expect(ab.undeletes).toHaveLength(1)
    expect(ab.undeletes[0].verb).toBe('*.undelete')
    expect(ab.undeletes[0].ref).toBe('i1')
    expect(ab.undeletes[0].actor).toBe('w-aaa')

    const ba = mergeRemote({ local: tombstoned, remote: revived })
    expect(isLive(ba.merged, 'i1')).toBe(true)
    expect(ba.merged.items['i1'].title).toBe('revived title')
    expect(ba.undeletes.some((e) => e.verb === '*.undelete' && e.ref === 'i1')).toBe(true)
  })

  it('preserves unknown top-level and entity fields', () => {
    const local = seededBase()
    const remote = seededBase()
    editItem(local, 'i1', 'local title', 8_000, 'w-aaa') // local wins the LWW on i1...
    editItem(remote, 'i1', 'remote title', 3_000, 'w-bbb') // ...so xCustom must survive via the loser

    setUnknown(remote, 'futureField', { hint: 'from a newer build' })
    setUnknown(remote.items['i1'], 'xCustom', 'custom-value')

    const { merged } = mergeRemote({ local, remote })
    expect((merged as unknown as Record<string, unknown>)['futureField']).toEqual({ hint: 'from a newer build' })
    expect((merged.items['i1'] as unknown as Record<string, unknown>)['xCustom']).toBe('custom-value')
    expect(merged.items['i1'].title).toBe('local title') // known fields still follow LWW

    const reparsed = parseDoc(JSON.stringify(merged))
    expect(reparsed.ok, 'merged doc must still parse against the schema').toBe(true)
  })

  it('merges users by id with newer updatedAt winning', () => {
    const a = seededBase()
    const b = seededBase()
    a.users.app = [appUser('u-1', 'Alice', 1_000, 'w-aaa')]
    b.users.app = [appUser('u-2', 'Bob', 1_000, 'w-bbb')]

    const { merged } = mergeRemote({ local: a, remote: b })
    expect(merged.users.app.map((u) => u.id).sort()).toEqual(['u-1', 'u-2'])

    const a2 = seededBase()
    const b2 = seededBase()
    a2.users.app = [appUser('u-1', 'Alice New', 9_000, 'w-aaa')]
    b2.users.app = [appUser('u-1', 'Alice Old', 4_000, 'w-bbb')]

    expect(mergeRemote({ local: a2, remote: b2 }).merged.users.app[0].name).toBe('Alice New')
    expect(mergeRemote({ local: b2, remote: a2 }).merged.users.app[0].name).toBe('Alice New')
  })

  // -------------------------------------------------------------------------
  // fast-check: convergence for arbitrary pairs built from a common base
  // -------------------------------------------------------------------------

  type SideOp =
    | { kind: 'none' }
    | { kind: 'edit'; title: string; ms: number }
    | { kind: 'delete'; ms: number }

  const opArb: fc.Arbitrary<SideOp> = fc.oneof(
    { weight: 2, arbitrary: fc.record({ kind: fc.constant<'none'>('none') }) },
    {
      weight: 4,
      arbitrary: fc.record({
        kind: fc.constant<'edit'>('edit'),
        title: fc.stringMatching(/[a-z]{1,10}/),
        ms: fc.integer({ min: 2_000, max: 90_000 }),
      }),
    },
    {
      weight: 2,
      arbitrary: fc.record({
        kind: fc.constant<'delete'>('delete'),
        ms: fc.integer({ min: 2_000, max: 90_000 }),
      }),
    },
  )

  const opsArb: fc.Arbitrary<Record<ItemId, SideOp>> = fc.record({
    i0: opArb,
    i1: opArb,
    i2: opArb,
    i3: opArb,
  })

  /** A copy of the base doc where one side applied its ops; deletes drop the key + add a tombstone. */
  function sideDoc(baseMs: number, writer: string, ops: Record<ItemId, SideOp>): NexusDoc {
    const doc = baseDoc()
    for (const id of ITEM_IDS) doc.items[id] = makeItem(id, `base ${id}`, baseMs, 'base')
    for (const id of ITEM_IDS) {
      const op = ops[id]
      if (op.kind === 'edit') {
        doc.items[id] = { ...doc.items[id], title: op.title, updatedAt: encodeHlc(op.ms, 0), writerId: writer, deleted: null }
      } else if (op.kind === 'delete') {
        delete doc.items[id]
        doc.tombstones = [...doc.tombstones, { type: 'item', id, at: encodeHlc(op.ms, 0), by: writer }]
      }
    }
    return doc
  }

  it('converges for arbitrary pairs of docs built from a common base', () => {
    const property = fc.property(
      fc.integer({ min: 1_000, max: 5_000 }), // base stamp ms
      opsArb,
      opsArb,
      (baseMs, opsA, opsB) => {
        const a = sideDoc(baseMs, 'w-aaa', opsA)
        const b = sideDoc(baseMs, 'w-bbb', opsB)

        const ab = mergeRemote({ local: a, remote: b }).merged
        const ba = mergeRemote({ local: b, remote: a }).merged

        expect(Object.keys(ab.items).sort(), 'live item keys must converge').toEqual(Object.keys(ba.items).sort())
        for (const id of Object.keys(ab.items)) {
          expect(ab.items[id].deleted).toBeNull()
          expect(ba.items[id].deleted).toBeNull()
          expect(ab.items[id].title, `title of ${id} must converge`).toBe(ba.items[id].title)
        }
      },
    )
    fc.assert(property, { numRuns: 300 })
  })
})

// ---------------------------------------------------------------------------
// gcTombstones
// ---------------------------------------------------------------------------

describe('gcTombstones', () => {
  const GC_DAY_MS = 24 * 3_600 * 1_000
  const GC_NOW = 1_900_000_000_000

  it('drops expired tombstones and their deleted entities but keeps fresh ones', () => {
    const doc = baseDoc()
    doc.items['i-old'] = makeItem('i-old', 'old', GC_NOW - 100 * GC_DAY_MS, 'w-aaa', {
      at: encodeHlc(GC_NOW - 100 * GC_DAY_MS, 0),
      by: 'w-aaa',
    })
    doc.items['i-fresh'] = makeItem('i-fresh', 'fresh', GC_NOW - 10 * GC_DAY_MS, 'w-aaa', {
      at: encodeHlc(GC_NOW - 10 * GC_DAY_MS, 0),
      by: 'w-aaa',
    })
    doc.items['i-survivor'] = makeItem('i-survivor', 'survivor', GC_NOW - 5 * GC_DAY_MS, 'w-aaa')
    doc.tombstones = [
      { type: 'item', id: 'i-old', at: encodeHlc(GC_NOW - 100 * GC_DAY_MS, 0), by: 'w-aaa' },
      { type: 'item', id: 'i-fresh', at: encodeHlc(GC_NOW - 10 * GC_DAY_MS, 0), by: 'w-aaa' },
      // Expired tombstone over a LIVE entity: tombstone goes, entity must stay.
      { type: 'item', id: 'i-survivor', at: encodeHlc(GC_NOW - 200 * GC_DAY_MS, 0), by: 'w-aaa' },
    ]

    const out = gcTombstones(doc, 90, GC_NOW)

    expect(out.tombstones.map((t) => t.id)).toEqual(['i-fresh'])
    expect('i-old' in out.items).toBe(false) // deleted entity GC'd together with its tombstone
    expect(out.items['i-fresh'].deleted).not.toBeNull() // fresh tombstone: deleted entity kept
    expect(isLive(out, 'i-survivor')).toBe(true) // gc must never kill a live entity
  })
})
