// The script workspace at /scripts/$scriptId — one connected creative system:
// Brief / Story / Shots / Graph / Manuscript. The header owns script-level
// fields (title, status ladder, project link, delete); the tabs own the
// structure. Tab + focus state ride the URL (scriptView.ts).

import { lazy, Suspense, useState } from 'react'
import { useStore, storeGet } from '../../../sync/store'
import { SCRIPT_STATUSES, type ScriptStatus } from '../../../types/schema'
import { decodeHlc } from '../../../util/hlc'
import { useCanWrite } from '../../../auth/session'
import { deleteScript, setScriptStatus, updateScript } from '../../../state/actions'
import { navigate } from '../../../nav'
import { Empty, Icon, confirmDialog, toast } from '../../components'
import { Skeleton } from '../../components'
import { useScriptView } from './scriptView'
import { BriefTab } from './BriefTab'
import { StoryTab } from './StoryTab'
import { ShotsTab } from './ShotsTab'
import { ManuscriptTab, saveScriptBodyDraft } from './ManuscriptTab'

// The graph (React Flow) never enters the shell chunk — it's the heaviest
// surface and only mounts when the tab opens.
const GraphTab = lazy(() => import('./GraphTab'))

const WORKSPACE_TABS: { id: 'brief' | 'story' | 'shots' | 'graph' | 'manuscript'; label: string }[] = [
  { id: 'brief', label: 'Brief' },
  { id: 'story', label: 'Story' },
  { id: 'shots', label: 'Shots' },
  { id: 'graph', label: 'Graph' },
  { id: 'manuscript', label: 'Manuscript' },
]

const STATUS_LABEL: Record<ScriptStatus, string> = {
  draft: 'Draft',
  review: 'In review',
  final: 'Final',
}

export function ScriptWorkspace({ scriptId }: { scriptId: string }): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const { view, setView, setTab } = useScriptView()
  const writable = useCanWrite()
  const [statusBusy, setStatusBusy] = useState(false)

  if (!doc) return <></>

  const script = doc.scripts[scriptId]
  if (!script || script.deleted !== null) {
    return (
      <div>
        <div className="content-header">
          <div>
            <h1>Script</h1>
            <div className="sub">Not found</div>
          </div>
        </div>
        <Empty icon="✎">
          This script doesn't exist or has been deleted. <a href="/scripts">Back to Scripts</a>
        </Empty>
      </div>
    )
  }

  const projects = Object.values(doc.projects)
    .filter((p) => p.deleted === null)
    .map((p) => ({ ...p, groupName: doc.groups[p.groupId]?.name ?? '' }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const changeStatus = (next: ScriptStatus): void => {
    void (async () => {
      setStatusBusy(true)
      try {
        // Milestone copies (review/final) snapshot the Drive body — flush the
        // manuscript's unsaved edits FIRST or the copy loses them.
        const saved = await saveScriptBodyDraft(scriptId)
        if (!saved) return
        await setScriptStatus(scriptId, next)
      } finally {
        setStatusBusy(false)
      }
    })()
  }

  const removeScript = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: `Delete “${script.title}”?`,
      body: (
        <div className="confirm-body">
          <div className="confirm-what">It moves to the Archive, along with its beats, scenes and shots.</div>
          You can restore the script from there — nothing is erased.
        </div>
      ),
      confirmLabel: 'Delete script',
      tone: 'danger',
    })
    if (!ok) return
    // The dialog can sit open while another device deletes the script —
    // don't re-tombstone someone else's delete or claim it as our own.
    if (storeGet().doc?.scripts[scriptId]?.deleted !== null) {
      navigate('/scripts')
      return
    }
    deleteScript(scriptId)
    toast.success(`“${script.title}” moved to the Archive`)
    navigate('/scripts')
  }

  return (
    <div>
      <div className="content-header script-head">
        <div className="script-head-main">
          <a
            className="faint small script-back"
            href="/scripts"
            onClick={(e) => {
              e.preventDefault()
              navigate('/scripts')
            }}
          >
            <Icon name="arrow-left" size={13} /> All scripts
          </a>
          <input
            className="input script-title"
            defaultValue={script.title}
            disabled={!writable}
            placeholder="Script title"
            aria-label="Script title"
            onBlur={(e) => {
              const v = e.target.value.trim()
              if (!v) {
                e.target.value = script.title
                return
              }
              if (v !== script.title) updateScript(scriptId, { title: v })
            }}
          />
          <div className="row wrap script-head-controls">
            <select
              className="input script-status"
              value={script.status}
              disabled={!writable || statusBusy}
              aria-label="Script status"
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
              aria-label="Linked project"
              onChange={(e) => updateScript(scriptId, { projectId: e.target.value || null })}
            >
              <option value="">No project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.groupName ? ` — ${p.groupName}` : ''}
                </option>
              ))}
            </select>
            <span className="faint small">Updated {new Date(decodeHlc(script.updatedAt).ms).toLocaleString()}</span>
            {writable && (
              <button className="btn danger small script-delete" onClick={() => void removeScript()}>
                Delete
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="chips script-tabs" role="tablist" aria-label="Workspace sections">
        {WORKSPACE_TABS.map((t) => (
          <button key={t.id} className={`chip${view.tab === t.id ? ' on' : ''}`} role="tab" aria-selected={view.tab === t.id} aria-pressed={view.tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {view.tab === 'brief' && <BriefTab script={script} />}
      {view.tab === 'story' && <StoryTab script={script} focusId={view.select} setFocus={(id) => setView({ select: id })} />}
      {view.tab === 'shots' && <ShotsTab script={script} focusId={view.select} setFocus={(id) => setView({ select: id })} />}
      {view.tab === 'graph' && (
        <Suspense fallback={<Skeleton className="sgraph-skel" />}>
          <GraphTab script={script} focusId={view.select} setFocus={(id) => setView({ select: id })} />
        </Suspense>
      )}
      {view.tab === 'manuscript' && <ManuscriptTab key={script.id} script={script} />}
    </div>
  )
}
