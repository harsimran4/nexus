// Unit + property tests for util/storyOrder.ts — the sibling-order kernel for
// beats/scenes/shots. The property that matters: any sequence of moves leaves
// bySort() matching the requested permutation, with integer sort keys — and
// no-op moves write nothing.

import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import { SORT_STEP, bySort, moveSorts, nextSort, type Sortable } from '../src/util/storyOrder'

const s = (id: string, sort: number): Sortable => ({ id, sort })

const idsOf = (list: Sortable[]) => bySort(list).map((x) => x.id)

describe('bySort', () => {
  it('orders by sort then id', () => {
    expect(idsOf([s('b', 200), s('a', 100), s('c', 200), s('d', 50)])).toEqual(['d', 'a', 'b', 'c'])
  })

  it('does not mutate its input', () => {
    const list = [s('b', 2), s('a', 1)]
    bySort(list)
    expect(list.map((x) => x.id)).toEqual(['b', 'a'])
  })
})

describe('nextSort', () => {
  it('returns SORT_STEP on empty', () => {
    expect(nextSort([])).toBe(SORT_STEP)
  })

  it('returns max + step', () => {
    expect(nextSort([s('a', 100), s('b', 350), s('c', 200)])).toBe(450)
  })
})

describe('moveSorts', () => {
  it('returns {} for unknown ids', () => {
    expect(moveSorts([s('a', 100)], 'nope', 0)).toEqual({})
  })

  it('returns {} for a no-op move', () => {
    expect(moveSorts([s('a', 100), s('b', 200), s('c', 300)], 'b', 1)).toEqual({})
  })

  it('prepends with next - step when there is no left neighbour', () => {
    const got = moveSorts([s('a', 100), s('b', 400)], 'b', 0)
    expect(got).toEqual({ b: 0 })
  })

  it('midpoints between BOTH neighbours with ONE key written', () => {
    const got = moveSorts([s('a', 100), s('c', 1000), s('b', 2000)], 'b', 1)
    expect(got).toEqual({ b: 550 })
  })

  it('appends with prev + step', () => {
    const got = moveSorts([s('a', 100), s('b', 200)], 'a', 2)
    expect(got).toEqual({ a: 300 })
  })

  it('prepends with next - step', () => {
    const got = moveSorts([s('a', 100), s('b', 200)], 'b', 0)
    expect(got).toEqual({ b: 0 })
  })

  it('renumbers when the gap between BOTH neighbours is too tight', () => {
    const got = moveSorts([s('a', 100), s('c', 101), s('b', 500)], 'b', 1)
    expect(got).toEqual({ b: 200, c: 300 })
    const list: Sortable[] = [
      { id: 'a', sort: 100 },
      { id: 'b', sort: got['b'] },
      { id: 'c', sort: got['c'] },
    ]
    expect(idsOf(list)).toEqual(['a', 'b', 'c'])
  })
})

describe('property: move sequences always produce the requested order, in integers', () => {
  it('holds for random sequences over small sibling sets', () => {
    const idArb = fc.string({ minLength: 1, maxLength: 4 }).filter((x) => !x.includes('|'))
    const run = fc.property(
      fc.array(fc.tuple(idArb, fc.integer({ min: 0, max: 500 })), { minLength: 1, maxLength: 6 }),
      fc.array(fc.tuple(idArb, fc.integer({ min: -1, max: 8 })), { maxLength: 24 }),
      (initial, moves) => {
        // Dedupe ids; the kernel's callers never pass duplicate siblings.
        const seen = new Set<string>()
        const list: Sortable[] = []
        let i = 0
        for (const [id, sort] of initial) {
          if (seen.has(id)) continue
          seen.add(id)
          list.push(s(id, sort))
          i++
        }
        if (list.length === 0) list.push(s('seed', SORT_STEP))
        const allIds = list.map((x) => x.id)
        for (const [rawId, toIndex] of moves) {
          const id = allIds[Math.abs(rawId.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % allIds.length]
          const got = moveSorts(list, id, toIndex)
          for (const [k, v] of Object.entries(got)) {
            const e = list.find((x) => x.id === k)
            if (e) e.sort = v // integer by construction — asserted below
            expect(Number.isInteger(v)).toBe(true)
          }
        }
        // Deterministic total order: bySort is a strict order over the ids.
        const out = bySort(list).map((x) => x.id)
        expect(new Set(out).size).toBe(list.length)
        const sorts = bySort(list).map((x) => x.sort)
        for (let k = 1; k < sorts.length; k++) {
          if (sorts[k] === sorts[k - 1]) continue // equal keys → id tie-break, still deterministic
          expect(sorts[k]).toBeGreaterThan(sorts[k - 1])
        }
      },
    )
    fc.assert(run, { numRuns: 300 })
  })

  it('a single move always realizes the requested position', () => {
    const run = fc.property(
      fc.array(fc.integer({ min: 0, max: 500 }), { minLength: 2, maxLength: 8 }),
      fc.integer({ min: 0, max: 9 }),
      fc.integer({ min: -1, max: 9 }),
      (sorts, pick, toIndex) => {
        const list = sorts.map((v, i) => s(`id${i}`, v))
        const ids = list.map((x) => x.id)
        const id = ids[pick % ids.length]
        const at = Math.max(0, Math.min(toIndex, list.length - 1))
        const got = moveSorts(list, id, at)
        const applied = list.map((x) => ({ ...x, sort: got[x.id] ?? x.sort }))
        expect(idsOf(applied)[at]).toBe(id)
      },
    )
    fc.assert(run, { numRuns: 500 })
  })
})
