import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore, storeGet } from '../../sync/store'
import { SCRIPT_STATUSES, type Script, type ScriptStatus } from '../../types/schema'
import { compareHlc, decodeHlc } from '../../util/hlc'
import { canWrite } from '../../auth/session'
import { createScript, deleteScript, readScriptBody, saveScriptBody, setScriptStatus, updateScript } from '../../state/actions'
import { clearScriptDraft, loadScriptDraft, saveScriptDraft } from '../../sync/drafts'
import { renderMarkdown } from '../../util/markdown'
import { downloadToBrowser, describeError } from '../../drive/preview'
import { Empty, Icon, Modal, banner, PageQuote, confirmDialog, confirmIsOpen, toast } from '../components'

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

/** HLC stamps render as local wall-clock time. */
const fmt = (stamp: string): string => new Date(decodeHlc(stamp).ms).toLocaleString()

export function Scripts(): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<ScriptStatus | 'all'>('all')
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const scripts = useMemo(() => {
    if (!doc) return []
    return Object.values(doc.scripts)
      .filter((s) => s.deleted === null)
      .sort((a, b) => compareHlc(b.updatedAt, a.updatedAt))
  }, [doc])

  // The list is searchable and status-filtered; the editor keeps showing the
  // selected script even when filters hide it — filtering is for finding the
  // next one, not for closing the current one.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q && statusFilter === 'all') return scripts
    return scripts.filter((s) => {
      if (statusFilter !== 'all' && s.status !== statusFilter) return false
      if (!q) return true
      const project = s.projectId ? doc?.projects[s.projectId]?.name ?? '' : ''
      return s.title.toLowerCase().includes(q) || project.toLowerCase().includes(q)
    })
  }, [scripts, doc, query, statusFilter])

  const counts = useMemo(() => {
    const c: Record<ScriptStatus | 'all', number> = { all: scripts.length, draft: 0, review: 0, final: 0 }
    for (const s of scripts) c[s.status]++
    return c
  }, [scripts])

  if (!doc) return <></>

  const writable = canWrite()
  const active =
    selectedId !== null && doc.scripts[selectedId]?.deleted === null ? doc.scripts[selectedId] : null
  const isFiltering = query.trim() !== '' || statusFilter !== 'all'

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
          <Icon name="plus" size={14} /> New script
        </button>
      </div>

      <PageQuote topic="scripts" />

      {!writable &&
        banner('info', 'Read-only view', 'Your login can browse scripts but not change them — sign in as an editor or admin.')}

      {scripts.length === 0 ? (
        <Empty icon="✎">
          No scripts yet.{' '}
          {writable
            ? 'Click “+ New script” to draft the first one — it saves to Drive instantly.'
            : 'Editors will add scripts here.'}
        </Empty>
      ) : (
        <div className="script-split">
          <div
            className="card script-list"
            role="group"
            aria-label="Scripts"
            ref={listRef}
            tabIndex={-1}
          >
            <div className="script-tools">
              <div className="script-search">
                <Icon name="search" size={13} />
                <input
                  className="input script-search-input"
                  ref={searchRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search scripts…"
                  aria-label="Search scripts by title or project"
                />
                {query && (
                  <button
                    className="script-search-clear"
                    onClick={() => {
                      setQuery('')
                      searchRef.current?.focus() // the button unmounts — keep focus in the input
                    }}
                    aria-label="Clear search"
                  >
                    <Icon name="x" size={12} />
                  </button>
                )}
              </div>
              <div className="chips" role="group" aria-label="Filter by status">
                <button className={`chip${statusFilter === 'all' ? ' on' : ''}`} aria-pressed={statusFilter === 'all'} onClick={() => setStatusFilter('all')}>
                  All {counts.all}
                </button>
                {SCRIPT_STATUSES.map((st) => (
                  <button key={st} className={`chip${statusFilter === st ? ' on' : ''}`} aria-pressed={statusFilter === st} onClick={() => setStatusFilter(st)}>
                    {STATUS_LABEL[st]} {counts[st]}
                  </button>
                ))}
              </div>
            </div>
            {filtered.length === 0 ? (
              <div className="script-none">
                <span>No scripts match.</span>
                <button
                  className="btn ghost small"
                  onClick={() => {
                    setQuery('')
                    setStatusFilter('all')
                    searchRef.current?.focus() // this row unmounts — focus lands back in search
                  }}
                >
                  Clear filters
                </button>
              </div>
            ) : (
              filtered.map((s) => (
                <ScriptRow
                  key={s.id}
                  script={s}
                  projectName={s.projectId ? doc.projects[s.projectId]?.name ?? null : null}
                  selected={s.id === selectedId}
                  onOpen={() => setSelectedId(s.id)}
                />
              ))
            )}
            {/* Live region for the whole filtering period — mounted at 0
                results too, so "0 of N shown" actually gets announced (a
                region that unmounts at zero announces nothing). */}
            {isFiltering && (
              <div className="script-count" aria-live="polite">
                {filtered.length} of {scripts.length} shown
              </div>
            )}
          </div>
          <div>
            {active ? (
              <ScriptEditor
                key={active.id}
                script={active}
                onDeleted={() => {
                  setSelectedId(null)
                  // keyboard lands back in the list — unless this was the
                  // last script, in which case the list is gone and focus
                  // falls to <body>
                  listRef.current?.focus()
                }}
              />
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
    <button className={`script-slip${selected ? ' on' : ''}`} aria-current={selected ? 'true' : undefined} onClick={onOpen}>
      <span className="spread">
        <span className="script-slip-title">{script.title}</span>
        <span className={STATUS_BADGE[script.status]}>{STATUS_LABEL[script.status]}</span>
      </span>
      <span className="script-slip-sub small faint">
        {projectName ?? 'No project'}
        {script.storage.type === 'drive-doc' ? ' · Drive doc' : ''}
      </span>
    </button>
  )
}

// Unsaved drafts survive switching between scripts within this session
// (in-memory map, instant) AND tab closes (IndexedDB mirror, written debounced).
const bodyDrafts = new Map<string, string>()

// One download-failure toast at a time — a retry replaces the old receipt
// instead of stacking five sticky errors.
let downloadErrToast: number | null = null

function ScriptEditor({ script, onDeleted }: { script: Script; onDeleted: () => void }): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const [body, setBody] = useState(() => bodyDrafts.get(script.id) ?? '')
  const [loaded, setLoaded] = useState(false)
  const [dirty, setDirty] = useState(() => bodyDrafts.has(script.id))
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [statusBusy, setStatusBusy] = useState(false)
  const [preview, setPreview] = useState(false)
  const draftSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const id = script.id

  // Body loads from its Drive file — unless an unsaved draft exists (in-memory
  // first, then the IndexedDB mirror from a previous session).
  useEffect(() => {
    let alive = true
    const mem = bodyDrafts.get(id)
    if (mem !== undefined) {
      setBody(mem)
      setLoaded(true)
      return () => {
        alive = false
      }
    }
    void (async () => {
      const stored = await loadScriptDraft(id)
      if (!alive) return
      if (stored !== null) {
        setBody(stored)
        setDirty(true)
        setLoaded(true)
        return
      }
      const text = await readScriptBody(id)
      if (alive) {
        setBody(text ?? '')
        setLoaded(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [id])

  /** Persists the body when dirty. Resolves false when the save failed (the
   *  error is already on screen) — callers must not continue past a failure. */
  const save = async (): Promise<boolean> => {
    if (saveState === 'saving') return false
    if (!dirty) return true // nothing unsaved — the Drive copy is current
    if (!canWrite()) return false
    setSaveState('saving')
    setSaveError(null)
    try {
      const r = await saveScriptBody(id, body)
      if (r.ok) {
        bodyDrafts.delete(id)
        void clearScriptDraft(id)
        setDirty(false)
        setSaveState('saved')
        return true
      }
      setSaveError(r.error)
      setSaveState('error')
      return false
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : 'Save failed')
      setSaveState('error')
      return false
    }
  }

  // Ctrl+S / Cmd+S saves from anywhere in the editor — but stands down while
  // a confirm dialog is up (same convention as Modal / MediaTab's Escape).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (confirmIsOpen()) return
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
    if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current)
    draftSaveTimer.current = setTimeout(() => void saveScriptDraft(id, value), 500)
  }

  const changeStatus = (next: ScriptStatus) => {
    void (async () => {
      setStatusBusy(true)
      try {
        // Milestone copies (review/final) snapshot the Drive body — unsaved
        // in-editor edits must be written first or the copy loses them.
        const saved = await save()
        if (!saved) return
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

  const removeScript = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: `Delete “${script.title}”?`,
      body: (
        <div className="confirm-body">
          <div className="confirm-what">It moves to the Archive.</div>
          You can restore it from there — nothing is erased.
        </div>
      ),
      confirmLabel: 'Delete script',
      tone: 'danger',
    })
    if (!ok) return
    // The dialog can sit open while another device deletes the script — the
    // editor unmounts behind the modal but this async flow keeps running.
    // Don't re-tombstone someone else's delete or claim it as our own.
    if (storeGet().doc?.scripts[id]?.deleted !== null) {
      bodyDrafts.delete(id) // a restored copy must not resurface with a stale dirty draft
      void clearScriptDraft(id)
      onDeleted()
      return
    }
    bodyDrafts.delete(id)
    deleteScript(id)
    toast.success(`“${script.title}” moved to the Archive`)
    onDeleted()
  }

  return (
    <div className="card">
      <input
        className="input script-title"
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
          className="input script-status"
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
          className="input script-project"
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
            <div className="row" style={{ gap: 6 }}>
              <button className={`chip ${preview ? '' : 'on'}`} aria-pressed={!preview} onClick={() => setPreview(false)} title="Edit the markdown">
                Edit
              </button>
              <button className={`chip ${preview ? 'on' : ''}`} aria-pressed={preview} onClick={() => setPreview(true)} title="Rendered preview">
                Preview
              </button>
              {writable && (
                <button className="btn primary small" disabled={!dirty || saveState === 'saving'} onClick={() => void save()}>
                  {saveState === 'saving' ? 'Saving…' : 'Save body'}
                </button>
              )}
            </div>
          </div>
          {preview ? (
            <div
              className="input manuscript md-preview"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }}
            />
          ) : (
            <textarea
              className="input manuscript"
              rows={14}
              value={loaded ? body : ''}
              placeholder={loaded ? 'Write the script…' : 'Loading…'}
              disabled={!writable || !loaded}
              onChange={(e) => onBodyChange(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') e.preventDefault()
              }}
            />
          )}
          <span className="faint small">
            Press Save (or Ctrl+S) to write your text to the script's markdown file — milestone copies at Review/Final give you restore points.
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
          <div key={`${c.fileId}-${c.at}`} className="script-copy small">
            <span className="row">
              <span className={`badge ${c.label === 'final' ? 'done' : 'doing'}`}>{c.label}</span>
              <button
                className="btn ghost small"
                onClick={() =>
                  void downloadToBrowser(c.fileId, `${script.title || 'script'}-${c.label}.md`).catch((e) => {
                    if (downloadErrToast !== null) toast.dismiss(downloadErrToast)
                    const d = describeError(e)
                    downloadErrToast = toast.error(d.message, d.fix)
                  })
                }
              >
                Download copy
              </button>
            </span>
            <span className="faint">{fmt(c.at)}</span>
          </div>
        ))}
      </div>

      <div className="row spread mt16 script-foot">
        <span className="small muted">Updated {fmt(script.updatedAt)}</span>
        {writable && (
          <button className="btn danger" onClick={() => void removeScript()}>
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
