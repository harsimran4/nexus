// The Scripts library — one slip per script; click through to the script's
// workspace at /scripts/$scriptId (Brief / Story / Shots / Graph / Manuscript
// live there). Filters ride the URL (validateSearch → util/scriptUrl.ts).

import { useMemo, useRef, useState } from 'react'
import { getRouteApi } from '@tanstack/react-router'
import { useStore } from '../../sync/store'
import { SCRIPT_STATUSES, type NexusDoc, type Script, type ScriptStatus } from '../../types/schema'
import { compareHlc } from '../../util/hlc'
import { useCanWrite } from '../../auth/session'
import { createScript } from '../../state/actions'
import { parseScriptList, serializeScriptList } from '../../util/scriptUrl'
import { navigate } from '../../nav'
import { Empty, Icon, Modal, banner, PageQuote, useDebouncedCommit } from '../components'

const routeApi = getRouteApi('/scripts/')

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

export function Scripts(): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const search = routeApi.useSearch()
  const routeNavigate = routeApi.useNavigate()
  const [creating, setCreating] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const writable = useCanWrite()

  const query = search.q ?? ''
  const statusFilter: ScriptStatus | 'all' = search.status ?? 'all'

  const scripts = useMemo(() => {
    if (!doc) return []
    return Object.values(doc.scripts)
      .filter((s) => s.deleted === null)
      .sort((a, b) => compareHlc(b.updatedAt, a.updatedAt))
  }, [doc])

  // One pass over the story maps — cheap per-slip counts ("3 beats · 2 scenes
  // · 5 shots") that make the library read like a slate, not a file list.
  const storyCounts = useMemo(() => {
    const m = new Map<string, { beats: number; scenes: number; shots: number }>()
    if (!doc) return m
    const inc = (scriptId: string, k: 'beats' | 'scenes' | 'shots'): void => {
      const c = m.get(scriptId) ?? { beats: 0, scenes: 0, shots: 0 }
      c[k]++
      m.set(scriptId, c)
    }
    for (const b of Object.values(doc.beats)) if (b.deleted === null) inc(b.scriptId, 'beats')
    for (const s of Object.values(doc.scenes)) if (s.deleted === null) inc(s.scriptId, 'scenes')
    for (const s of Object.values(doc.shots)) if (s.deleted === null) inc(s.scriptId, 'shots')
    return m
  }, [doc])

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

  /** Filter writes replace:true — they're view twiddles, not places. */
  const setFilter = (patch: { q?: string; status?: ScriptStatus }): void => {
    void routeNavigate({
      search: (prev: Record<string, unknown>) => serializeScriptList({ ...parseScriptList(prev), ...patch }),
      replace: true,
    })
  }
  // Debounced so typing in the search box doesn't navigate per keystroke.
  const debouncedFilter = useDebouncedCommit(400)

  if (!doc) return <></>

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
            ? 'Click “+ New script” to draft the first one — then plan its brief, story and shots in the workspace.'
            : 'Editors will add scripts here.'}
        </Empty>
      ) : (
        <div className="card script-list">
          <div className="script-tools">
            <div className="script-search">
              <Icon name="search" size={13} />
              <input
                className="input script-search-input"
                ref={searchRef}
                value={query}
                onChange={(e) => {
                  const v = e.target.value
                  debouncedFilter(() => setFilter({ q: v.trim() ? v : undefined }))
                }}
                placeholder="Search scripts…"
                aria-label="Search scripts by title or project"
              />
              {query && (
                <button
                  className="script-search-clear"
                  onClick={() => {
                    setFilter({ q: undefined })
                    searchRef.current?.focus() // the button unmounts — keep focus in the input
                  }}
                  aria-label="Clear search"
                >
                  <Icon name="x" size={12} />
                </button>
              )}
            </div>
            <div className="chips" role="group" aria-label="Filter by status">
              <button className={`chip${statusFilter === 'all' ? ' on' : ''}`} aria-pressed={statusFilter === 'all'} onClick={() => setFilter({ status: undefined })}>
                All {counts.all}
              </button>
              {SCRIPT_STATUSES.map((st) => (
                <button key={st} className={`chip${statusFilter === st ? ' on' : ''}`} aria-pressed={statusFilter === st} onClick={() => setFilter({ status: st })}>
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
                  setFilter({ q: undefined, status: undefined })
                  searchRef.current?.focus() // this row unmounts — focus lands back in search
                }}
              >
                Clear filters
              </button>
            </div>
          ) : (
            filtered.map((s) => <ScriptRow key={s.id} script={s} doc={doc} counts={storyCounts.get(s.id)} onOpen={() => navigate(`/scripts/${s.id}`)} />)
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
      )}

      {creating && (
        <NewScriptModal
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false)
            navigate(`/scripts/${id}`)
          }}
        />
      )}
    </div>
  )
}

function ScriptRow({
  script,
  doc,
  counts,
  onOpen,
}: {
  script: Script
  doc: NexusDoc
  counts?: { beats: number; scenes: number; shots: number }
  onOpen: () => void
}): React.JSX.Element {
  const projectName = script.projectId ? doc.projects[script.projectId]?.name ?? null : null
  const story = counts
    ? [
        counts.beats ? `${counts.beats} beat${counts.beats === 1 ? '' : 's'}` : '',
        counts.scenes ? `${counts.scenes} scene${counts.scenes === 1 ? '' : 's'}` : '',
        counts.shots ? `${counts.shots} shot${counts.shots === 1 ? '' : 's'}` : '',
      ].filter(Boolean)
    : []
  return (
    <button className="script-slip" onClick={onOpen}>
      <span className="spread">
        <span className="script-slip-title">{script.title}</span>
        <span className={STATUS_BADGE[script.status]}>{STATUS_LABEL[script.status]}</span>
      </span>
      <span className="script-slip-sub small faint">
        {projectName ?? 'No project'}
        {script.storage.type === 'drive-doc' ? ' · Drive doc' : ''}
        {story.length ? ` · ${story.join(' · ')}` : ''}
      </span>
    </button>
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
  const writable = useCanWrite()

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
        One workspace for the whole film: a creative brief, story beats and scenes, shots — and the manuscript itself. The text saves as its own markdown file; snapshot copies are captured at review and final.
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
