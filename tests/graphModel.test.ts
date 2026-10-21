// Unit tests for graphModel.ts — the pure Story Graph derivation: nodes per
// live entity, contains/follows derived (never stored), stored links as their
// own edges, only ATTACHED refs appear, and the tidy layout honors saved pos.

import { describe, expect, it } from 'vitest'
import { buildGraphModel, filterModel, nodeId, parseNodeId, type GraphModel } from '../src/ui/pages/scripts/graphModel'
import { emptyDoc, type Script } from '../src/types/schema'

const NOW = '2026-01-01T00:00:00.000Z'

function script(): Script {
  return {
    id: 'scr_1',
    title: 'The Film',
    storage: { type: 'md', fileId: '' },
    projectId: null,
    status: 'draft',
    copies: [],
    acts: [
      { id: 'act_opening', name: 'Opening' },
      { id: 'act_middle', name: 'Middle' },
    ],
    createdAt: NOW,
    updatedAt: NOW,
    writerId: 'w',
    deleted: null,
    archivedAt: null,
  }
}

function entity(id: string, extra: Record<string, unknown>): Record<string, unknown> {
  return { id, createdAt: NOW, updatedAt: NOW, writerId: 'w', deleted: null, archivedAt: null, ...extra }
}

function doc(): ReturnType<typeof emptyDoc> {
  const d = emptyDoc()
  d.scripts['scr_1'] = script()
  return d
}

const kindsOf = (m: GraphModel) => m.nodes.map((n) => n.kind)
const edgePairs = (m: GraphModel) => m.edges.map((e) => `${e.source}->${e.target}`)

