// Unit tests for util/scriptUrl.ts — the URL view-state parse/serialize for
// the Scripts library + workspace. Hand-edited or stale links must never
// crash the page: unknown values fall back to undefined (then defaults).

import { describe, expect, it } from 'vitest'
import { parseScriptList, parseScriptView, serializeScriptList, serializeScriptView } from '../src/util/scriptUrl'

describe('parseScriptView', () => {
  it('accepts valid values', () => {
    const got = parseScriptView({ tab: 'story', select: 'beat_1' })
    expect(got).toEqual({ tab: 'story', select: 'beat_1' })
  })

  it('accepts every workspace tab', () => {
    for (const tab of ['brief', 'story', 'shots', 'graph', 'manuscript']) {
      expect(parseScriptView({ tab }).tab).toBe(tab)
    }
  })

  it('drops garbage instead of crashing the page', () => {
    expect(parseScriptView({ tab: 'hack', select: 42 })).toEqual({ select: undefined })
  })

  it('empty strings mean absent', () => {
    expect(parseScriptView({ tab: '', select: '' })).toEqual({})
  })
})

describe('serializeScriptView', () => {
  it('omits defaults so share links stay short', () => {
    expect(serializeScriptView({ tab: 'brief' })).toEqual({})
  })

  it('round-trips non-defaults', () => {
    const view = { tab: 'graph' as const, select: 'scn_9' }
    expect(parseScriptView(serializeScriptView(view))).toEqual(view)
  })
})

describe('parseScriptList', () => {
  it('accepts filters and clamps q', () => {
    expect(parseScriptList({ q: 'teaser', status: 'review' })).toEqual({ q: 'teaser', status: 'review' })
    expect(parseScriptList({ q: 'x'.repeat(500) }).q).toHaveLength(100)
  })

  it('drops unknown statuses and empty strings', () => {
    expect(parseScriptList({ status: 'hack', q: '' })).toEqual({})
  })
})

describe('serializeScriptList', () => {
  it('omits unset filters and round-trips set ones', () => {
    expect(serializeScriptList({})).toEqual({})
    const view = { q: 'rough', status: 'final' as const }
    expect(parseScriptList(serializeScriptList(view))).toEqual(view)
  })
})
