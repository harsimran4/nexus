// Shared story field editors — the ONE editing dialect for beats, scenes,
// shots and story links, reused by the workspace tabs and (Phase 2) the Story
// Graph side panel. Uncontrolled inputs that commit on blur, exactly like the
// script title input: no re-render churn while typing, Escape just reverts.

import { useState } from 'react'
import type { NexusDoc, StoryLink } from '../../../types/schema'
import { updateBeat, updateScene, updateShot, deleteStoryLink, updateStoryLink } from '../../../state/actions'
import { Icon } from '../../components'

const REL_LABEL: Record<string, string> = {
  serves: 'serves',
  inspires: 'inspires',
  references: 'references',
  contrasts: 'contrasts with',
}

/** Resolve one endpoint to a human label for link rows. */
export function endpointLabel(doc: NexusDoc, kind: string, id: string): string {
  if (kind === 'script') return doc.scripts[id]?.title ? `“${doc.scripts[id]!.title}” brief` : 'the brief'
  if (kind === 'ref') {
    const r = (doc.refs ?? []).find((x) => x.id === id)
    const t = r?.title || r?.url || 'a reference'
    return t.length > 40 ? t.slice(0, 38) + '…' : t
  }
  if (kind === 'beat') return doc.beats[id]?.title || 'Untitled beat'
  if (kind === 'scene') return doc.scenes[id]?.title || 'Untitled scene'
  if (kind === 'shot') return doc.shots[id]?.caption || 'Untitled shot'
  return id
}

/** One commit-on-blur text field. */
function BlurField({
  label,
  value,
  rows,
  placeholder,
  disabled,
  mono,
  onCommit,
}: {
  label?: string
  value: string
  rows?: number
  placeholder: string
  disabled?: boolean
  mono?: boolean
  onCommit: (v: string) => void
}): React.JSX.Element {
  return (
    <label className="story-field">
      {label && <span className="story-field-label">{label}</span>}
      {rows ? (
        <textarea
          className="input"
          rows={rows}
          defaultValue={value}
          placeholder={placeholder}
          disabled={disabled}
          onBlur={(e) => {
            const v = e.target.value
            if (v !== value) onCommit(v)
          }}
        />
      ) : (
        <input
          className={'input' + (mono ? ' mono' : '')}
          defaultValue={value}
          placeholder={placeholder}
          disabled={disabled}
          onBlur={(e) => {
            const v = e.target.value
            if (v !== value) onCommit(v)
          }}
        />
      )}
    </label>
  )
}

export function BeatFields({ beat, disabled }: { beat: { id: string; title: string; summary: string; purpose: string; bridge: string }; disabled?: boolean }): React.JSX.Element {
  return (
    <div className="story-fields">
      <BlurField label="What happens" rows={2} value={beat.summary} placeholder="What happens in this beat?" disabled={disabled} onCommit={(v) => updateBeat(beat.id, { summary: v })} />
      <BlurField label="Why it matters" rows={2} value={beat.purpose} placeholder="Why does this beat matter?" disabled={disabled} onCommit={(v) => updateBeat(beat.id, { purpose: v })} />
      <BlurField label="Into the next beat" rows={2} value={beat.bridge} placeholder="How does it hand off to the next beat?" disabled={disabled} onCommit={(v) => updateBeat(beat.id, { bridge: v })} />
    </div>
  )
}

export function SceneFields({ scene, disabled }: { scene: { id: string; title: string; action: string; location: string }; disabled?: boolean }): React.JSX.Element {
  return (
    <div className="story-fields">
      <BlurField label="Action" rows={2} value={scene.action} placeholder="What happens in this scene?" disabled={disabled} onCommit={(v) => updateScene(scene.id, { action: v })} />
      <BlurField label="Location" value={scene.location} placeholder="Where does it happen?" disabled={disabled} onCommit={(v) => updateScene(scene.id, { location: v })} />
    </div>
  )
}

const SHOT_SIZES = ['Establishing wide', 'Wide', 'Medium', 'Close-up', 'Extreme close-up', 'Insert', 'Over-the-shoulder']
const CAMERA_MOVES = ['Static', 'Pan', 'Tilt', 'Dolly in', 'Dolly out', 'Tracking', 'Handheld', 'Crane', 'Drone', 'Zoom']

