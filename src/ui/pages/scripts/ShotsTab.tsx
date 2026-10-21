// The Visual Planner — shots grouped by their scene or their beat. Each shot
// carries the craft fields (size, move, composition, lighting, sound,
// duration), a storyboard frame from the linked project's media, and its own
// inspiration links. The editor is a Modal (no footer prop — the button row
// is ours).

import { useMemo, useRef, useState } from 'react'
import { useStore } from '../../../sync/store'
import type { Script, Shot } from '../../../types/schema'
import { useCanWrite } from '../../../auth/session'
import { addShot, attachShotStoryboard, deleteShot, detachShotStoryboard, uploadToProject } from '../../../state/actions'
import { Empty, Icon, Modal, confirmDialog, toast } from '../../components'
import { MediaThumb } from '../../MediaThumb'
import { LinkRows, ShotFields } from './fields'
import { navigate } from '../../../nav'

export function ShotsTab({
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
  const [groupBy, setGroupBy] = useState<'scene' | 'beat'>('scene')
  const [editingId, setEditingId] = useState<string | null>(focusId ?? null)

  const story = useMemo(() => {
    if (!doc) return null
    const beats = Object.values(doc.beats).filter((b) => b.scriptId === script.id && !b.deleted)
    const scenes = Object.values(doc.scenes).filter((x) => x.scriptId === script.id && !x.deleted)
    const shots = Object.values(doc.shots).filter((x) => x.scriptId === script.id && !x.deleted)
    const shotSort = (a: Shot, b: Shot): number => a.sort - b.sort || (a.id < b.id ? -1 : 1)
    const byScene = new Map<string, Shot[]>()
    const byBeat = new Map<string, Shot[]>()
    for (const s of shots) {
      if (s.sceneId) {
        const list = byScene.get(s.sceneId) ?? []
        list.push(s)
        byScene.set(s.sceneId, list)
      }
      if (s.beatId) {
        const list = byBeat.get(s.beatId) ?? []
        list.push(s)
        byBeat.set(s.beatId, list)
      }
    }
    for (const list of byScene.values()) list.sort(shotSort)
    for (const list of byBeat.values()) list.sort(shotSort)
    const sceneById = new Map(scenes.map((s) => [s.id, s]))
    const beatById = new Map(beats.map((b) => [b.id, b]))
    return { beats, scenes, shots, byScene, byBeat, sceneById, beatById }
  }, [doc, script.id])

  if (!doc || !story) return <></>

  if (story.shots.length === 0 && !writable) {
    return <Empty icon="▤">No shots yet — editors plan the camera here.</Empty>
  }

  return (
    <div className="shots-wrap">
      <div className="spread mb8">
        <div className="chips" role="group" aria-label="Group shots by">
          <button className={`chip${groupBy === 'scene' ? ' on' : ''}`} aria-pressed={groupBy === 'scene'} onClick={() => setGroupBy('scene')}>
            By scene
          </button>
          <button className={`chip${groupBy === 'beat' ? ' on' : ''}`} aria-pressed={groupBy === 'beat'} onClick={() => setGroupBy('beat')}>
            By beat
          </button>
        </div>
        {writable && (
          <span className="row">
            <AddShotMenu script={script} story={story} onCreated={(id) => setEditingId(id)} />
          </span>
        )}
      </div>

      {story.shots.length === 0 && (
        <Empty icon="▤">No shots yet — a shot is one camera setup: what we see, how it moves, what it sounds like.</Empty>
      )}

      {groupBy === 'scene'
        ? story.scenes.map((sc) => {
            const list = story.byScene.get(sc.id) ?? []
            const beat = story.beatById.get(sc.beatId)
            return (
              <section key={sc.id} className="card shots-group">
                <div className="spread story-act-head">
                  <h3 style={{ margin: 0 }}>{sc.title || 'Untitled scene'}</h3>
                  <span className="faint small">
                    in {beat?.title || 'Untitled beat'}
                    {sc.location ? ` · ${sc.location}` : ''}
                  </span>
                </div>
                {list.length === 0 ? (
                  <span className="faint small">No shots on this scene yet.</span>
                ) : (
                  <div className="story-shot-grid">
                    {list.map((shot) => (
                      <ShotCard key={shot.id} shot={shot} onOpen={() => setEditingId(shot.id)} selected={editingId === shot.id} />
                    ))}
                  </div>
                )}
              </section>
            )
          })
        : story.beats.map((b) => {
            const list = story.byBeat.get(b.id) ?? []
            return (
              <section key={b.id} className="card shots-group">
                <div className="spread story-act-head">
                  <h3 style={{ margin: 0 }}>{b.title || 'Untitled beat'}</h3>
                  <span className="faint small">{list.length} shot{list.length === 1 ? '' : 's'} directly on this beat</span>
                </div>
                {list.length === 0 ? (
                  <span className="faint small">No beat-level shots yet — shots can hang straight off a beat before scenes exist.</span>
                ) : (
                  <div className="story-shot-grid">
                    {list.map((shot) => (
                      <ShotCard key={shot.id} shot={shot} onOpen={() => setEditingId(shot.id)} selected={editingId === shot.id} />
                    ))}
                  </div>
                )}
              </section>
            )
          })}

      {editingId && story.shots.some((s) => s.id === editingId) && (
        <ShotEditorModal
          shotId={editingId}
          script={script}
          onClose={() => {
            setEditingId(null)
            if (focusId === editingId) setFocus(undefined)
          }}
        />
      )}
    </div>
  )
}

function ShotCard({ shot, onOpen, selected }: { shot: Shot; onOpen: () => void; selected: boolean }): React.JSX.Element {
  const chips = [shot.shotSize, shot.cameraMove, shot.durationSec !== undefined ? `${shot.durationSec}s` : ''].filter(Boolean)
  return (
    <button className={`story-shot${selected ? ' on' : ''}`} onClick={onOpen}>
      {shot.storyboardFileKey ? (
        <MediaThumb fileKey={shot.storyboardFileKey} alt="" style={{ width: '100%', height: 92, objectFit: 'cover', borderRadius: 'var(--radius-sm)', background: 'var(--panel-2)' }} />
      ) : (
        <span className="story-shot-placeholder" aria-hidden="true">
          ▤
        </span>
      )}
      <span className="story-shot-caption">{shot.caption || 'Untitled shot'}</span>
      {chips.length > 0 && (
        <span className="row wrap" style={{ gap: 4 }}>
          {chips.map((c) => (
            <span key={c} className="badge label">
              {c}
            </span>
          ))}
        </span>
      )}
    </button>
  )
}

function AddShotMenu({
  script,
  story,
  onCreated,
}: {
  script: Script
  story: { scenes: { id: string; title: string; beatId: string }[]; beats: { id: string; title: string }[] }
  onCreated: (id: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  if (!open) {
    return (
      <button className="btn primary small" onClick={() => setOpen(true)}>
        <Icon name="plus" size={13} /> New shot
      </button>
    )
  }
  return (
    <select
      className="input"
      autoFocus
      value=""
      aria-label="Choose where the shot goes"
      onBlur={() => setOpen(false)}
      onChange={(e) => {
        const v = e.target.value
        setOpen(false)
        if (!v) return
        if (v.startsWith('scene:')) {
          const id = addShot(script.id, { sceneId: v.slice(6) })
          if (id) onCreated(id)
        } else if (v.startsWith('beat:')) {
          const id = addShot(script.id, { beatId: v.slice(5) })
          if (id) onCreated(id)
        }
      }}
    >
      <option value="">Add a shot to…</option>
      {story.scenes.map((s) => (
        <option key={s.id} value={`scene:${s.id}`}>
          Scene — {s.title || 'Untitled'}
        </option>
      ))}
      {story.beats.map((b) => (
        <option key={b.id} value={`beat:${b.id}`}>
          Beat — {b.title || 'Untitled'} (no scene)
        </option>
      ))}
    </select>
  )
}

function ShotEditorModal({ shotId, script, onClose }: { shotId: string; script: Script; onClose: () => void }): React.JSX.Element | null {
  const doc = useStore((s) => s.doc)
  const writable = useCanWrite()
  const fileInput = useRef<HTMLInputElement>(null)
  const [uploadPct, setUploadPct] = useState<number | null>(null)
  const shot = doc?.shots[shotId]
  if (!doc || !shot || shot.deleted) return null

  const project = script.projectId ? doc.projects[script.projectId] : null
  const links = (doc.storyLinks ?? []).filter((l) => !l.deleted && (l.toId === shotId || l.fromId === shotId))

  const uploadStoryboard = async (file: File): Promise<void> => {
    if (!script.projectId || !project) {
      toast.error('Link this script to a project first', 'Storyboards are frames from the project’s media — pick one in the header.')
      return
    }
    setUploadPct(0)
    const r = await uploadToProject(script.projectId, file, (pct) => setUploadPct(pct))
    setUploadPct(null)
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    const a = attachShotStoryboard(shotId, r.fileId)
    if (a.ok) toast.success('Storyboard frame attached')
    else toast.error(a.error)
  }

  const removeShot = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: `Delete “${shot.caption || 'this shot'}”?`,
      body: (
        <div className="confirm-body">
          <div className="confirm-what">The storyboard link and its inspiration links go with it.</div>
          This removes it for every editor.
        </div>
      ),
      confirmLabel: 'Delete shot',
      tone: 'danger',
    })
    if (!ok) return
    deleteShot(shotId)
    toast.success('Shot deleted')
    onClose()
  }

  return (
    <Modal title={shot.caption || 'Edit shot'} onClose={onClose} wide>
      {shot.storyboardFileKey ? (
        <div className="story-storyboard">
          <MediaThumb fileKey={shot.storyboardFileKey} alt="Storyboard frame" style={{ maxWidth: '100%', maxHeight: 220, borderRadius: 'var(--radius-sm)', background: 'var(--panel-2)' }} />
          {writable && (
            <button
              className="btn ghost small"
              onClick={() => {
                detachShotStoryboard(shotId)
                toast.success('Storyboard frame detached')
              }}
            >
              Detach frame
            </button>
          )}
        </div>
      ) : (
        writable && (
          <div className="field">
            <label>Storyboard frame</label>
            <div className="row">
              <button className="btn small" disabled={!script.projectId || uploadPct !== null} onClick={() => fileInput.current?.click()}>
                <Icon name="image" size={13} /> {uploadPct !== null ? `Uploading… ${uploadPct}%` : 'Upload a frame'}
              </button>
              {!script.projectId && <span className="faint small">needs a linked project</span>}
            </div>
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) void uploadStoryboard(f)
              }}
            />
          </div>
        )
      )}

      <ShotFields shot={shot} disabled={!writable} />

      <div className="field">
        <label>Inspiration & references</label>
        <LinkRows doc={doc} links={links} emptyText="No links yet — attach them from the Brief's reference list or (soon) straight on the graph." disabled={!writable} />
        {!project && <span className="faint small">References are saved on the linked project — <a href="/groups" onClick={(e) => { e.preventDefault(); navigate('/groups') }}>pick one for this script</a> to unlock them.</span>}
      </div>

      <div className="row spread mt16">
        {writable ? (
          <button className="btn danger small" onClick={() => void removeShot()}>
            <Icon name="trash" size={13} /> Delete shot
          </button>
        ) : (
          <span />
        )}
        <button className="btn primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  )
}
