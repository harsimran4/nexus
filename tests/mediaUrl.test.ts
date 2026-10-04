// Unit tests for util/mediaUrl.ts — the URL view-state parse/serialize for
// the project page. Everything here guards against hand-edited or stale
// links crashing the Media tab.

import { describe, expect, it } from 'vitest'
import { parseMediaView, serializeMediaView } from '../src/util/mediaUrl'

describe('parseMediaView', () => {
  it('accepts valid values', () => {
    const got = parseMediaView({ tab: 'scripts', section: 'sec_1', kind: 'video', sort: 'name-asc', q: 'hero', file: 'groups/g/p/f_1__a.mp4' })
    expect(got).toEqual({
      tab: 'scripts',
      section: 'sec_1',
      kind: 'video',
      sort: 'name-asc',
      q: 'hero',
      file: 'groups/g/p/f_1__a.mp4',
    })
  })

  it('drops garbage instead of crashing the page', () => {
    const got = parseMediaView({ tab: 'hack', kind: 'hologram', sort: 'sideways', q: 42 })
    expect(got).toEqual({ section: undefined, q: undefined })
  })

  it('maps legacy added-* sorts onto their date-* replacements', () => {
    expect(parseMediaView({ sort: 'added-desc' }).sort).toBe('date-desc')
    expect(parseMediaView({ sort: 'added-asc' }).sort).toBe('date-asc')
  })

  it('clamps q to 100 chars', () => {
    expect(parseMediaView({ q: 'x'.repeat(500) }).q).toHaveLength(100)
  })

  it('empty strings mean absent', () => {
    expect(parseMediaView({ q: '', tab: '' })).toEqual({})
  })
})

describe('serializeMediaView', () => {
  it('omits defaults so share links stay short', () => {
    expect(serializeMediaView({ tab: 'media', section: 'all', kind: 'all', sort: 'date-desc' })).toEqual({})
  })

  it('round-trips non-defaults', () => {
    const view = { tab: 'scripts' as const, section: 'sec_9', kind: 'audio' as const, sort: 'size-asc' as const, q: 'vo' }
    expect(parseMediaView(serializeMediaView(view))).toEqual(view)
  })
})
