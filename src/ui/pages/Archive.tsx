import { useState } from 'react'
import { useStore } from '../../sync/store'
import { statusLabel, type Project } from '../../types/schema'
import { decodeHlc } from '../../util/hlc'
import { canWrite } from '../../auth/session'
import { commit, touch, recordTombstone, appendActivity, forgetPending, writerId } from '../../sync/writer'
import { unarchiveProject, updateProject } from '../../state/actions'
import { Empty, banner, PageQuote } from '../components'

/** Permanently remove from the database; tombstone prevents resurrection.
 *  Drive files were already trashed by the cascade delete (30-day recovery). */
function purgeProject(project: Project): void {
  forgetPending(project.id) // its scratch entry must not resurrect it
  commit((doc) => {
    const next = { ...doc.projects }
    delete next[project.id]
    doc.projects = next
    recordTombstone(doc, 'project', project.id, writerId())
    appendActivity(doc, 'project.purge', project.id, { name: project.name })
  })
}

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

export function Archive(): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const [confirmPurge, setConfirmPurge] = useState<string | null>(null)
  const [tab, setTab] = useState<'deleted' | 'archived'>('deleted')
  const writable = canWrite()

  const deletedProjects = Object.values(doc?.projects ?? {})
    .filter((p) => p.deleted !== null)
    .sort((a, b) => decodeHlc(b.deleted?.at).ms - decodeHlc(a.deleted?.at).ms)
  const archivedProjects = Object.values(doc?.projects ?? {})
    .filter((p) => p.deleted === null && p.archivedAt !== null)
    .sort((a, b) => decodeHlc(b.archivedAt).ms - decodeHlc(a.archivedAt).ms)

  return (
    <div>
      <div className="content-header">
        <div>
          <h1>Archive</h1>
          <div className="sub">
            Deleted projects live here until purged. Done projects past the auto-archive delay land in the Archived tab.
          </div>
        </div>
        <div className="chips">
          <button className={`chip ${tab === 'deleted' ? 'on' : ''}`} onClick={() => setTab('deleted')}>
            Deleted ({deletedProjects.length})
          </button>
          <button className={`chip ${tab === 'archived' ? 'on' : ''}`} onClick={() => setTab('archived')}>
            Archived ({archivedProjects.length})
          </button>
        </div>
      </div>

      <PageQuote topic="archive" />

      {!writable && banner('info', 'Read-only view', 'Sign in as an editor or admin to restore or purge.')}

      {tab === 'archived' && (
        <div className="card">
          {archivedProjects.length === 0 ? (
            <Empty icon="📦">Nothing archived. Done projects move here automatically after the configured delay.</Empty>
          ) : (
            <table className="table ledger">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Group</th>
                  <th>Status</th>
                  <th>Archived</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {archivedProjects.map((p) => (
                  <tr key={p.id}>
                    <td style={{ fontWeight: 570 }}>{p.name}</td>
                    <td className="muted small">{doc?.groups[p.groupId]?.name ?? '—'}</td>
                    <td className="muted small">{doc ? statusLabel(doc, p.status) : p.status}</td>
                    <td className="small muted">{fmtWhenStr(p.archivedAt)}</td>
                    <td>
                      {writable && (
                        <button className="btn small" onClick={() => unarchiveProject(p.id)}>Move back to board</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'deleted' && (
        <>
          {deletedProjects.length === 0 ? (
            <Empty icon="🗄">Nothing deleted — the Archive is empty.</Empty>
          ) : (
        <div className="card archived-paper">
          <table className="table ledger">
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
                const groupDeleted = !group || group.deleted !== null
                return (
                  <tr key={p.id}>
                    <td style={{ fontWeight: 570 }}>{p.name}</td>
                    <td className="muted small">{groupDeleted ? 'group deleted' : group?.name}</td>
                    <td className="small muted">{p.fileIds.length}</td>
                    <td className="small muted">{fmtDeleted(p)}</td>
                    <td>
                      {writable && (
                        <span className="row">
                          {groupDeleted ? (
                            <RestoreToGroup project={p} groups={Object.values(doc?.groups ?? {}).filter((g) => g.deleted === null)} />
                          ) : (
                            <button className="btn small" onClick={() => restoreProject(p)}>Restore</button>
                          )}
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
        </>
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

function fmtWhenStr(stamp: string | null): string {
  if (!stamp) return '—'
  const ms = decodeHlc(stamp).ms || new Date(stamp).getTime()
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleString() : '—'
}

/** Restore for a project whose group is gone: pick a live group first. */
function RestoreToGroup({ project, groups }: { project: Project; groups: { id: string; name: string }[] }): React.JSX.Element {
  const [groupId, setGroupId] = useState('')
  const go = () => {
    if (!groupId) return
    updateProject(project.id, { groupId })
    restoreProject(project)
  }
  return (
    <span className="row">
      <select className="input" style={{ maxWidth: 150, padding: '3px 8px', fontSize: 12 }} value={groupId} onChange={(e) => setGroupId(e.target.value)} title="Its old group was deleted — pick where it should live">
        <option value="">Move to…</option>
        {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
      </select>
      <button className="btn small" disabled={!groupId} onClick={go}>Restore</button>
    </span>
  )
}
