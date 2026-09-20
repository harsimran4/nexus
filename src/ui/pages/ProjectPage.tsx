import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../sync/store'
import { Empty, StatusBadge, banner, useDebouncedCommit, PageQuote } from '../components'
import { canWrite } from '../../auth/session'
import {
  readScriptBody,
  removeProjectFile,
  setProjectStatus,
  updateProject,
  updateScript,
  uploadToProject,
} from '../../state/actions'
import { describeError, downloadToBrowser } from '../../drive/preview'
import { getMeta, renameFile, thumbnailUrl, webViewLink } from '../../drive/client'
import { navigate } from '../../App'
import { touch } from '../../sync/writer'

type Tab = 'media' | 'scripts' | 'settings'

const TABS: { id: Tab; label: string }[] = [
  { id: 'media', label: 'Media' },
  { id: 'scripts', label: 'Scripts' },
  { id: 'settings', label: 'Settings' },
]

interface FileInfo {
  name: string
  mimeType?: string
}

export function ProjectPage({ projectId }: { projectId: string }): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const [tab, setTab] = useState<Tab>('media')
  const project = doc?.projects[projectId]

  if (!doc || !project || project.deleted !== null) {
    return (
      <Empty icon="▦">
        This project doesn't exist or was deleted. <a href="#/dash">Back to board</a>
      </Empty>
    )
  }

  const group = doc.groups[project.groupId]

  return (
    <div>
      <div className="content-header">
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 8 }}>
            <a href="#/dash" className="faint small">← board</a>
            {group && <a href={`#/group/${group.id}`} className="faint small">{group.name} /</a>}
          </div>
          <NameEditor projectId={projectId} name={project.name} />
          <div className="row wrap" style={{ marginTop: 6 }}>
            <select
              className="input"
              style={{ maxWidth: 170, padding: '4px 9px', fontSize: 13 }}
              value={project.status}
              disabled={!canWrite()}
              onChange={(e) => setProjectStatus(projectId, e.target.value)}
            >
              {doc.settings.pipeline.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <StatusBadge doc={doc} status={project.status} />
          </div>
        </div>
        <div className="row">
          {TABS.map((t) => (
            <button key={t.id} className={`chip ${tab === t.id ? 'on' : ''}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <PageQuote topic="project" />

      {tab === 'media' && <MediaTab projectId={projectId} />}
      {tab === 'scripts' && <ScriptsTab projectId={projectId} />}
      {tab === 'settings' && <SettingsTab projectId={projectId} />}
    </div>
  )
}

/** Inline-editable project name — renames the Drive subfolder to match. The
 *  name sits in a manila folder tab: a project IS a folder on Drive. */
function NameEditor({ projectId, name }: { projectId: string; name: string }): React.JSX.Element {
  const writable = canWrite()
  return (
    <div className="project-tab">
      <input
        className="input"
        style={{ fontSize: 20, fontWeight: 650, background: 'none', border: 'none', padding: '2px 0', maxWidth: 620 }}
        defaultValue={name}
        disabled={!writable}
        onBlur={(e) => {
          const v = e.target.value.trim()
          if (!v || v === name) {
            e.target.value = name
            return
          }
          updateProject(projectId, { name: v })
          void (async () => {
            const { storeGet } = await import('../../sync/store')
            const folderId = storeGet().doc?.projects[projectId]?.folderId
            if (folderId) await renameFile(folderId, v, { mode: 'bearer' }).catch(() => {})
          })()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Media tab
// ---------------------------------------------------------------------------

function MediaTab({ projectId }: { projectId: string }): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const [uploadPct, setUploadPct] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [meta, setMeta] = useState<Record<string, FileInfo>>({})
  const fileInput = useRef<HTMLInputElement>(null)
  const writable = canWrite()

  const project = doc?.projects[projectId]
  if (!doc || !project) return <></>

  const fileKey = project.fileIds.join(',')

  useEffect(() => {
    let alive = true
    for (const f of project.fileIds) {
      if (meta[f]) continue
      void getMeta(f, { mode: 'auto' })
        .then((m) => {
          if (alive) setMeta((prev) => ({ ...prev, [f]: { name: m.name, mimeType: m.mimeType } }))
        })
        .catch(() => {
          if (alive) setMeta((prev) => ({ ...prev, [f]: { name: f } }))
        })
    }
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKey])

  const startUpload = async (file: File) => {
    setError(null)
    setUploadPct(0)
    const r = await uploadToProject(projectId, file, setUploadPct)
    setUploadPct(null)
    if (!r.ok) setError(r.error)
  }

  const doRename = async (fileId: string) => {
    const v = renameValue.trim()
    setRenamingId(null)
    if (!v) return
    try {
      await renameFile(fileId, v, { mode: 'bearer' })
      setMeta((prev) => ({ ...prev, [fileId]: { name: v, mimeType: prev[fileId]?.mimeType } }))
    } catch (e) {
      setError(describeError(e).message)
    }
  }

  return (
    <div>
      {error && banner('error', 'Media problem', error)}

      {project.fileIds.length === 0 ? (
        <Empty icon="🖼">No media yet — upload below.</Empty>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 14 }}>
          {project.fileIds.map((f) => {
            const info = meta[f]
            const displayName = renamingId === f ? renameValue : info?.name ?? f
            return (
              <div key={f} className="photo-frame">
                <div
                  style={{
                    aspectRatio: '16/9',
                    background: 'var(--bg)',
                    borderRadius: 8,
                    overflow: 'hidden',
                    display: 'grid',
                    placeItems: 'center',
                    marginBottom: 8,
                  }}
                >
                  <img
                    src={thumbnailUrl(f, 400)}
                    alt={displayName}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
                  />
                </div>
                {renamingId === f ? (
                  <input
                    className="input"
                    value={renameValue}
                    autoFocus
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void doRename(f)
                      if (e.key === 'Escape') setRenamingId(null)
                    }}
                    onBlur={() => void doRename(f)}
                  />
                ) : (
                  <div className="small" style={{ fontWeight: 570, wordBreak: 'break-word' }} title={displayName}>
                    {displayName}
                  </div>
                )}
                <div className="row wrap mt8">
                  <a className="btn small" href={webViewLink(f)} target="_blank" rel="noreferrer">Open</a>
                  <button
                    className="btn small"
                    onClick={async () => {
                      try {
                        await downloadToBrowser(f, info?.name ?? displayName)
                      } catch (err) {
                        setError(describeError(err).message)
                      }
                    }}
                  >
                    Download
                  </button>
                  {writable && renamingId !== f && (
                    <button
                      className="btn small ghost"
                      onClick={() => {
                        setRenameValue(info?.name ?? f)
                        setRenamingId(f)
                      }}
                    >
                      Rename
                    </button>
                  )}
                  {writable && (
                    <button
                      className="btn small danger"
                      onClick={async () => {
                        if (!confirm(`Delete "${displayName}"? It moves to Drive trash (recoverable for 30 days).`)) return
                        const r = await removeProjectFile(projectId, f, { trashInDrive: true })
                        if (!r.ok) setError(r.error)
                      }}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {writable && (
        <div className="mt16">
          <div
            className="dropzone"
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              const file = e.dataTransfer.files[0]
              if (file) void startUpload(file)
            }}
          >
            Drop media here or click to upload → this project's folder on Drive
            {uploadPct !== null && <div className="progress"><div style={{ width: `${uploadPct}%` }} /></div>}
          </div>
          <input
            ref={fileInput}
            type="file"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void startUpload(file)
              e.target.value = ''
            }}
          />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Scripts tab — read scripts in place, link/unlink
// ---------------------------------------------------------------------------

function ScriptsTab({ projectId }: { projectId: string }): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const writable = canWrite()
  const [openScript, setOpenScript] = useState<string | null>(null)
  const [bodies, setBodies] = useState<Record<string, string | null>>({})

  const project = doc?.projects[projectId]
  if (!doc || !project) return <></>

  const scripts = Object.values(doc.scripts).filter((s) => s.deleted === null && s.projectId === projectId)
  const unlinked = Object.values(doc.scripts).filter((s) => s.deleted === null && s.projectId === null)
  const scriptKey = scripts.map((s) => s.id).join(',')

  useEffect(() => {
    let alive = true
    for (const s of scripts) {
      if (bodies[s.id] !== undefined) continue
      void readScriptBody(s.id).then((text) => {
        if (alive) setBodies((prev) => ({ ...prev, [s.id]: text ?? '' }))
      })
    }
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scriptKey])

  return (
    <div>
      {scripts.length === 0 && <Empty icon="✎">No scripts assigned to this project.</Empty>}
      {scripts.map((s) => (
        <div key={s.id} className="card mb8">
          <div className="spread">
            <div className="row">
              <span style={{ fontWeight: 600 }}>{s.title}</span>
              <span className={`badge ${s.status === 'final' ? 'done' : s.status === 'review' ? 'doing' : ''}`}>{s.status}</span>
            </div>
            <div className="row">
              <a className="btn small" href="#/scripts">Edit on Scripts page</a>
              {writable && (
                <button className="btn small ghost" onClick={() => updateScript(s.id, { projectId: null })}>Unlink</button>
              )}
              <button className="btn small" onClick={() => setOpenScript(openScript === s.id ? null : s.id)}>
                {openScript === s.id ? 'Hide' : 'Read'}
              </button>
            </div>
          </div>
          {openScript === s.id && (
            <pre className="manuscript mt8" style={{ fontFamily: 'var(--mono)', fontSize: 13, whiteSpace: 'pre-wrap', padding: '12px 14px', borderRadius: 6, border: '1px solid var(--border)', maxHeight: 420, overflowY: 'auto', margin: 0 }}>
              {bodies[s.id] ?? 'Loading…'}
            </pre>
          )}
        </div>
      ))}

      {writable && unlinked.length > 0 && (
        <div className="card">
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Link an existing script to this project</label>
            <select
              className="input"
              value=""
              onChange={(e) => {
                if (e.target.value) updateScript(e.target.value, { projectId })
              }}
            >
              <option value="">Pick a script…</option>
              {unlinked.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
            </select>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

function SettingsTab({ projectId }: { projectId: string }): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const writable = canWrite()
  const [labelInput, setLabelInput] = useState('')
  const commitNotesDebounced = useDebouncedCommit(800)
  const project = doc?.projects[projectId]
  const [notesDraft, setNotesDraft] = useState(project?.notes ?? '')
  const notesDirty = useRef(false)

  useEffect(() => {
    if (!notesDirty.current && project && project.notes !== notesDraft) setNotesDraft(project.notes)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.notes])

  if (!doc || !project) return <></>

  const commitNotes = (value: string) => {
    commitNotesDebounced((d) => {
      const p = d.projects[projectId]
      if (!p) return
      p.notes = value
      touch('projects', p)
    })
  }

  return (
    <div>
      <div className="field">
        <label>Assignee</label>
        <select
          className="input"
          style={{ maxWidth: 260 }}
          value={project.assigneeAppId ?? ''}
          disabled={!writable}
          onChange={(e) => updateProject(projectId, { assigneeAppId: e.target.value || null })}
        >
          <option value="">Unassigned</option>
          {doc.users.app.filter((u) => !u.disabled).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </div>

      <div className="field">
        <label>Due date</label>
        <input
          className="input"
          style={{ maxWidth: 200 }}
          type="date"
          value={project.dueAt ? project.dueAt.slice(0, 10) : ''}
          disabled={!writable}
          onChange={(e) => updateProject(projectId, { dueAt: e.target.value || null })}
        />
      </div>

      <div className="field">
        <label>Group (moves the folder + files)</label>
        <select
          className="input"
          style={{ maxWidth: 260 }}
          value={project.groupId}
          disabled={!writable}
          onChange={(e) => {
            const next = e.target.value
            if (next === project.groupId) return
            if (confirm('Move this project (and its files) to the selected group?')) {
              updateProject(projectId, { groupId: next })
            }
          }}
        >
          {Object.values(doc.groups)
            .filter((g) => g.deleted === null)
            .map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </div>

      <div className="field">
        <label>Labels</label>
        <div className="chips">
          {[...new Set([...doc.settings.labels, ...project.labels])].map((l) => {
            const on = project.labels.includes(l)
            return (
              <button
                key={l}
                className={`chip ${on ? 'on' : ''}`}
                disabled={!writable}
                onClick={() =>
                  updateProject(projectId, { labels: on ? project.labels.filter((x) => x !== l) : [...project.labels, l] })
                }
              >
                {l}
              </button>
            )
          })}
          {writable && (
            <input
              className="input"
              style={{ width: 130, padding: '2px 9px', fontSize: 12 }}
              placeholder="+ new label"
              value={labelInput}
              onChange={(e) => setLabelInput(e.target.value)}
              onKeyDown={(e) => {
                const v = labelInput.trim()
                if (e.key === 'Enter' && v) {
                  updateProject(projectId, { labels: [...new Set([...project.labels, v])] })
                  setLabelInput('')
                }
              }}
            />
          )}
        </div>
      </div>

      <div className="field">
        <label>Notes</label>
        <textarea
          className="input legal-pad"
          value={notesDraft}
          disabled={!writable}
          onChange={(e) => {
            setNotesDraft(e.target.value)
            notesDirty.current = true
            commitNotes(e.target.value)
          }}
          onBlur={() => {
            notesDirty.current = false
          }}
          placeholder="Context, links, feedback…"
        />
      </div>

      {writable && (
        <div className="card" style={{ borderColor: 'rgba(255,107,122,.35)' }}>
          <h3>Danger zone</h3>
          <p className="muted small">
            Deletes this project and moves its Drive folder (with all files) to Drive trash — recoverable for 30 days.
          </p>
          <button
            className="btn danger"
            onClick={async () => {
              const fileList = project.fileIds.length
                ? `It has ${project.fileIds.length} file${project.fileIds.length === 1 ? '' : 's'}.`
                : 'It has no files.'
              if (confirm(`Delete project "${project.name}"?\n\n${fileList}\n\nYou can restore it from the Archive.`)) {
                const { deleteProjectCascade } = await import('../../state/actions')
                await deleteProjectCascade(projectId)
                navigate('dash')
              }
            }}
          >
            Delete project
          </button>
        </div>
      )}
    </div>
  )
}
