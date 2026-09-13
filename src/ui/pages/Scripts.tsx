import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../../sync/store'
import { SCRIPT_STATUSES, type Script, type ScriptStatus } from '../../types/schema'
import { compareHlc, decodeHlc } from '../../util/hlc'
import { canWrite } from '../../auth/session'
import { createScript, deleteScript, readScriptBody, saveScriptBody, setScriptStatus, updateScript } from '../../state/actions'
import { webViewLink } from '../../drive/client'
import { Empty, Modal, banner, PageQuote } from '../components'

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

      <PageQuote topic="scripts" />

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

// Unsaved drafts survive switching between scripts within this session.
const bodyDrafts = new Map<string, string>()

function ScriptEditor({ script, onDeleted }: { script: Script; onDeleted: () => void }): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const [body, setBody] = useState(() => bodyDrafts.get(script.id) ?? '')
  const [loaded, setLoaded] = useState(false)
  const [dirty, setDirty] = useState(() => bodyDrafts.has(script.id))
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [statusBusy, setStatusBusy] = useState(false)
  const id = script.id

  // Body loads from its Drive file — unless an unsaved draft exists.
  useEffect(() => {
    let alive = true
    if (bodyDrafts.has(id)) {
      setBody(bodyDrafts.get(id) ?? '')
      setLoaded(true)
      return () => {
        alive = false
      }
    }
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

  const save = () => {
    if (!canWrite() || !dirty || saveState === 'saving') return
    setSaveState('saving')
    setSaveError(null)
    void saveScriptBody(id, body)
      .then((r) => {
        if (r.ok) {
          bodyDrafts.delete(id)
          setDirty(false)
          setSaveState('saved')
        } else {
          setSaveError(r.error)
          setSaveState('error')
        }
      })
      .catch((e: unknown) => {
        setSaveError(e instanceof Error ? e.message : 'Save failed')
        setSaveState('error')
      })
  }

  // Ctrl+S / Cmd+S saves from anywhere in the editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!doc) return <></>

  const writable = canWrite()
  // Scripts link to a PROJECT (one piece of content); picking one also sets
  // the group so the script's group assignment follows automatically.
  const projects = Object.values(doc.projects)
    .filter((p) => p.deleted === null)
    .map((p) => ({ ...p, groupName: doc.groups[p.groupId]?.name ?? '' }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const onBodyChange = (value: string) => {
    setBody(value)
    bodyDrafts.set(id, value)
    setDirty(true)
    if (saveState === 'saved') setSaveState('idle')
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
    updateScript(id, { projectId: pid })
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
          style={{ maxWidth: 260 }}
          value={script.projectId ?? ''}
          disabled={!writable}
          onChange={(e) => setProject(e.target.value)}
        >
          <option value="">No project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}{p.groupName ? ` — ${p.groupName}` : ''}
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
          <div className="spread">
            <label style={{ marginBottom: 0 }}>
              Body{' '}
              {dirty && saveState !== 'saving' ? '· unsaved changes' : saveState === 'saving' ? '· saving…' : saveState === 'saved' ? '· saved ✓' : saveState === 'error' ? '· save failed — press Save again' : ''}
            </label>
            {writable && (
              <button className="btn primary small" disabled={!dirty || saveState === 'saving'} onClick={save}>
                {saveState === 'saving' ? 'Saving…' : 'Save body'}
              </button>
            )}
          </div>
          <textarea
            className="input manuscript"
            rows={14}
            value={loaded ? body : 'Loading…'}
            disabled={!writable || !loaded}
            onChange={(e) => onBodyChange(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') e.preventDefault()
            }}
            placeholder="Write the script…"
          />
          <span className="faint small">
            Press Save (or Ctrl+S) to write this script to its own markdown file in Drive (scripts/) — Drive keeps a version history for it.
          </span>
          {saveState === 'error' && saveError && banner('error', 'Could not save the script', saveError)}
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
                bodyDrafts.delete(id)
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
