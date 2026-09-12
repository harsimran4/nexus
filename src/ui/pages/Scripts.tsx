import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../../sync/store'
import { SCRIPT_STATUSES, type Script, type ScriptStatus } from '../../types/schema'
import { compareHlc, decodeHlc } from '../../util/hlc'
import { canWrite } from '../../auth/session'
import { createScript, deleteScript, readScriptBody, saveScriptBody, setScriptStatus, updateScript } from '../../state/actions'
import { webViewLink } from '../../drive/client'
import { Empty, Modal, banner } from '../components'

// Scripts run on their own draft → review → final ladder (not the item
// pipeline). Badges reuse the bucket palette: muted / amber / green.
const STATUS_BADGE: Record<ScriptStatus, string> = {
  draft: 'badge',
  review: 'badge doing',
  final: 'badge done',
}

const STATUS_LABEL: Record<ScriptStatus, string> = {
  draft: 'Draft',
  review: 'In review',
  final: 'Final',
}

const NARROW_QUERY = '(max-width: 900px)'

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches)
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY)
    const onChange = () => setNarrow(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return narrow
}

/** HLC stamps render as local wall-clock time. */
const fmt = (stamp: string): string => new Date(decodeHlc(stamp).ms).toLocaleString()

export function Scripts(): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const narrow = useNarrow()

  const scripts = useMemo(() => {
    if (!doc) return []
    return Object.values(doc.scripts)
      .filter((s) => s.deleted === null)
      .sort((a, b) => compareHlc(b.updatedAt, a.updatedAt))
  }, [doc])

  if (!doc) return <></>

  const writable = canWrite()
  const active =
    selectedId !== null && doc.scripts[selectedId]?.deleted === null ? doc.scripts[selectedId] : null

  return (
    <div>
      <div className="content-header">
        <div>
          <h1>Scripts</h1>
          <div className="sub">
            {scripts.length} script{scripts.length === 1 ? '' : 's'}
            {writable ? '' : ' · read-only'}
          </div>
        </div>
        <button className="btn primary" disabled={!writable} onClick={() => setCreating(true)}>
          + New script
        </button>
      </div>

      {!writable &&
        banner('info', 'Read-only view', 'Your login can browse scripts but not change them — sign in as an editor or admin.')}

      {scripts.length === 0 ? (
        <Empty icon="✎">
          No scripts yet.{' '}
          {writable
            ? 'Click "+ New script" to draft the first one — it saves to Drive instantly.'
            : 'Editors will add scripts here.'}
        </Empty>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: narrow ? '1fr' : '300px minmax(0, 1fr)',
            gap: 14,
            alignItems: 'start',
          }}
        >
          <div className="card" style={{ padding: 8 }}>
            {scripts.map((s) => (
              <ScriptRow
                key={s.id}
                script={s}
                projectName={s.projectId ? doc.projects[s.projectId]?.name ?? null : null}
                selected={s.id === selectedId}
                onOpen={() => setSelectedId(s.id)}
              />
            ))}
          </div>
          <div>
            {active ? (
              <ScriptEditor key={active.id} script={active} onDeleted={() => setSelectedId(null)} />
            ) : (
              <div className="card" style={{ display: 'grid', placeItems: 'center', minHeight: 220 }}>
                <Empty icon="✎">Select a script on the left to view and edit it.</Empty>
              </div>
            )}
          </div>
        </div>
      )}

      {creating && (
        <NewScriptModal
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false)
            setSelectedId(id)
          }}
        />
      )}
    </div>
  )
}

