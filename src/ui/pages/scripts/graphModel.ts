// Pure Story Graph model — derives nodes, edges and a tidy-tree layout from
// the doc. NO React, NO React Flow imports: the component maps these plain
// shapes onto the canvas, and the unit tests exercise the derivation alone.
//
// contains/follows are DERIVED here (from parent pointers + sibling order —
// never stored); stored storyLinks render as their own dashed edges. Only
// refs with a live link INTO this script appear (the whole project library
// would bury the graph).

import type { NexusDoc, Script, StoryLinkKind, StoryRel } from '../../../types/schema'

export type GraphKind = 'concept' | 'act' | 'beat' | 'scene' | 'shot' | 'ref'

export interface GraphNode {
  /** React Flow node id — `kind:id` (concept is just `concept`). */
  id: string
  kind: GraphKind
  /** Backing entity id (script id for concept, act id for acts, ref id…). */
  entityId: string
  label: string
  sub?: string
  x: number
  y: number
  /** Acts are layout lane labels; the concept is the root. Neither drags. */
  draggable: boolean
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  /** derived-contains | derived-follows | stored:<rel> */
  kind: 'contains' | 'follows' | 'stored'
  rel?: StoryRel
  label?: string
}

export interface GraphModel {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export const GRAPH_NODE_W = 190
export const GRAPH_NODE_H = 58
const COL_GAP = 120
const ROW_GAP = 30

const COL_X: Record<GraphKind, number> = {
  concept: 0,
  act: GRAPH_NODE_W + COL_GAP,
  beat: (GRAPH_NODE_W + COL_GAP) * 2,
  scene: (GRAPH_NODE_W + COL_GAP) * 3,
  shot: (GRAPH_NODE_W + COL_GAP) * 4,
  ref: (GRAPH_NODE_W + COL_GAP) * 5,
}

export const nodeId = (kind: GraphKind, entityId: string): string => `${kind}:${entityId}`
export const parseNodeId = (id: string): { kind: StoryLinkKind | 'act' | 'concept'; entityId: string } | null => {
  const i = id.indexOf(':')
  if (i === -1) return null
  return { kind: id.slice(0, i) as StoryLinkKind | 'act' | 'concept', entityId: id.slice(i + 1) }
}

const live = <T extends { deleted: unknown }>(e: T): boolean => e.deleted === null

/** Refs that participate in this script's graph: at least one live link
 *  whose scriptId matches and whose other end is a script element. */
export function attachedRefIds(doc: NexusDoc, scriptId: string): Set<string> {
  const out = new Set<string>()
  for (const l of doc.storyLinks ?? []) {
    if (l.deleted !== null || l.scriptId !== scriptId) continue
    if (l.fromKind === 'ref') out.add(l.fromId)
    if (l.toKind === 'ref') out.add(l.toId)
  }
  return out
}

interface Placed {
  id: string
  kind: GraphKind
  entityId: string
  label: string
  sub?: string
  /** children by column to the right — used to center parents */
  childIds: string[]
  x: number
  y: number
  draggable: boolean
  /** saved graph position (beats/scenes/shots/refs) */
  pos?: { x: number; y: number }
}

export function buildGraphModel(doc: NexusDoc, script: Script): GraphModel {
  const placed = new Map<string, Placed>()

  // --- collect live entities, ordered -------------------------------------
  const actIndex = new Map(script.acts.map((a, i) => [a.id, i]))
  const beats = Object.values(doc.beats).filter((b) => b.scriptId === script.id && live(b))
  beats.sort((a, b) => (actIndex.get(a.actId) ?? 99) - (actIndex.get(b.actId) ?? 99) || a.sort - b.sort || (a.id < b.id ? -1 : 1))
  const scenes = Object.values(doc.scenes).filter((s) => s.scriptId === script.id && live(s))
  const shots = Object.values(doc.shots).filter((s) => s.scriptId === script.id && live(s))
  const sceneSort = (a: { sort: number; id: string }, b: { sort: number; id: string }): number => a.sort - b.sort || (a.id < b.id ? -1 : 1)
  const scenesByBeat = new Map<string, typeof scenes>()
  for (const s of scenes) {
    const list = scenesByBeat.get(s.beatId) ?? []
    list.push(s)
    scenesByBeat.set(s.beatId, list)
  }
  for (const list of scenesByBeat.values()) list.sort(sceneSort)
  const shotsByScene = new Map<string, typeof shots>()
  const shotsByBeat = new Map<string, typeof shots>()
  for (const s of shots) {
    const key = s.sceneId ? shotsByScene : shotsByBeat
    const k = s.sceneId ?? s.beatId
    if (!k) continue
    const list = key.get(k) ?? []
    list.push(s)
    key.set(k, list)
  }
  for (const list of shotsByScene.values()) list.sort(sceneSort)
  for (const list of shotsByBeat.values()) list.sort(sceneSort)

  const refIds = attachedRefIds(doc, script.id)
  const refs = (doc.refs ?? []).filter((r) => !r.deleted && refIds.has(r.id))

  // --- build the tree ------------------------------------------------------
  const concept: Placed = {
    id: 'concept',
    kind: 'concept',
    entityId: script.id,
    label: script.title,
    sub: 'the concept',
    childIds: [],
    x: 0,
    y: 0,
    draggable: false,
  }
  placed.set(concept.id, concept)

  for (const act of script.acts) {
    const n: Placed = {
      id: nodeId('act', act.id),
      kind: 'act',
      entityId: act.id,
      label: act.name,
      sub: 'act',
      childIds: [],
      x: 0,
      y: 0,
      draggable: false,
    }
    placed.set(n.id, n)
    concept.childIds.push(n.id)
  }

  for (const b of beats) {
    const n: Placed = {
      id: nodeId('beat', b.id),
      kind: 'beat',
      entityId: b.id,
      label: b.title || 'Untitled beat',
      sub: b.summary ? b.summary.slice(0, 60) : 'beat',
      childIds: [],
      x: 0,
      y: 0,
      draggable: true,
      pos: b.pos,
    }
    placed.set(n.id, n)
    const actNode = placed.get(nodeId('act', actIndex.has(b.actId) ? b.actId : ''))
    if (actNode) actNode.childIds.push(n.id)
  }

  for (const s of scenes) {
    const n: Placed = {
      id: nodeId('scene', s.id),
      kind: 'scene',
      entityId: s.id,
      label: s.title || 'Untitled scene',
      sub: s.location || 'scene',
      childIds: [],
      x: 0,
      y: 0,
      draggable: true,
      pos: s.pos,
    }
    placed.set(n.id, n)
    const p = placed.get(nodeId('beat', s.beatId))
    if (p) p.childIds.push(n.id)
  }

  for (const s of shots) {
    const parentId = s.sceneId ? nodeId('scene', s.sceneId) : nodeId('beat', s.beatId ?? '')
    const n: Placed = {
      id: nodeId('shot', s.id),
      kind: 'shot',
      entityId: s.id,
      label: s.caption || 'Untitled shot',
      sub: [s.shotSize, s.cameraMove].filter(Boolean).join(' · ') || 'shot',
      childIds: [],
      x: 0,
      y: 0,
      draggable: true,
      pos: s.pos,
    }
    placed.set(n.id, n)
    const p = placed.get(parentId)
    if (p) p.childIds.push(n.id)
  }

  for (const r of refs) {
    const n: Placed = {
      id: nodeId('ref', r.id),
      kind: 'ref',
      entityId: r.id,
      label: r.title || r.url,
      sub: 'reference',
      childIds: [],
      x: 0,
      y: 0,
      draggable: true,
      pos: r.pos,
    }
    placed.set(n.id, n)
    // refs get NO contains edges — their stored links (inspires/references…)
    // are the visual connection; they slot independently in the last column.
  }

  // --- tidy tree: DFS from the concept — leaves take the next slot in their
  // column, parents center on their first/last child. Orphans (a scene whose
  // beat was deleted) aren't reachable from the root; they slot afterwards.
  const nextSlot = new Map<GraphKind, number>()
  const slot = (kind: GraphKind): number => {
    const next = nextSlot.get(kind) ?? 0
    nextSlot.set(kind, next + 1)
    return next * (GRAPH_NODE_H + ROW_GAP)
  }
  const assign = (n: Placed, seen: Set<string>): void => {
    if (seen.has(n.id)) return
    seen.add(n.id)
    const kids = n.childIds.map((id) => placed.get(id)!).filter(Boolean)
    for (const k of kids) assign(k, seen)
    n.y = kids.length > 0 ? (kids[0]!.y + kids[kids.length - 1]!.y) / 2 : slot(n.kind)
  }
  const seen = new Set<string>()
  for (const actId of concept.childIds) assign(placed.get(actId)!, seen)
  concept.y = (() => {
    const kids = concept.childIds.map((id) => placed.get(id)!).filter(Boolean)
    return kids.length ? (kids[0]!.y + kids[kids.length - 1]!.y) / 2 : 0
  })()
  for (const n of placed.values()) {
    if (!seen.has(n.id) && n.kind !== 'concept') n.y = slot(n.kind)
  }

  // Saved positions win (omit-when-unset: their absence is meaningful).
  for (const n of placed.values()) {
    if (n.pos) {
      n.x = COL_X[n.kind] + n.pos.x
      n.y = n.pos.y
    } else {
      n.x = COL_X[n.kind]
    }
  }

  // --- edges ---------------------------------------------------------------
  const edges: GraphEdge[] = []
  for (const n of placed.values()) {
    for (const childId of n.childIds) {
      if (n.kind === 'concept' && childId.startsWith('ref:')) continue // refs connect via their stored links
      edges.push({ id: `c-${n.id}-${childId}`, source: n.id, target: childId, kind: 'contains' })
    }
  }
  // follows: consecutive beats within the same act
  const beatsByAct = new Map<string, typeof beats>()
  for (const b of beats) {
    const list = beatsByAct.get(b.actId) ?? []
    list.push(b)
    beatsByAct.set(b.actId, list)
  }
  for (const list of beatsByAct.values()) {
    for (let i = 1; i < list.length; i++) {
      edges.push({
        id: `f-${list[i - 1]!.id}-${list[i]!.id}`,
        source: nodeId('beat', list[i - 1]!.id),
        target: nodeId('beat', list[i]!.id),
        kind: 'follows',
      })
    }
  }
  for (const l of doc.storyLinks ?? []) {
    if (l.deleted !== null || l.scriptId !== script.id) continue
    const from = linkEndpoint(l.fromKind, l.fromId)
    const to = linkEndpoint(l.toKind, l.toId)
    if (!from || !to) continue
    edges.push({ id: `l-${l.id}`, source: from, target: to, kind: 'stored', rel: l.rel, label: l.rel })
  }

  const nodes: GraphNode[] = [...placed.values()].map((n) => ({
    id: n.id,
    kind: n.kind,
    entityId: n.entityId,
    label: n.label,
    sub: n.sub,
    x: n.x,
    y: n.y,
    draggable: n.draggable,
  }))

  return { nodes, edges }
}

function linkEndpoint(kind: StoryLinkKind, id: string): string | null {
  if (kind === 'script') return 'concept'
  return nodeId(kind, id)
}

/** Filter helper for the toolbar's kind chips — hides a node kind and every
 *  edge touching it (a hidden shot takes its contains edge with it). */
export function filterModel(model: GraphModel, hiddenKinds: Set<GraphKind>): GraphModel {
  if (hiddenKinds.size === 0) return model
  const visible = new Set(model.nodes.filter((n) => !hiddenKinds.has(n.kind)).map((n) => n.id))
  return {
    nodes: model.nodes.filter((n) => !hiddenKinds.has(n.kind)),
    edges: model.edges.filter((e) => visible.has(e.source) && visible.has(e.target)),
  }
}
