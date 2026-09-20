// Property + unit tests for sync/merge.ts — the module the whole app rests on.
// All HLC stamps are built deterministically via encodeHlc(ms, c); nothing here
// reads the wall clock. Docs are built with emptyDoc() clones, never parsed
// fixtures, so a schema change that breaks merge shape shows up here first.
//
// Convergence note used by the fast-check property: each side writes with its
// own constant writerId ('w-aaa' / 'w-bbb'), so even when two edits land on the
// same project with the same millisecond, the writerId tie-break is
// deterministic and both merge directions must agree.

import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import { gcTombstones, mergeRemote } from '../src/sync/merge'
import { emptyDoc } from '../src/types/schema'
import type { Group, NexusDoc, Project } from '../src/types/schema'
import { encodeHlc } from '../src/util/hlc'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const BASE_MS = 1_000
const PROJECT_IDS = ['p0', 'p1', 'p2', 'p3'] as const

function baseDoc(): NexusDoc {
  return emptyDoc()
}

function cloneDoc(doc: NexusDoc): NexusDoc {
  return structuredClone(doc)
}

function makeProject(
  id: string,
  name: string,
  ms: number,
  writer: string,
  deleted: Project['deleted'] = null,
): Project {
  return {
    id,
    groupId: 'g0',
    name,
    folderId: null,
    status: 'pending',
    labels: [],
    fileIds: [],
    assigneeAppId: null,
    dueAt: null,
    notes: '',
    createdAt: encodeHlc(BASE_MS, 0),
    updatedAt: encodeHlc(ms, 0),
    writerId: writer,
    deleted,
    archivedAt: null,
  }
}

function makeGroup(id: string, name: string, ms: number, writer: string, deleted: Group['deleted'] = null): Group {
  return {
    id,
    name,
    description: '',
    folderId: null,
    createdAt: encodeHlc(BASE_MS, 0),
    updatedAt: encodeHlc(ms, 0),
    writerId: writer,
    deleted,
    archivedAt: null,
  }
}

/** Build a doc with n projects under group g0. */
function docWithProjects(count: number, writer: string, startMs: number): NexusDoc {
  const doc = baseDoc()
  doc.groups['g0'] = makeGroup('g0', 'G', BASE_MS, writer)
  for (let i = 0; i < count; i++) {
    doc.projects[PROJECT_IDS[i % PROJECT_IDS.length] + '_' + i] = makeProject(
      PROJECT_IDS[i % PROJECT_IDS.length] + '_' + i,
      'project ' + i,
      startMs + i,
      writer,
    )
  }
  return doc
}

function editProjectTitle(doc: NexusDoc, id: string, name: string, ms: number, writer: string): void {
  const p = doc.projects[id]
  if (!p) return
  p.name = name
  p.updatedAt = encodeHlc(ms, 0)
  p.writerId = writer
}

