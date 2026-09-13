import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../sync/store'
import { Modal, CopyButton, banner, useDebouncedCommit } from '../components'
import { canWrite } from '../../auth/session'
import {
  deleteProjectCascade,
  removeProjectFile,
  setProjectStatus,
  updateProject,
  updateScript,
  uploadToProject,
} from '../../state/actions'
import { isSignedIn } from '../../auth/tokenClient'
import { describeError, downloadToBrowser } from '../../drive/preview'
import { thumbnailUrl, webViewLink } from '../../drive/client'
import { touch } from '../../sync/writer'

export function ProjectDialog({ projectId, onClose }: { projectId: string; onClose: () => void }): React.JSX.Element | null {
  const doc = useStore((s) => s.doc)
  const session = useStore((s) => s.session)
  const [labelInput, setLabelInput] = useState('')
  const [uploadPct, setUploadPct] = useState<number | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const commitNotesDebounced = useDebouncedCommit(800)

  // Notes draft: local while typing, committed once after the user pauses.
  const project = doc?.projects[projectId]
  const [notesDraft, setNotesDraft] = useState(project?.notes ?? '')
  const notesDirty = useRef(false)
  useEffect(() => {
    if (!notesDirty.current && project && project.notes !== notesDraft) setNotesDraft(project.notes)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.notes])

  if (!doc || !project) return null

  const writable = canWrite()
  const googleReady = isSignedIn()
  const activity = doc.activity.filter((a) => a.ref === projectId).slice(-12).reverse()
  const group = doc.groups[project.groupId]
  // Scripts assigned to this project + linkable candidates.
  const projectScripts = Object.values(doc.scripts).filter(
    (s) => s.deleted === null && s.projectId === projectId,
  )
  const unlinkedScripts = Object.values(doc.scripts).filter(
    (s) => s.deleted === null && s.projectId === null && s.storage.type === 'md',
  )

  const commitNotes = (value: string) => {
    commitNotesDebounced((d) => {
      const p = d.projects[projectId]
      if (!p) return
      p.notes = value
      touch('projects', p)
    })
  }

  const startUpload = async (file: File) => {
    setUploadError(null)
    setUploadPct(0)
    const r = await uploadToProject(projectId, file, setUploadPct)
    setUploadPct(null)
    if (!r.ok) setUploadError(r.error)
  }

  return (
    <Modal title={project.name} onClose={onClose} wide>
      <div className="row wrap mb8">
        {group && <span className="badge">{group.name}</span>}
        {project.fileIds.map((f) => (
          <img
            key={f}
            src={thumbnailUrl(f, 64)}
            alt=""
            style={{ width: 30, height: 30, borderRadius: 6, objectFit: 'cover', border: '1px solid var(--border)' }}
            onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
          />
        ))}
      </div>

      <div className="row wrap mb8">
        <select
          className="input"
          style={{ maxWidth: 180 }}
          value={project.status}
          disabled={!writable}
          onChange={(e) => setProjectStatus(projectId, e.target.value)}
        >
          {doc.settings.pipeline.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <select
          className="input"
          style={{ maxWidth: 200 }}
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
        <select
          className="input"
          style={{ maxWidth: 170 }}
          value={project.assigneeAppId ?? ''}
          disabled={!writable}
          onChange={(e) => updateProject(projectId, { assigneeAppId: e.target.value || null })}
        >
          <option value="">Unassigned</option>
          {doc.users.app.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <input
          className="input"
          style={{ maxWidth: 160 }}
          type="date"
          value={project.dueAt ? project.dueAt.slice(0, 10) : ''}
          disabled={!writable}
          onChange={(e) => updateProject(projectId, { dueAt: e.target.value || null })}
        />
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
        <label>Files ({project.fileIds.length})</label>
        {project.fileIds.map((f) => (
          <div className="row spread mb8" key={f} style={{ background: 'var(--bg-raised)', padding: '7px 10px', borderRadius: 8 }}>
            <span className="mono small" style={{ wordBreak: 'break-all' }}>{f}</span>
            <span className="row">
              <a className="btn small" href={webViewLink(f)} target="_blank" rel="noreferrer">Open in Drive</a>
              <button
                className="btn small"
                onClick={async () => {
                  try {
                    await downloadToBrowser(f, project.name)
                  } catch (e) {
                    setUploadError(describeError(e).fix)
                  }
                }}
              >
                Download
              </button>
              {writable && (
                <button
                  className="btn small danger"
                  title="Moves the file to Drive trash (recoverable for 30 days) and unlinks it from this project"
                  onClick={async () => {
                    if (!confirm('Delete this file? It moves to Drive trash (recoverable for 30 days) and is removed from this project.')) return
                    setUploadError(null)
                    const r = await removeProjectFile(projectId, f, { trashInDrive: true })
                    if (!r.ok) setUploadError(r.error)
                  }}
                >
                  Delete
                </button>
              )}
            </span>
          </div>
        ))}
        {writable && (
          <>
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
              Drop a file here or click to upload → this project's folder on Drive
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
            {!googleReady && banner('warn', 'Not connected to Google', 'Click "Connect Google (studio account)" in the top bar to enable uploads.')}
          </>
        )}
        {uploadError && banner('error', 'Upload/Download problem', uploadError)}
      </div>

      <div className="field">
        <label>Notes</label>
        <textarea
          className="input"
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

      <div className="field">
        <label>Scripts for this project ({projectScripts.length})</label>
        {projectScripts.length === 0 && (
          <span className="faint small">
            None yet — create one on the Scripts page and assign it to this project.
          </span>
        )}
        {projectScripts.map((s) => (
          <div key={s.id} className="row spread small" style={{ background: 'var(--bg-raised)', padding: '7px 10px', borderRadius: 8, marginBottom: 6 }}>
            <span className="row">
              <span className={`badge ${s.status === 'final' ? 'done' : s.status === 'review' ? 'doing' : ''}`}>{s.status}</span>
              <span style={{ fontWeight: 550 }}>{s.title}</span>
            </span>
            {writable && (
              <button
                className="btn small ghost"
                title="Unlink from this project (the script itself is kept)"
                onClick={() => updateScript(s.id, { projectId: null, groupId: null })}
              >
                Unlink
              </button>
            )}
          </div>
        ))}
        {writable && unlinkedScripts.length > 0 && (
          <select
            className="input"
            value=""
            onChange={(e) => {
              if (e.target.value) updateScript(e.target.value, { projectId: projectId, groupId: project.groupId })
            }}
          >
            <option value="">+ Link an existing script…</option>
            {unlinkedScripts.map((s) => (
              <option key={s.id} value={s.id}>{s.title}</option>
            ))}
          </select>
        )}
        <a className="btn small" href="#/scripts">Open Scripts page →</a>
      </div>

      <div className="field">
        <label>Activity</label>
        {activity.length === 0 && <span className="faint small">No history yet.</span>}
        {activity.map((a, i) => (
          <div key={i} className="small muted">
            {new Date(Number(a.at.split('.')[0])).toLocaleString()} · {a.verb}
            {typeof a.meta.to === 'string' ? ` → ${a.meta.to}` : ''}
          </div>
        ))}
      </div>

      {writable && (
        <div className="row spread mt16">
          <button
            className="btn danger"
            onClick={async () => {
              const fileList = project.fileIds.length
                ? `It has ${project.fileIds.length} file${project.fileIds.length === 1 ? '' : 's'} — all move to Drive trash (30-day recovery).`
                : 'It has no files.'
              if (confirm(`Delete project "${project.name}"?\n\n${fileList}\n\nYou can restore it from the Archive.`)) {
                try {
                  await deleteProjectCascade(projectId)
                  onClose()
                } catch (e) {
                  setUploadError(e instanceof Error ? e.message : 'Delete failed')
                }
              }
            }}
          >
            Delete project
          </button>
          <CopyButton text={projectId} label="Copy project id" />
        </div>
      )}
      {session === null && banner('info', 'Viewing as guest', 'Sign in to make changes.')}
    </Modal>
  )
}
