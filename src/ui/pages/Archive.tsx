import { useState } from 'react'
import { useStore } from '../../sync/store'
import type { Project } from '../../types/schema'
import { decodeHlc } from '../../util/hlc'
import { canWrite } from '../../auth/session'
import { commit, touch, recordTombstone, appendActivity, writerId } from '../../sync/writer'
import { Empty, banner, PageQuote } from '../components'

/** Restore a deleted project (clears the deleted marker). */
function restoreProject(project: Project): void {
  commit((doc) => {
    const p = doc.projects[project.id]
    if (!p) return
    p.deleted = null
    touch('projects', p)
    appendActivity(doc, 'project.restore', project.id, { name: p.name })
  })
}

/** Permanently remove from the database; tombstone prevents resurrection.
 *  Drive files were already trashed by the cascade delete (30-day recovery). */
function purgeProject(project: Project): void {
  commit((doc) => {
    const next = { ...doc.projects }
    delete next[project.id]
    doc.projects = next
    recordTombstone(doc, 'project', project.id, writerId())
    appendActivity(doc, 'project.purge', project.id, { name: project.name })
  })
}

export function Archive(): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const [confirmPurge, setConfirmPurge] = useState<string | null>(null)
  const writable = canWrite()

  const deletedProjects = Object.values(doc?.projects ?? {})
    .filter((p) => p.deleted !== null)
    .sort((a, b) => decodeHlc(b.deleted?.at).ms - decodeHlc(a.deleted?.at).ms)

  return (
    <div>
      <div className="content-header">
        <div>
          <h1>Archive</h1>
          <div className="sub">Deleted projects live here until purged. Deleting a project moves its Drive folder to trash.</div>
        </div>
      </div>

      <PageQuote topic="archive" />

      {!writable && banner('info', 'Read-only view', 'Sign in as an editor or admin to restore or purge.')}

      {deletedProjects.length === 0 ? (
        <Empty icon="🗄">Nothing deleted — the Archive is empty.</Empty>
      ) : (
        <div className="card archived-paper">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Group</th>
                <th>Files</th>
                <th>Deleted</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {deletedProjects.map((p) => {
                const group = doc?.groups[p.groupId]
                return (
                  <tr key={p.id}>
                    <td style={{ fontWeight: 570 }}>{p.name}</td>
                    <td className="muted small">{group?.name ?? '—'}</td>
                    <td className="small muted">{p.fileIds.length}</td>
                    <td className="small muted">{fmtDeleted(p)}</td>
                    <td>
                      {writable && (
                        <span className="row">
                          <button className="btn small" onClick={() => restoreProject(p)}>Restore</button>
                          <button className="btn small danger" onClick={() => setConfirmPurge(p.id)}>Purge</button>
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {confirmPurge && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setConfirmPurge(null)}>
          <div className="modal">
            <h2>Purge permanently?</h2>
            <p className="muted small">
              Removes the project from the database. The tombstone keeps it deleted across merges. Files already
              sit in Drive trash (30-day recovery).
            </p>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setConfirmPurge(null)}>Cancel</button>
              <button
                className="btn danger"
                onClick={() => {
                  const p = deletedProjects.find((x) => x.id === confirmPurge)
                  if (p) purgeProject(p)
                  setConfirmPurge(null)
                }}
              >
                Purge
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function fmtDeleted(p: Project): string {
  const ms = decodeHlc(p.deleted?.at).ms
  return ms ? new Date(ms).toLocaleString() : '—'
}