function ScriptRow({
  script,
  projectName,
  selected,
  onOpen,
}: {
  script: Script
  projectName: string | null
  selected: boolean
  onOpen: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onOpen}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        font: 'inherit',
        color: 'inherit',
        background: selected ? 'var(--accent-dim)' : 'none',
        border: 'none',
        borderRadius: 'var(--radius-sm)',
        padding: '8px 10px',
        cursor: 'pointer',
        marginBottom: 2,
      }}
    >
      <span className="spread">
        <span style={{ fontWeight: 570, fontSize: 13.5, wordBreak: 'break-word' }}>{script.title}</span>
        <span className={STATUS_BADGE[script.status]}>{STATUS_LABEL[script.status]}</span>
      </span>
      <span className="small faint" style={{ display: 'block' }}>
        {projectName ?? 'No project'}
        {script.storage.type === 'drive-doc' ? ' · Drive doc' : ''}
      </span>
    </button>
  )
}

function ScriptEditor({ script, onDeleted }: { script: Script; onDeleted: () => void }): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const [body, setBody] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [statusBusy, setStatusBusy] = useState(false)
  const saveTimer = useRef<number | null>(null)
  const pendingBody = useRef<string | null>(null)
  const id = script.id

  // Body loads from its Drive file (or the inline legacy body).
  useEffect(() => {
    let alive = true
    void readScriptBody(id).then((text) => {
      if (alive) {
        setBody(text ?? '')
        setLoaded(true)
      }
    })
    return () => {
      alive = false
    }
  }, [id])

  const saveBody = (queued: string) => {
    if (!canWrite()) return
    setSaveState('saving')
    void saveScriptBody(id, queued).then((r) => {
      setSaveState(r.ok ? 'saved' : 'error')
    })
  }

  const flushBody = () => {
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const queued = pendingBody.current
    pendingBody.current = null
    if (queued !== null && canWrite()) saveBody(queued)
  }

  const discardBody = () => {
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    pendingBody.current = null
  }

  // Commit a pending edit when switching scripts or leaving the page.
  useEffect(() => {
    return () => flushBody()
  }, [id])

  if (!doc) return <></>

  const writable = canWrite()
  const projects = Object.values(doc.projects)
    .filter((p) => p.deleted === null)
    .sort((a, b) => a.name.localeCompare(b.name))
  // Items of the chosen project — plus the currently linked item so the
  // select never points at a missing option.
  const itemChoices = Object.values(doc.items)
    .filter((i) => i.deleted === null && i.archivedAt === null)
    .filter((i) =>
      i.id === script.itemId ||
      (script.projectId !== null ? i.projectId === script.projectId : i.projectId === null),
    )
    .sort((a, b) => a.title.localeCompare(b.title))

  const onBodyChange = (value: string) => {
    setBody(value) // typing stays local and free
    pendingBody.current = value
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null
      const queued = pendingBody.current
      pendingBody.current = null
      if (queued !== null && canWrite()) saveBody(queued)
    }, 600)
  }

  const changeStatus = (next: ScriptStatus) => {
    void (async () => {
      setStatusBusy(true)
      try {
        await setScriptStatus(id, next)
      } catch {
        /* actions assert the role; read-only UI never reaches here */
      } finally {
        setStatusBusy(false)
      }
    })()
  }

  const setProject = (projectId: string) => {
    const pid: string | null = projectId || null
    const keepItem = script.itemId !== null && doc.items[script.itemId]?.projectId === pid
    updateScript(id, { projectId: pid, itemId: keepItem ? script.itemId : null })
  }

  return (
    <div className="card">
      <input
        className="input"
        style={{ fontSize: 16, fontWeight: 600, marginBottom: 10 }}
        defaultValue={script.title}
        disabled={!writable}
        placeholder="Script title"
        onBlur={(e) => {
          const v = e.target.value.trim()
          if (!v) {
            e.target.value = script.title
            return
          }
          if (v !== script.title) updateScript(id, { title: v })
        }}
      />

      <div className="row wrap mb8">
        <select
          className="input"
          style={{ maxWidth: 160 }}
          value={script.status}
          disabled={!writable || statusBusy}
          onChange={(e) => changeStatus(e.target.value as ScriptStatus)}
        >
          {SCRIPT_STATUSES.map((st) => (
            <option key={st} value={st}>
              {STATUS_LABEL[st]}
            </option>
          ))}
        </select>
        <select
          className="input"
          style={{ maxWidth: 200 }}
          value={script.projectId ?? ''}
          disabled={!writable}
          onChange={(e) => setProject(e.target.value)}
        >
          <option value="">No project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          className="input"
          style={{ maxWidth: 220 }}
          value={script.itemId ?? ''}
          disabled={!writable}
          onChange={(e) => updateScript(id, { itemId: e.target.value || null })}
        >
          <option value="">No item</option>
          {itemChoices.map((i) => (
            <option key={i.id} value={i.id}>
              {i.title}
            </option>
          ))}
        </select>
      </div>

      {script.storage.type === 'drive-doc' ? (
        <div className="field">
          <label>Body — stored as a Drive doc</label>
          <div className="row wrap">
            <a className="btn small" href={webViewLink(script.storage.fileId)} target="_blank" rel="noreferrer">
              Open in Drive
            </a>
            <span className="mono small muted" style={{ wordBreak: 'break-all' }}>
              {script.storage.fileId}
            </span>
          </div>
          <span className="faint small">Edit the text in Drive; Nexus keeps the link.</span>
        </div>
      ) : (
        <div className="field">
          <label>
            Body{' '}
            {saveState === 'saving' ? '· saving…' : saveState === 'saved' ? '· saved ✓' : saveState === 'error' ? '· save failed — retry by editing again' : ''}
          </label>
          <textarea
            className="input"
            rows={14}
            value={loaded ? body : 'Loading…'}
            disabled={!writable || !loaded}
            onChange={(e) => onBodyChange(e.target.value)}
            placeholder="Write the script…"
          />
          <span className="faint small">
            Saved as its own markdown file in Drive (scripts/) about half a second after you stop typing — with its own version history.
          </span>
        </div>
      )}

      <div className="field">
        <label>Milestone copies ({script.copies.length})</label>
        {script.copies.length === 0 && (
          <span className="faint small">
            None yet — a snapshot copy is saved to Drive when the status moves to review or final.
          </span>
        )}
        {script.copies.map((c) => (
          <div
            key={`${c.fileId}-${c.at}`}
            className="row spread small"
            style={{ background: 'var(--bg-raised)', padding: '7px 10px', borderRadius: 8 }}
          >
            <span className="row">
              <span className={`badge ${c.label === 'final' ? 'done' : 'doing'}`}>{c.label}</span>
              <a href={webViewLink(c.fileId)} target="_blank" rel="noreferrer">
                Open copy
              </a>
            </span>
            <span className="faint">{fmt(c.at)}</span>
          </div>
        ))}
      </div>

      <div className="row spread mt16" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
        <span className="small muted">Updated {fmt(script.updatedAt)}</span>
        {writable && (
          <button
            className="btn danger"
            onClick={() => {
              if (confirm(`Delete "${script.title}"? It can be restored from the Archive.`)) {
                discardBody()
                deleteScript(id)
                onDeleted()
              }
            }}
          >
            Delete
          </button>
        )}
      </div>
    </div>
  )
}

function NewScriptModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (id: string) => void
}): React.JSX.Element {
  const [title, setTitle] = useState('')
  const writable = canWrite()

  const create = () => {
    const t = title.trim()
    if (!t || !writable) return
    onCreated(createScript({ title: t }))
  }

  return (
    <Modal title="New script" onClose={onClose}>
      <div className="field">
        <label>Title</label>
        <input
          className="input"
          autoFocus
          placeholder="e.g. Q4 launch voiceover"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && create()}
        />
      </div>
      <p className="muted small">
        Saved as its own markdown file in the scripts/ folder on Drive — snapshot copies are captured at review and final.
      </p>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!title.trim()} onClick={create}>
          Create
        </button>
      </div>
    </Modal>
  )
}
