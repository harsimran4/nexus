// The Story Graph — React Flow canvas over the pure model (graphModel.ts).
// Nodes: concept, act lanes, beats, scenes, shots, attached refs. Edges:
// derived contains/follows + stored storyLinks. Drag persists per-entity pos;
// dragging node-to-node opens the rel picker and creates a storyLink; click
// opens the side panel (the SAME field editors the tabs use). Lazy-loaded —
// this module never enters the app shell chunk.

import { useEffect, useMemo, useState } from 'react'
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { useStore } from '../../../sync/store'
import type { GraphKind } from './graphModel'
import { buildGraphModel, filterModel, parseNodeId, type GraphNode } from './graphModel'
import type { Script, StoryLink, StoryLinkKind, StoryRel } from '../../../types/schema'
import { STORY_LINK_RELS } from '../../../types/schema'
import { useCanWrite } from '../../../auth/session'
import { createStoryLink, setNodePos, setRefPos } from '../../../state/actions'
import { confirmIsOpen, Icon, Modal, toast } from '../../components'
import { BeatFields, LinkRows, SceneFields, ShotFields } from './fields'
import './GraphTab.css'

const REL_COLOR: Record<StoryRel, string> = {
  serves: 'var(--accent)',
  inspires: 'var(--amber, #b98a2f)',
  references: 'var(--green, #4a7c59)',
  contrasts: 'var(--red)',
}

/** The kind chips the filter row offers (concept + acts always render). */
const FILTERABLE: { kind: GraphKind; label: string }[] = [
  { kind: 'beat', label: 'Beats' },
  { kind: 'scene', label: 'Scenes' },
  { kind: 'shot', label: 'Shots' },
  { kind: 'ref', label: 'Refs' },
]

// Column origins mirror graphModel's COL_X (kept here to convert RF's
// absolute drag positions back into the stored per-column offsets).
const COL_X: Record<GraphKind, number> = {
  concept: 0,
  act: 190 + 120,
  beat: (190 + 120) * 2,
  scene: (190 + 120) * 3,
  shot: (190 + 120) * 4,
  ref: (190 + 120) * 5,
}

function StoryNode({ data, selected }: NodeProps): React.JSX.Element {
  const n = (data as { gn: GraphNode }).gn
  return (
    <div className={`sgraph-node sgraph-node-${n.kind}${selected ? ' on' : ''}`}>
      {n.draggable && (
        <>
          <Handle type="target" position={Position.Left} />
          <Handle type="source" position={Position.Right} />
        </>
      )}
      <span className={`badge ${n.kind === 'shot' ? 'todo' : n.kind === 'beat' ? 'doing' : n.kind === 'ref' ? 'kind' : 'label'}`}>{n.kind}</span>
      <span className="sgraph-node-label">{n.label}</span>
      {n.sub && <span className="sgraph-node-sub">{n.sub}</span>}
    </div>
  )
}

