// The Story Builder — acts (Opening/Middle/Ending, seeded on first visit)
// → beats (what happens / why it matters / the bridge out) → scenes, with
// "also serves" secondary beat links (storyLinks rel:'serves'). Everything is
// an ordered list per parent: per-entity sort keys, arrows to move, selects
// to reparent, confirmDialog for cascading deletes.

import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../../../sync/store'
import type { Beat, Scene, Script } from '../../../types/schema'
import { useCanWrite } from '../../../auth/session'
import {
  addAct,
  addBeat,
  addScene,
  createStoryLink,
  deleteBeat,
  deleteScene,
  deleteStoryLink,
  moveBeat,
  moveScene,
  removeAct,
  renameAct,
  reorderActs,
  seedDefaultActs,
  updateBeat,
  updateScene,
} from '../../../state/actions'
import { Empty, Icon, confirmDialog, toast } from '../../components'
import { BeatFields, SceneFields } from './fields'

export function StoryTab({
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
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(focusId ? [focusId] : []))
  const [newActName, setNewActName] = useState('')

  // Seed Opening/Middle/Ending on the first visit — write-gated, idempotent,
  // deterministic ids (two tabs seeding merge to the same trio).
  const seeded = script.acts.length > 0
  useEffect(() => {
    if (writable && !seeded) seedDefaultActs(script.id)
  }, [writable, seeded, script.id])

  const story = useMemo(() => {
    if (!doc) return null
    const beats = Object.values(doc.beats).filter((b) => b.scriptId === script.id && !b.deleted)
    const scenes = Object.values(doc.scenes).filter((x) => x.scriptId === script.id && !x.deleted)
    const shots = Object.values(doc.shots).filter((x) => x.scriptId === script.id && !x.deleted)
    const beatsByAct = new Map<string, Beat[]>()
    for (const a of script.acts) beatsByAct.set(a.id, [])
    for (const b of beats) beatsByAct.get(b.actId)?.push(b)
    for (const list of beatsByAct.values()) list.sort((a, b) => a.sort - b.sort || (a.id < b.id ? -1 : 1))
    const scenesByBeat = new Map<string, Scene[]>()
    for (const s of scenes) {
      const list = scenesByBeat.get(s.beatId) ?? []
      list.push(s)
      scenesByBeat.set(s.beatId, list)
    }
    for (const list of scenesByBeat.values()) list.sort((a, b) => a.sort - b.sort || (a.id < b.id ? -1 : 1))
    const shotsByScene = new Map<string, number>()
    const shotsByBeat = new Map<string, number>()
    for (const s of shots) {
      if (s.sceneId) shotsByScene.set(s.sceneId, (shotsByScene.get(s.sceneId) ?? 0) + 1)
      if (s.beatId) shotsByBeat.set(s.beatId, (shotsByBeat.get(s.beatId) ?? 0) + 1)
    }
    const serves = (doc.storyLinks ?? []).filter((l) => !l.deleted && l.rel === 'serves' && l.fromKind === 'scene' && scenes.some((s) => s.id === l.fromId))
    return { beats, scenes, beatsByAct, scenesByBeat, shotsByScene, shotsByBeat, serves }
  }, [doc, script.id, script.acts])

  if (!doc || !story) return <></>

  const toggle = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const removeActWithConfirm = async (actId: string, name: string, beatCount: number): Promise<void> => {
    const r = await removeAct(script.id, actId)
    if (r === 'refused-last-act') {
      toast.error('This is the only act left', 'An act needs somewhere for its beats to live — add another act first.')
    } else {
      toast.success(`Act “${name}” removed${beatCount ? ` — its ${beatCount} beat${beatCount === 1 ? '' : 's'} moved up` : ''}`)
    }
  }

  const deleteBeatWithConfirm = async (beat: Beat, sceneCount: number, shotCount: number): Promise<void> => {
    const label = beat.title.trim() || 'Untitled beat'
    const ok = await confirmDialog({
      title: `Delete “${label}”?`,
      body: (
        <div className="confirm-body">
          <div className="confirm-what">
            {sceneCount || shotCount
              ? `Its ${[sceneCount ? `${sceneCount} scene${sceneCount === 1 ? '' : 's'}` : '', shotCount ? `${shotCount} shot${shotCount === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ')} go with it.`
              : 'No scenes under it.'}
          </div>
          This removes them for every editor — beats don't come back from the Archive yet.
        </div>
      ),
      confirmLabel: 'Delete beat',
      tone: 'danger',
    })
    if (!ok) return
    deleteBeat(beat.id)
    if (focusId === beat.id) setFocus(undefined)
    toast.success(`Beat “${label}” deleted`)
  }

  const deleteSceneWithConfirm = async (scene: Scene, shotCount: number): Promise<void> => {
    const label = scene.title.trim() || 'Untitled scene'
    const ok = await confirmDialog({
      title: `Delete “${label}”?`,
      body: (
        <div className="confirm-body">
          <div className="confirm-what">{shotCount ? `Its ${shotCount} shot${shotCount === 1 ? '' : 's'} go with it.` : 'No shots on it yet.'}</div>
          This removes them for every editor.
        </div>
      ),
      confirmLabel: 'Delete scene',
      tone: 'danger',
    })
    if (!ok) return
    deleteScene(scene.id)
    if (focusId === scene.id) setFocus(undefined)
    toast.success(`Scene “${label}” deleted`)
  }

  const addServes = (scene: Scene, beatId: string): void => {
    try {
      createStoryLink({ scriptId: script.id, from: { kind: 'scene', id: scene.id }, to: { kind: 'beat', id: beatId }, rel: 'serves' })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not link')
    }
  }

  return (
    <div className="story-wrap">
      {!writable && (
        <div className="card" style={{ marginBottom: 12 }}>
          <span className="faint small">Read-only view — sign in as an editor or admin to shape the story.</span>
        </div>
      )}

      {script.acts.map((act, actIdx) => {
        const beats = story.beatsByAct.get(act.id) ?? []
        return (
          <section key={act.id} className="card story-act">
            <div className="spread story-act-head">
              <h3 style={{ margin: 0 }}>{act.name}</h3>
              {writable && (
                <span className="row" style={{ gap: 2 }}>
                  <ActRename actId={act.id} name={act.name} scriptId={script.id} />
                  <button className="icon-btn" title="Move act earlier" aria-label={`Move ${act.name} earlier`} disabled={actIdx === 0} onClick={() => reorderActs(script.id, act.id, -1)}>
                    <Icon name="chevron-left" size={13} />
                  </button>
                  <button className="icon-btn" title="Move act later" aria-label={`Move ${act.name} later`} disabled={actIdx === script.acts.length - 1} onClick={() => reorderActs(script.id, act.id, 1)}>
                    <Icon name="chevron-right" size={13} />
                  </button>
                  <button
                    className="icon-btn"
                    title={script.acts.length === 1 ? 'The last act cannot be removed' : `Remove ${act.name}`}
                    aria-label={`Remove ${act.name}`}
                    disabled={script.acts.length === 1}
                    onClick={() => void removeActWithConfirm(act.id, act.name, beats.length)}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </span>
              )}
            </div>

            {beats.length === 0 && <span className="faint small story-act-empty">No beats yet — a beat is one turn of the story: what happens, why it matters, how it hands off.</span>}

            {beats.map((b, i) => {
              const scenes = story.scenesByBeat.get(b.id) ?? []
              const shotCount = (story.shotsByBeat.get(b.id) ?? 0) + scenes.reduce((n, s) => n + (story.shotsByScene.get(s.id) ?? 0), 0)
              const isOpen = expanded.has(b.id)
              return (
                <div key={b.id} className="story-beat">
                  <div className="spread story-row-head">
                    <span className="row" style={{ gap: 6, minWidth: 0 }}>
                      <button className="icon-btn" aria-expanded={isOpen} aria-label={isOpen ? 'Collapse beat' : 'Expand beat'} onClick={() => toggle(b.id)}>
                        <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={13} />
                      </button>
                      <input
                        className="input story-title"
                        defaultValue={b.title}
                        placeholder="Untitled beat"
                        disabled={!writable}
                        aria-label="Beat title"
                        onBlur={(e) => {
                          if (e.target.value !== b.title) updateBeat(b.id, { title: e.target.value })
                        }}
                      />
                    </span>
                    <span className="row" style={{ gap: 2 }}>
                      <span className="faint small story-counts">
                        {scenes.length ? `${scenes.length} scene${scenes.length === 1 ? '' : 's'}` : ''}
                        {shotCount ? `${scenes.length ? ' · ' : ''}${shotCount} shot${shotCount === 1 ? '' : 's'}` : ''}
                      </span>
                      {writable && (
                        <>
                          <button className="icon-btn" title="Move beat up" aria-label="Move beat up" disabled={i === 0} onClick={() => moveBeat(b.id, act.id, i - 1)}>
                            <Icon name="chevron-up" size={13} />
                          </button>
                          <button className="icon-btn" title="Move beat down" aria-label="Move beat down" disabled={i === beats.length - 1} onClick={() => moveBeat(b.id, act.id, i + 1)}>
                            <Icon name="chevron-down" size={13} />
                          </button>
                          {script.acts.length > 1 && (
                            <select
                              className="input story-move-select"
                              value={act.id}
                              aria-label="Move beat to act"
                              onChange={(e) => moveBeat(b.id, e.target.value, 9999)}
                            >
                              {script.acts.map((a) => (
                                <option key={a.id} value={a.id}>
                                  {a.name}
                                </option>
                              ))}
                            </select>
                          )}
                          <button className="icon-btn" title="Delete beat" aria-label="Delete beat" onClick={() => void deleteBeatWithConfirm(b, scenes.length, shotCount)}>
                            <Icon name="trash" size={13} />
                          </button>
                        </>
                      )}
                    </span>
                  </div>
                  {isOpen && (
                    <div className="story-detail">
                      <BeatFields beat={b} disabled={!writable} />
                      {scenes.map((sc, si) => {
                        const sceneShots = story.shotsByScene.get(sc.id) ?? 0
                        const sceneOpen = expanded.has(sc.id)
                        const serving = story.serves.filter((l) => l.fromId === sc.id)
                        return (
                          <div key={sc.id} className="story-scene">
                            <div className="spread story-row-head">
                              <span className="row" style={{ gap: 6, minWidth: 0 }}>
                                <button className="icon-btn" aria-expanded={sceneOpen} aria-label={sceneOpen ? 'Collapse scene' : 'Expand scene'} onClick={() => toggle(sc.id)}>
                                  <Icon name={sceneOpen ? 'chevron-down' : 'chevron-right'} size={12} />
                                </button>
                                <input
                                  className="input story-title story-title-scene"
                                  defaultValue={sc.title}
                                  placeholder="Untitled scene"
                                  disabled={!writable}
                                  aria-label="Scene title"
                                  onBlur={(e) => {
                                    if (e.target.value !== sc.title) updateScene(sc.id, { title: e.target.value })
                                  }}
                                />
                              </span>
                              <span className="row" style={{ gap: 2 }}>
                                {sceneShots ? <span className="faint small">{sceneShots} shot{sceneShots === 1 ? '' : 's'}</span> : null}
                                {writable && (
                                  <>
                                    <button className="icon-btn" title="Move scene up" aria-label="Move scene up" disabled={si === 0} onClick={() => moveScene(sc.id, b.id, si - 1)}>
                                      <Icon name="chevron-up" size={12} />
                                    </button>
                                    <button className="icon-btn" title="Move scene down" aria-label="Move scene down" disabled={si === scenes.length - 1} onClick={() => moveScene(sc.id, b.id, si + 1)}>
                                      <Icon name="chevron-down" size={12} />
                                    </button>
                                    <button className="icon-btn" title="Delete scene" aria-label="Delete scene" onClick={() => void deleteSceneWithConfirm(sc, sceneShots)}>
                                      <Icon name="trash" size={12} />
                                    </button>
                                  </>
                                )}
                              </span>
                            </div>
                            {sceneOpen && (
                              <div className="story-detail">
                                <SceneFields scene={sc} disabled={!writable} />
                                <div className="story-serves">
                                  <span className="story-field-label">Also serves</span>
                                  {serving.map((l) => {
                                    const target = story.beats.find((x) => x.id === l.toId)
                                    return (
                                      <span key={l.id} className="story-serve-chip">
                                        {target?.title || 'Untitled beat'}
                                        {writable && (
                                          <button className="story-serve-x" aria-label={`Stop serving ${target?.title || 'beat'}`} onClick={() => deleteStoryLink(l.id)}>
                                            <Icon name="x" size={10} />
                                          </button>
                                        )}
                                      </span>
                                    )
                                  })}
                                  {writable && (
                                    <select
                                      className="input story-move-select"
                                      value=""
                                      aria-label="Add a second beat this scene serves"
                                      onChange={(e) => {
                                        if (e.target.value) addServes(sc, e.target.value)
                                      }}
                                    >
                                      <option value="">Also serves…</option>
                                      {story.beats
                                        .filter((x) => x.id !== b.id && !serving.some((l) => l.toId === x.id))
                                        .map((x) => (
                                          <option key={x.id} value={x.id}>
                                            {x.title || 'Untitled beat'}
                                          </option>
                                        ))}
                                    </select>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        )
                      })}
                      {writable && (
                        <button
                          className="btn ghost small story-add"
                          onClick={() => {
                            const id = addScene(script.id, b.id)
                            if (id) setExpanded((prev) => new Set(prev).add(id))
                          }}
                        >
                          <Icon name="plus" size={12} /> Add scene
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
            })}

            {writable && (
              <button
                className="btn ghost small story-add"
                onClick={() => {
                  const id = addBeat(script.id, act.id)
                  if (id) setExpanded((prev) => new Set(prev).add(id))
                }}
              >
                <Icon name="plus" size={12} /> Add beat
              </button>
            )}
          </section>
        )
      })}

      {writable && (
        <div className="card story-act-add">
          <input
            className="input"
            value={newActName}
            placeholder={`Act ${script.acts.length + 1} — e.g. “Coda”`}
            aria-label="New act name"
            onChange={(e) => setNewActName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newActName.trim()) {
                addAct(script.id, newActName)
                setNewActName('')
              }
            }}
          />
          <button
            className="btn small"
            disabled={!newActName.trim()}
            onClick={() => {
              addAct(script.id, newActName)
              setNewActName('')
            }}
          >
            <Icon name="plus" size={12} /> Add act
          </button>
        </div>
      )}

      {story.beats.length === 0 && script.acts.length > 0 && (
        <Empty icon="✎">Story beats appear under each act — the Opening is a good place to start.</Empty>
      )}
    </div>
  )
}

/** Inline act rename — pencil swaps the heading for an input. */
function ActRename({ actId, name, scriptId }: { actId: string; name: string; scriptId: string }): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  if (!editing) {
    return (
      <button className="icon-btn" title="Rename act" aria-label="Rename act" onClick={() => setEditing(true)}>
        <Icon name="pencil" size={13} />
      </button>
    )
  }
  return (
    <input
      className="input story-move-select"
      autoFocus
      defaultValue={name}
      aria-label="Act name"
      onBlur={(e) => {
        if (e.target.value.trim() && e.target.value.trim() !== name) renameAct(scriptId, actId, e.target.value)
        setEditing(false)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setEditing(false)
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
    />
  )
}