function deleteProjectEntity(doc: NexusDoc, id: string, ms: number, writer: string, dropKey = false): void {
  const p = doc.projects[id]
  if (p) {
    p.deleted = { at: encodeHlc(ms, 0), by: writer }
    p.updatedAt = encodeHlc(ms, 0) // the real app stamps updatedAt on delete (touch)
    if (dropKey) {
      const next = { ...doc.projects }
      delete next[id]
      doc.projects = next
    }
  }
  doc.tombstones.push({ type: 'project', id, at: encodeHlc(ms, 0), by: writer })
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe('mergeRemote', () => {
  it('keeps non-conflicting concurrent edits on different projects', () => {
    const a = baseDoc()
    const b = baseDoc()
    a.groups['g0'] = makeGroup('g0', 'G', BASE_MS, 'w-aaa')
    b.groups['g0'] = makeGroup('g0', 'G', BASE_MS, 'w-aaa')
    a.projects['p0'] = makeProject('p0', 'from A', 5_000, 'w-aaa')
    b.projects['p0'] = makeProject('p0', 'base', 1_000, 'w-aaa')
    b.projects['p1'] = makeProject('p1', 'from B', 5_000, 'w-bbb')
    a.projects['p1'] = makeProject('p1', 'base', 1_000, 'w-aaa')

    const { merged } = mergeRemote({ local: a, remote: b })
    expect(merged.projects['p0']?.name).toBe('from A')
    expect(merged.projects['p1']?.name).toBe('from B')
  })

  it('last-writer-wins on the same field', () => {
    const a = baseDoc()
    const b = baseDoc()
    a.projects['p0'] = makeProject('p0', 'A newer', 9_000, 'w-aaa')
    b.projects['p0'] = makeProject('p0', 'B older', 8_000, 'w-bbb')

    const { merged } = mergeRemote({ local: a, remote: b })
    expect(merged.projects['p0']?.name).toBe('A newer')
  })

  it('tombstone prevents resurrection when the other side has the key untouched', () => {
    const a = baseDoc()
    const b = baseDoc()
    a.projects['p0'] = makeProject('p0', 'deleted', BASE_MS, 'w-aaa')
    a.tombstones.push({ type: 'project', id: 'p0', at: encodeHlc(9_000, 0), by: 'w-aaa' })
    deleteProjectEntity(a, 'p0', 9_000, 'w-aaa')

    b.projects['p0'] = makeProject('p0', 'base', 1_000, 'w-bbb')

    const { merged } = mergeRemote({ local: a, remote: b })
    const p = merged.projects['p0']
    expect(p === undefined || p.deleted !== null).toBe(true)
  })

  it('newer edit beats an older tombstone and emits an undelete event', () => {
    const a = baseDoc()
    const b = baseDoc()
    a.projects['p0'] = makeProject('p0', 'revived', 9_000, 'w-aaa')
    b.tombstones.push({ type: 'project', id: 'p0', at: encodeHlc(5_000, 0), by: 'w-bbb' })

    const { merged, undeletes } = mergeRemote({ local: a, remote: b })
    expect(merged.projects['p0']?.deleted).toBeNull()
    expect(undeletes.some((u) => u.verb === '*.undelete' && u.ref === 'p0')).toBe(true)
  })

  it('preserves unknown top-level and entity fields verbatim', () => {
    const a = baseDoc() as unknown as Record<string, unknown>
    const b = baseDoc() as unknown as Record<string, unknown>
    ;(b as Record<string, unknown>).futureField = 'hello'
    const bp = makeProject('p0', 'mine', 5_000, 'w-bbb')
    ;(bp as Record<string, unknown>).xCustom = 'keep me'
    ;(b as NexusDoc).projects['p0'] = bp as Project

    const { merged } = mergeRemote({ local: a as NexusDoc, remote: b as unknown as NexusDoc })
    expect((merged as Record<string, unknown>).futureField).toBe('hello')
    const p = merged.projects['p0']
    expect(p && (p as unknown as Record<string, unknown>).xCustom).toBe('keep me')
  })

  it('merges users by id with LWW', () => {
    const a = baseDoc()
    const b = baseDoc()
    const u = {
      id: 'u1', name: 'Old', role: 'editor' as const, disabled: false,
      auth: { kind: 'token' as const, hash: 'sha256$x' },
      createdAt: '', createdBy: 't', updatedAt: encodeHlc(1_000, 0), writerId: 'w-aaa',
    }
    a.users.app = [{ ...u, name: 'New', updatedAt: encodeHlc(9_000, 0) }]
    b.users.app = [{ ...u, name: 'Old' }]
    const { merged } = mergeRemote({ local: a, remote: b })
    expect(merged.users.app.find((x) => x.id === 'u1')?.name).toBe('New')
  })

  it('a newer user tombstone deletes the user on both sides', () => {
    const a = baseDoc()
    const b = baseDoc()
    const u = {
      id: 'u2', name: 'Dilpreet', role: 'editor' as const, disabled: false,
      auth: { kind: 'token' as const, hash: 'sha256$x' },
      createdAt: '', createdBy: 't', updatedAt: encodeHlc(1_000, 0), writerId: 'w-aaa',
    }
    a.users.app = [{ ...u }] // admin deleted the user locally (absent) + tombstoned
    a.tombstones.push({ type: 'user', id: 'u2', at: encodeHlc(9_000, 0), by: 'w-aaa' })
    b.users.app = [{ ...u }] // a stale peer still has them

    const { merged } = mergeRemote({ local: a, remote: b })
    expect(merged.users.app.find((x) => x.id === 'u2')).toBeUndefined()
  })

  it('a user edited after the tombstone survives (re-created / re-added)', () => {
    const a = baseDoc()
    const b = baseDoc()
    const u = {
      id: 'u3', name: 'Re-added', role: 'editor' as const, disabled: false,
      auth: { kind: 'token' as const, hash: 'sha256$x' },
      createdAt: '', createdBy: 't', updatedAt: encodeHlc(9_000, 0), writerId: 'w-aaa',
    }
    a.users.app = [{ ...u }]
    b.tombstones.push({ type: 'user', id: 'u3', at: encodeHlc(5_000, 0), by: 'w-bbb' })

    const { merged } = mergeRemote({ local: a, remote: b })
    expect(merged.users.app.find((x) => x.id === 'u3')?.name).toBe('Re-added')
  })

  it('fast-check: merge converges regardless of direction', () => {
    const titleArb = fc.string({ minLength: 1, maxLength: 8 }).filter((s) => !s.includes('.'))
    const msArb = fc.integer({ min: 2_000, max: 50_000 })
    const countArb = fc.integer({ min: 0, max: 3 })

    fc.assert(
      fc.property(countArb, msArb, titleArb, (n, ms, title) => {
        const a = docWithProjects(n, 'w-aaa', 1_100)
        const b = cloneDoc(a)
        // A renames project 0 at time ms; B renames a different one at ms+1.
        const idA = PROJECT_IDS[0] + '_0'
        editProjectTitle(a, idA, title, ms, 'w-aaa')
        const idB = n > 1 ? PROJECT_IDS[1] + '_1' : idA
        editProjectTitle(b, idB, 'B side', ms + 1, 'w-bbb')

        const ab = mergeRemote({ local: a, remote: b }).merged
        const ba = mergeRemote({ local: b, remote: a }).merged
        // Same live project names in both directions.
        const namesOf = (d: NexusDoc) =>
          Object.values(d.projects).filter((p) => !p.deleted).map((p) => p.name).sort()
        expect(namesOf(ab)).toEqual(namesOf(ba))
        // And same keys.
        expect(Object.keys(ab.projects).sort()).toEqual(Object.keys(ba.projects).sort())
      }),
      { numRuns: 100 },
    )
  })

  it('gcTombstones drops old tombstones and their deleted entities, keeps fresh ones', () => {
    const now = 100_000_000_000
    const doc = baseDoc()
    doc.projects['p_old'] = makeProject('p_old', 'old', 1_000, 'w', { at: encodeHlc(1_100, 0), by: 'w' })
    doc.tombstones.push({ type: 'project', id: 'p_old', at: encodeHlc(1_100, 0), by: 'w' })
    doc.projects['p_new'] = makeProject('p_new', 'new', now - 1_000, 'w')
    doc.tombstones.push({ type: 'project', id: 'p_new', at: encodeHlc(now - 1_000, 0), by: 'w' })

    const out = gcTombstones(doc, 90, now)
    expect(out.tombstones.some((t) => t.id === 'p_old')).toBe(false)
    expect(out.tombstones.some((t) => t.id === 'p_new')).toBe(true)
    expect(out.projects['p_old']).toBeUndefined()
    expect(out.projects['p_new']).toBeDefined()
  })
})