export default function GraphTab({
  script,
  focusId,
  setFocus,
}: {
  script: Script
  focusId?: string
  setFocus: (id: string | undefined) => void
}): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const writable = useCanWrite()
  const [hiddenKinds, setHiddenKinds] = useState<Set<GraphKind>>(new Set())
  const [pendingLink, setPendingLink] = useState<{ source: string; target: string } | null>(null)

  const model = useMemo(() => (doc ? filterModel(buildGraphModel(doc, script), hiddenKinds) : null), [doc, script, hiddenKinds])

  const rfNodes = useMemo<Node[]>(
    () =>
      (model?.nodes ?? []).map((n) => ({
        id: n.id,
        type: 'story',
        position: { x: n.x, y: n.y },
        data: { gn: n },
        draggable: n.draggable && writable,
        selectable: n.kind !== 'act',
        connectable: writable && n.draggable,
      })),
    [model, writable],
  )

  const rfEdges = useMemo<Edge[]>(
    () =>
      (model?.edges ?? []).map((e) => {
        if (e.kind === 'stored') {
          return {
            id: e.id,
            source: e.source,
            target: e.target,
            label: e.label,
            className: 'sgraph-edge-stored',
            style: { stroke: REL_COLOR[e.rel ?? 'references'], strokeDasharray: '6 4', strokeWidth: 1.6 },
            labelStyle: { fill: 'var(--muted)', fontSize: 10 },
            labelBgStyle: { fill: 'var(--card)', fillOpacity: 0.9 },
          }
        }
        if (e.kind === 'follows') {
          return { id: e.id, source: e.source, target: e.target, className: 'sgraph-edge-follows', style: { stroke: 'var(--faint)', strokeDasharray: '2 4', strokeWidth: 1 } }
        }
        return { id: e.id, source: e.source, target: e.target, className: 'sgraph-edge-contains', style: { stroke: 'var(--border-strong)', strokeWidth: 1.4 } }
      }),
    [model],
  )

  // Escape peels the side panel / rel picker (and stands down while a confirm
  // dialog is up — the house layering rule).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || confirmIsOpen()) return
      if (pendingLink) setPendingLink(null)
      else if (focusId) setFocus(undefined)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focusId, pendingLink, setFocus])

  const onNodeDragStop = (_e: unknown, node: Node): void => {
    const parsed = parseNodeId(node.id)
    if (!parsed) return
    const { kind, entityId } = parsed
    if (kind !== 'beat' && kind !== 'scene' && kind !== 'shot' && kind !== 'ref') return
    const pos = { x: Math.round(node.position.x - (COL_X[kind] ?? 0)), y: Math.round(node.position.y) }
    if (kind === 'ref') setRefPos(entityId, pos)
    else setNodePos(kind, entityId, pos)
  }

  const onNodeClick = (_e: unknown, node: Node): void => {
    const parsed = parseNodeId(node.id)
    if (!parsed || parsed.kind === 'act') return
    setFocus(parsed.kind === 'concept' ? 'concept' : parsed.entityId)
  }

  const onConnect = (conn: Connection): void => {
    if (!writable || !conn.source || !conn.target || conn.source === conn.target) return
    setPendingLink({ source: conn.source, target: conn.target })
  }

  if (!doc || !model) return <></>

  return (
    <div className="sgraph-wrap">
      <div className="sgraph-toolbar">
        <div className="chips" role="group" aria-label="Show node kinds">
          {FILTERABLE.map((f) => (
            <button
              key={f.kind}
              className={`chip${!hiddenKinds.has(f.kind) ? ' on' : ''}`}
              aria-pressed={!hiddenKinds.has(f.kind)}
              onClick={() =>
                setHiddenKinds((prev) => {
                  const next = new Set(prev)
                  if (next.has(f.kind)) next.delete(f.kind)
                  else next.add(f.kind)
                  return next
                })
              }
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className="faint small">
          {writable ? 'Drag nodes to arrange · drag node→node to link · click to inspect' : 'Click a node to inspect — sign in as an editor to arrange'}
        </span>
      </div>

      <div className="sgraph-canvas" data-testid="story-graph">
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={{ story: StoryNode }}
          onNodeDragStop={onNodeDragStop}
          onNodeClick={onNodeClick}
          onConnect={onConnect}
          nodesConnectable={writable}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          minZoom={0.2}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="var(--border)" gap={22} />
          <Controls showInteractive={false} />
        </ReactFlow>

        {focusId && (
          <aside className="sgraph-panel" aria-label="Node details">
            <GraphPanel script={script} focusId={focusId} onClose={() => setFocus(undefined)} writable={writable} />
          </aside>
        )}
      </div>

      {pendingLink && <RelPickerModal script={script} source={pendingLink.source} target={pendingLink.target} onClose={() => setPendingLink(null)} />}
    </div>
  )
}

/** Node-to-node link creation — pick a relation, we store the storyLink. */
function RelPickerModal({
  script,
  source,
  target,
  onClose,
}: {
  script: Script
  source: string
  target: string
  onClose: () => void
}): React.JSX.Element {
  const link = (rel: StoryRel): void => {
    const from = parseNodeId(source)
    const to = parseNodeId(target)
    if (!from || !to) return
    try {
      createStoryLink({
        scriptId: script.id,
        from: { kind: from.kind === 'act' ? 'beat' : (from.kind as StoryLinkKind), id: from.entityId },
        to: { kind: to.kind === 'act' ? 'beat' : (to.kind as StoryLinkKind), id: to.entityId },
        rel,
      })
      toast.success(`Linked (${rel})`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not link')
    }
    onClose()
  }

  return (
    <Modal title="What kind of link?" onClose={onClose}>
      <div className="story-links">
        {STORY_LINK_RELS.map((rel) => (
          <button key={rel} className="story-link story-link-btn" onClick={() => link(rel)}>
            <span className={`badge ${rel === 'serves' ? 'kind' : 'label'}`} style={{ color: REL_COLOR[rel] }}>
              {rel}
            </span>
            <span className="small">
              {rel === 'serves'
                ? 'this scene ALSO serves the other beat'
                : rel === 'inspires'
                  ? 'inspires — a reference feeds an element'
                  : rel === 'references'
                    ? 'references — points at / built from'
                    : 'contrasts with — deliberate opposition'}
            </span>
          </button>
        ))}
      </div>
    </Modal>
  )
}

/** The side panel — the SAME field editors the tabs use, keyed by the
 *  focused node. 'concept' focuses the brief; refs show their link rows. */
function GraphPanel({
  script,
  focusId,
  onClose,
  writable,
}: {
  script: Script
  focusId: string
  onClose: () => void
  writable: boolean
}): React.JSX.Element | null {
  const doc = useStore((s) => s.doc)
  if (!doc) return null

  const linksTouching = (id: string): StoryLink[] =>
    (doc.storyLinks ?? []).filter((l) => !l.deleted && (l.fromId === id || l.toId === id || (l.fromKind === 'script' && l.scriptId === script.id && id === 'concept')))

  let body: React.JSX.Element
  if (focusId === 'concept') {
    const brief = script.brief
    body = (
      <>
        <h3 className="sgraph-panel-title">{script.title}</h3>
        <span className="faint small">The concept — edit the fields on the Brief tab.</span>
        {brief && (
          <div className="story-fields">
            {(['concept', 'premise', 'themes', 'tone', 'mood'] as const)
              .filter((k) => brief[k])
              .map((k) => (
                <div key={k}>
                  <span className="story-field-label">{k}</span>
                  <span className="small">{brief[k]}</span>
                </div>
              ))}
          </div>
        )}
        <LinkRows doc={doc} links={linksTouching('concept')} emptyText="No inspiration attached yet — attach it on the Brief tab." disabled={!writable} />
      </>
    )
  } else {
    const beat = doc.beats[focusId]
    const scene = doc.scenes[focusId]
    const shot = doc.shots[focusId]
    const ref = (doc.refs ?? []).find((r) => r.id === focusId)
    if (beat && !beat.deleted) {
      body = (
        <>
          <h3 className="sgraph-panel-title">{beat.title || 'Untitled beat'}</h3>
          <BeatFields beat={beat} disabled={!writable} />
          <LinkRows doc={doc} links={linksTouching(beat.id)} emptyText="No links yet — drag node→node to create one." disabled={!writable} />
        </>
      )
    } else if (scene && !scene.deleted) {
      body = (
        <>
          <h3 className="sgraph-panel-title">{scene.title || 'Untitled scene'}</h3>
          <SceneFields scene={scene} disabled={!writable} />
          <LinkRows doc={doc} links={linksTouching(scene.id)} emptyText="No links yet." disabled={!writable} />
        </>
      )
    } else if (shot && !shot.deleted) {
      body = (
        <>
          <h3 className="sgraph-panel-title">{shot.caption || 'Untitled shot'}</h3>
          <ShotFields shot={shot} disabled={!writable} />
          <LinkRows doc={doc} links={linksTouching(shot.id)} emptyText="No links yet." disabled={!writable} />
        </>
      )
    } else if (ref && !ref.deleted) {
      body = (
        <>
          <h3 className="sgraph-panel-title">{ref.title || 'Reference'}</h3>
          <a className="small mono" href={ref.url} target="_blank" rel="noreferrer">
            {ref.url}
          </a>
          {ref.note && <span className="small muted">{ref.note}</span>}
          <LinkRows doc={doc} links={linksTouching(ref.id)} emptyText="Not linked to anything here." disabled={!writable} />
        </>
      )
    } else {
      // The focused entity vanished (deleted elsewhere) — peel the panel.
      return null
    }
  }

  return (
    <div className="sgraph-panel-body">
      <button className="icon-btn sgraph-panel-x" title="Close" aria-label="Close details" onClick={onClose}>
        <Icon name="x" size={13} />
      </button>
      {body}
    </div>
  )
}