export function ShotFields({ shot, disabled }: { shot: { id: string; caption: string; shotSize: string; cameraMove: string; composition: string; lighting: string; sound: string; durationSec?: number }; disabled?: boolean }): React.JSX.Element {
  return (
    <div className="story-fields">
      <BlurField label="Caption" rows={2} value={shot.caption} placeholder="What do we see?" disabled={disabled} onCommit={(v) => updateShot(shot.id, { caption: v })} />
      <div className="story-field-pair">
        <label className="story-field">
          <span className="story-field-label">Shot size</span>
          <input
            className="input"
            defaultValue={shot.shotSize}
            placeholder="Wide, close-up…"
            disabled={disabled}
            list="shot-size-opts"
            onBlur={(e) => {
              if (e.target.value !== shot.shotSize) updateShot(shot.id, { shotSize: e.target.value })
            }}
          />
        </label>
        <label className="story-field">
          <span className="story-field-label">Camera move</span>
          <input
            className="input"
            defaultValue={shot.cameraMove}
            placeholder="Static, pan, dolly…"
            disabled={disabled}
            list="camera-move-opts"
            onBlur={(e) => {
              if (e.target.value !== shot.cameraMove) updateShot(shot.id, { cameraMove: e.target.value })
            }}
          />
        </label>
      </div>
      <datalist id="shot-size-opts">
        {SHOT_SIZES.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      <datalist id="camera-move-opts">
        {CAMERA_MOVES.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      <BlurField label="Composition" value={shot.composition} placeholder="Framing, depth, symmetry…" disabled={disabled} onCommit={(v) => updateShot(shot.id, { composition: v })} />
      <BlurField label="Lighting" value={shot.lighting} placeholder="Natural, golden hour, practicals…" disabled={disabled} onCommit={(v) => updateShot(shot.id, { lighting: v })} />
      <BlurField label="Sound" value={shot.sound} placeholder="Dialogue, room tone, score cue…" disabled={disabled} onCommit={(v) => updateShot(shot.id, { sound: v })} />
      <label className="story-field">
        <span className="story-field-label">Duration (seconds)</span>
        <input
          className="input"
          type="number"
          min={0}
          step={0.5}
          defaultValue={shot.durationSec ?? ''}
          placeholder="—"
          disabled={disabled}
          onBlur={(e) => {
            const raw = e.target.value.trim()
            if (raw === '') {
              if (shot.durationSec !== undefined) updateShot(shot.id, { durationSec: undefined })
              return
            }
            const n = Number(raw)
            if (Number.isFinite(n) && n >= 0 && n !== shot.durationSec) updateShot(shot.id, { durationSec: n })
          }}
        />
      </label>
    </div>
  )
}

/** The rows of story links touching an element — rel badge, endpoint label,
 *  optional note, and inline note edit + unlink. */
export function LinkRows({
  doc,
  links,
  emptyText,
  disabled,
}: {
  doc: NexusDoc
  links: StoryLink[]
  emptyText: string
  disabled?: boolean
}): React.JSX.Element {
  const [editing, setEditing] = useState<string | null>(null)
  if (links.length === 0) return <span className="faint small">{emptyText}</span>
  return (
    <div className="story-links">
      {links.map((l) => {
        const other = l.fromKind === 'script' ? { kind: l.toKind, id: l.toId } : { kind: l.fromKind, id: l.fromId }
        // For brief-level links show the far endpoint; for entity→entity links
        // show both ends.
        const bothEnds = l.fromKind !== 'script' && l.toKind !== 'script'
        return (
          <div key={l.id} className="story-link">
            <span className={`badge ${l.rel === 'serves' ? 'kind' : 'label'}`} title={REL_LABEL[l.rel]}>{REL_LABEL[l.rel] ?? l.rel}</span>
            <span className="small">
              {bothEnds ? (
                <>
                  {endpointLabel(doc, l.fromKind, l.fromId)} <span className="faint">→</span> {endpointLabel(doc, l.toKind, l.toId)}
                </>
              ) : (
                endpointLabel(doc, other.kind, other.id)
              )}
            </span>
            {editing === l.id ? (
              <input
                className="input story-link-note"
                autoFocus
                defaultValue={l.note}
                placeholder="Why does this connect?"
                onBlur={(e) => {
                  if (e.target.value !== l.note) updateStoryLink(l.id, { note: e.target.value })
                  setEditing(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setEditing(null)
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
              />
            ) : (
              l.note && <span className="faint small story-link-note-text">{l.note}</span>
            )}
            {!disabled && (
              <span className="row" style={{ gap: 2, marginLeft: 'auto' }}>
                <button className="icon-btn" title="Edit note" aria-label="Edit link note" onClick={() => setEditing(l.id)}>
                  <Icon name="pencil" size={13} />
                </button>
                <button
                  className="icon-btn"
                  title="Remove link"
                  aria-label="Remove link"
                  onClick={() => {
                    deleteStoryLink(l.id)
                  }}
                >
                  <Icon name="x" size={13} />
                </button>
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
