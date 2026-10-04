import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../../sync/store'
import { confirmDialog } from '../../components/ConfirmDialog'
import { useDebouncedCommit } from '../../components'
import { canWrite } from '../../../auth/session'
import { updateProject } from '../../../state/actions'
import { touch } from '../../../sync/writer'
import { navigate } from '../../../nav'

/** Project settings: assignee, due date, group, labels, notes, danger zone. */
export function SettingsTab({ projectId }: { projectId: string }): React.JSX.Element {
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
          onChange={async (e) => {
            const next = e.target.value
            if (next === project.groupId) return
            const group = doc.groups[next]
            const ok = await confirmDialog({
              title: 'Move this project?',
              body: (
                <div className="confirm-body">
                  <div className="confirm-what">
                    {project.name} moves to “{group?.name ?? 'the selected group'}” — the folder and its files move with it.
                  </div>
                </div>
              ),
              confirmLabel: 'Move project',
            })
            if (ok) updateProject(projectId, { groupId: next })
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
            Removes this project from the board. Its files stay in the bucket until you Purge it from the Archive — Restore from the Archive brings it back intact.
          </p>
          <button
            className="btn danger"
            onClick={async () => {
              const fileList = project.fileIds.length
                ? `It has ${project.fileIds.length} file${project.fileIds.length === 1 ? '' : 's'}.`
                : 'It has no files.'
              const ok = await confirmDialog({
                title: `Delete project “${project.name}”?`,
                body: (
                  <div className="confirm-body">
                    <div className="confirm-what">{fileList}</div>
                    You can restore it from the Archive.
                  </div>
                ),
                confirmLabel: 'Delete project',
                tone: 'danger',
              })
              if (!ok) return
              const { deleteProjectCascade } = await import('../../../state/actions')
              await deleteProjectCascade(projectId)
              navigate('dash')
            }}
          >
            Delete project
          </button>
        </div>
      )}
    </div>
  )
}