describe('buildGraphModel', () => {
  it('builds the hierarchy: concept, act lanes, beats, scenes, shots', () => {
    const d = doc()
    d.beats['b1'] = entity('b1', { scriptId: 'scr_1', actId: 'act_opening', title: 'Cold open', sort: 100 }) as never
    d.scenes['s1'] = entity('s1', { scriptId: 'scr_1', beatId: 'b1', title: 'Rooftops', sort: 100 }) as never
    d.shots['sh1'] = entity('sh1', { scriptId: 'scr_1', sceneId: 's1', beatId: null, caption: 'Wide', sort: 100 }) as never
    const m = buildGraphModel(d, d.scripts['scr_1']!)

    expect(kindsOf(m)).toEqual(['concept', 'act', 'act', 'beat', 'scene', 'shot'])
    expect(edgePairs(m)).toContain('concept->act:act_opening')
    expect(edgePairs(m)).toContain('act:act_opening->beat:b1')
    expect(edgePairs(m)).toContain('beat:b1->scene:s1')
    expect(edgePairs(m)).toContain('scene:s1->shot:sh1')
  })

  it('derives follows between consecutive beats within an act only', () => {
    const d = doc()
    d.beats['b1'] = entity('b1', { scriptId: 'scr_1', actId: 'act_opening', title: 'One', sort: 100 }) as never
    d.beats['b2'] = entity('b2', { scriptId: 'scr_1', actId: 'act_opening', title: 'Two', sort: 200 }) as never
    d.beats['b3'] = entity('b3', { scriptId: 'scr_1', actId: 'act_middle', title: 'Three', sort: 100 }) as never
    const m = buildGraphModel(d, d.scripts['scr_1']!)

    expect(edgePairs(m)).toContain('beat:b1->beat:b2') // same act
    expect(edgePairs(m)).not.toContain('beat:b2->beat:b3') // cross-act: never
    expect(m.edges.filter((e) => e.kind === 'follows')).toHaveLength(1)
  })

  it('stores real links as dashed edges; contains/follows are never stored', () => {
    const d = doc()
    d.beats['b1'] = entity('b1', { scriptId: 'scr_1', actId: 'act_opening', sort: 100 }) as never
    d.refs.push(entity('ref_1', { projectId: null, url: 'https://x.example', title: 'Inspo' }) as never)
    d.storyLinks = [
      { id: 'lnk_1', scriptId: 'scr_1', fromKind: 'ref', fromId: 'ref_1', toKind: 'beat', toId: 'b1', rel: 'inspires', note: '', createdAt: NOW, deleted: null },
    ]
    const m = buildGraphModel(d, d.scripts['scr_1']!)

    const stored = m.edges.filter((e) => e.kind === 'stored')
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ source: 'ref:ref_1', target: 'beat:b1', rel: 'inspires' })
  })

  it('shows only ATTACHED refs — the whole library would bury the graph', () => {
    const d = doc()
    d.beats['b1'] = entity('b1', { scriptId: 'scr_1', actId: 'act_opening', sort: 100 }) as never
    d.refs.push(entity('ref_yes', { url: 'https://a.example' }) as never)
    d.refs.push(entity('ref_no', { url: 'https://b.example' }) as never)
    d.storyLinks = [
      { id: 'lnk_1', scriptId: 'scr_1', fromKind: 'script', fromId: 'scr_1', toKind: 'ref', toId: 'ref_yes', rel: 'inspires', note: '', createdAt: NOW, deleted: null },
    ]
    const m = buildGraphModel(d, d.scripts['scr_1']!)
    expect(m.nodes.filter((n) => n.kind === 'ref').map((n) => n.entityId)).toEqual(['ref_yes'])
  })

  it('soft-deleted entities stay off the graph', () => {
    const d = doc()
    d.beats['b1'] = entity('b1', { scriptId: 'scr_1', actId: 'act_opening', sort: 100, deleted: { at: NOW, by: 'w' } }) as never
    const m = buildGraphModel(d, d.scripts['scr_1']!)
    expect(m.nodes.filter((n) => n.kind === 'beat')).toHaveLength(0)
  })

  it('layout: parents center on children; saved pos overrides win', () => {
    const d = doc()
    d.beats['b1'] = entity('b1', { scriptId: 'scr_1', actId: 'act_opening', sort: 100, pos: { x: 40, y: 500 } }) as never
    d.beats['b2'] = entity('b2', { scriptId: 'scr_1', actId: 'act_opening', sort: 200 }) as never
    d.scenes['s1'] = entity('s1', { scriptId: 'scr_1', beatId: 'b2', sort: 100 }) as never
    d.scenes['s2'] = entity('s2', { scriptId: 'scr_1', beatId: 'b2', sort: 200 }) as never
    const m = buildGraphModel(d, d.scripts['scr_1']!)

    const b1 = m.nodes.find((n) => n.entityId === 'b1')!
    expect(b1.x).not.toBe(0) // COL_X + saved offset
    expect(b1.y).toBe(500) // saved y verbatim

    const b2 = m.nodes.find((n) => n.entityId === 'b2')!
    const s1 = m.nodes.find((n) => n.entityId === 's1')!
    const s2 = m.nodes.find((n) => n.entityId === 's2')!
    expect(b2.y).toBe((s1.y + s2.y) / 2) // centered between its scenes
  })

  it('beat-level shots hang off the beat node', () => {
    const d = doc()
    d.beats['b1'] = entity('b1', { scriptId: 'scr_1', actId: 'act_opening', sort: 100 }) as never
    d.shots['sh1'] = entity('sh1', { scriptId: 'scr_1', sceneId: null, beatId: 'b1', caption: 'Insert', sort: 100 }) as never
    const m = buildGraphModel(d, d.scripts['scr_1']!)
    expect(edgePairs(m)).toContain('beat:b1->shot:sh1')
  })

  it('acts with no beats and empty scripts still render', () => {
    const d = doc()
    const m = buildGraphModel(d, d.scripts['scr_1']!)
    expect(kindsOf(m)).toEqual(['concept', 'act', 'act'])
    expect(m.edges.filter((e) => e.kind === 'contains')).toHaveLength(2)
  })
})

describe('nodeId / parseNodeId', () => {
  it('round-trips', () => {
    expect(parseNodeId(nodeId('beat', 'b1'))).toEqual({ kind: 'beat', entityId: 'b1' })
    expect(parseNodeId('concept')).toBeNull()
  })
})

describe('filterModel', () => {
  it('hides a kind and every edge touching it', () => {
    const d = doc()
    d.beats['b1'] = entity('b1', { scriptId: 'scr_1', actId: 'act_opening', sort: 100 }) as never
    d.scenes['s1'] = entity('s1', { scriptId: 'scr_1', beatId: 'b1', sort: 100 }) as never
    const m = buildGraphModel(d, d.scripts['scr_1']!)
    const filtered = filterModel(m, new Set(['scene']))
    expect(filtered.nodes.map((n) => n.kind)).not.toContain('scene')
    expect(filtered.edges.some((e) => e.target === 'scene:s1' || e.source === 'scene:s1')).toBe(false)
    expect(filtered.edges.length).toBeGreaterThan(0)
  })
})
