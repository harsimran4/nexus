import { useState } from 'react'
import { useStore, storeGet } from '../../sync/store'
import { type Project } from '../../types/schema'
import { decodeHlc } from '../../util/hlc'
import { canWrite } from '../../auth/session'
import { commit, touch, recordTombstone, appendActivity, flush, forgetPending, writerId } from '../../sync/writer'
import { unarchiveProject, updateProject } from '../../state/actions'
import { describeError } from '../../drive/preview'
import { Empty, Icon, StatusBadge, PageQuote, banner, confirmDialog, toast } from '../components'

/** Permanently remove from the database; tombstone prevents resurrection.
 *  THIS is where the files leave the bucket (trash/ — delete only tombstoned
 *  the doc so Restore stayed possible). Writes through IMMEDIATELY (no
 *  debounce) — a refresh right after purging must never bring the old state
 *  back. */
async function purgeProject(project: Project): Promise<void> {
  forgetPending(project.id) // its scratch entry must not resurrect it
  if (project.folderId) {
    const { trashFile } = await import('../../drive/client')
    // NO silent catch: a failed trash must abort the purge (the caller
    // surfaces it) — otherwise the doc forgets the project while its bytes
    // stay live in the bucket with no remaining reference.
    await trashFile(project.folderId)
    const { thumbKeyFor } = await import('../../util/media')
    for (const f of project.fileIds) {
      const thumb = thumbKeyFor(f)
      if (thumb) await trashFile(thumb).catch(() => {})
    }
  }
  commit((doc) => {
    const next = { ...doc.projects }
    delete next[project.id]
    doc.projects = next
    recordTombstone(doc, 'project', project.id, writerId())
    appendActivity(doc, 'project.purge', project.id, { name: project.name })
  })
  await flush()
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

/** Relative phrasing matching the activity feed (m/h/d/w ago); the exact
 *  moment rides along as a title tooltip. */
function rel(stamp: string | null): string {
  const ms = stampMs(stamp)
  if (ms === null) return '—'
  const mins = Math.floor((Date.now() - ms) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks}w ago`
  return new Date(ms).toLocaleDateString()
}

function exact(stamp: string | null): string {
  const ms = stampMs(stamp)
  return ms === null ? '—' : new Date(ms).toLocaleString()
}

function stampMs(stamp: string | null): number | null {
  if (!stamp) return null
  const ms = decodeHlc(stamp).ms || new Date(stamp).getTime()
  return Number.isFinite(ms) && ms > 0 ? ms : null
}

export function Archive(): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const [purgeBusy, setPurgeBusy] = useState(false)
  const [tab, setTab] = useState<'deleted' | 'archived'>('deleted')
  const writable = canWrite()

  const deletedProjects = Object.values(doc?.projects ?? {})
    .filter((p) => p.deleted !== null)
    .sort((a, b) => stampMs(b.deleted?.at ?? null)! - stampMs(a.deleted?.at ?? null)!)
  const archivedProjects = Object.values(doc?.projects ?? {})
    .filter((p) => p.deleted === null && p.archivedAt !== null)
    .sort((a, b) => stampMs(b.archivedAt)! - stampMs(a.archivedAt)!)

  const purgeNow = async (projectId: string): Promise<void> => {
    const p = deletedProjects.find((x) => x.id === projectId)
    if (!p) return
    const ok = await confirmDialog({
      title: `Purge “${p.name}” permanently?`,
      body: (
        <div className="confirm-body">
          <div className="confirm-what">
            Its folder — {p.name}/ with {p.fileIds.length} file{p.fileIds.length === 1 ? '' : 's'} — is erased for good.
          </div>
          Nothing brings it back, not even the trash.
        </div>
      ),
      confirmLabel: 'Purge forever',
      tone: 'danger',
    })
    if (!ok) return
    // Re-resolve after the dialog: it can sit open while another device
    // purges — or RESTORES — the project. Purging a restored (live) project
    // would be unrecoverable, and the pre-dialog snapshot's fileIds could
    // miss thumbs added since (they live outside the folder). The old modal
    // got this for free by re-finding the project in the deleted-only list
    // at click time; this is that check.
    const cur = storeGet().doc?.projects[projectId]
    if (!cur || cur.deleted === null) return
    setPurgeBusy(true)
    try {
      await purgeProject(cur)
      toast.success(`“${cur.name}” erased for good`)
    } catch (e) {
      const d = describeError(e)
      toast.error(d.message, d.fix)
    } finally {
      setPurgeBusy(false)
    }
  }

  const bringBack = (p: Project): void => {
    restoreProject(p)
    toast.success(`“${p.name}” is back on the board`)
  }

  return (
    <div>
      <div className="content-header">
        <div>
          <h1>Archive</h1>
          <div className="sub">
            Deleted projects live here until purged. Done projects past the auto-archive delay land in the Archived tab.
          </div>
        </div>
        <div className="chips" role="group" aria-label="Archive view">
          <button className={`chip ${tab === 'deleted' ? 'on' : ''}`} aria-pressed={tab === 'deleted'} onClick={() => setTab('deleted')}>
            Deleted ({deletedProjects.length})
          </button>
          <button className={`chip ${tab === 'archived' ? 'on' : ''}`} aria-pressed={tab === 'archived'} onClick={() => setTab('archived')}>
            Archived ({archivedProjects.length})
          </button>
        </div>
      </div>

      <PageQuote topic="archive" />

      {!writable && banner('info', 'Read-only view', 'Sign in as an editor or admin to restore or purge.')}

      {tab === 'archived' &&
        (archivedProjects.length === 0 ? (
          <Empty icon="📦">Nothing archived. Done projects move here automatically after the configured delay.</Empty>
        ) : (
          <div className="box-shelf">
            {archivedProjects.map((p) => (
              <div key={p.id} className="box-card">
                <div className="spread">
                  <span className="box-card-name">
                    <Icon name="box" size={13} /> {p.name}
                  </span>
                  {doc && <StatusBadge doc={doc} status={p.status} />}
                </div>
                <div className="box-card-meta small muted">
                  {doc?.groups[p.groupId]?.name ?? '—'} · archived{' '}
                  <span title={exact(p.archivedAt)}>{rel(p.archivedAt)}</span>
                </div>
                {writable && (
                  <div className="mt8">
                    <button
                      className="btn small"
                      onClick={() => {
                        unarchiveProject(p.id)
                        toast.success(`“${p.name}” is back on the board`)
                      }}
                    >
                      Move back to board
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}

      {tab === 'deleted' &&
        (deletedProjects.length === 0 ? (
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
                      <td className="archive-name">{p.name}</td>
                      <td className="muted small">{groupDeleted ? 'group deleted' : group?.name}</td>
                      <td className="small muted">{p.fileIds.length}</td>
                      <td className="small muted" title={exact(p.deleted?.at ?? null)}>
                        {rel(p.deleted?.at ?? null)}
                      </td>
                      <td>
                        {writable && (
                          <span className="row">
                            {groupDeleted ? (
                              <RestoreToGroup project={p} groups={Object.values(doc?.groups ?? {}).filter((g) => g.deleted === null)} disabled={purgeBusy} />
                            ) : (
                              <button className="btn small" disabled={purgeBusy} onClick={() => bringBack(p)}>Restore</button>
                            )}
                            <button className="btn small danger" disabled={purgeBusy} onClick={() => void purgeNow(p.id)}>
                              Purge
                            </button>
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ))}
    </div>
  )
}

/** Restore for a project whose group is gone: pick a live group first. */
function RestoreToGroup({ project, groups, disabled }: { project: Project; groups: { id: string; name: string }[]; disabled?: boolean }): React.JSX.Element {
  const [groupId, setGroupId] = useState('')
  const go = () => {
    if (!groupId) return
    updateProject(project.id, { groupId })
    restoreProject(project)
    toast.success(`“${project.name}” is back on the board`)
  }
  return (
    <span className="row">
      <select className="input archive-move-select" value={groupId} disabled={disabled} onChange={(e) => setGroupId(e.target.value)} title="Its old group was deleted — pick where it should live">
        <option value="">Move to…</option>
        {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
      </select>
      <button className="btn small" disabled={!groupId || disabled} onClick={go}>Restore</button>
    </span>
  )
}
