import { useMemo } from 'react'
import { useStore } from '../../sync/store'
import type { Item } from '../../types/schema'
import { compareHlc, decodeHlc } from '../../util/hlc'
import { Empty, KindBadge, banner } from '../components'
import { canWrite } from '../../auth/session'
import { commit, touch, appendActivity, recordTombstone, writerId } from '../../sync/writer'

// ---------------------------------------------------------------------------
// Archive-local mutations. updateItem() can't clear the deleted flag (it only
// accepts content fields), so restore/purge talk to commit() directly, exactly
// like the actions in state/actions.ts do.
// ---------------------------------------------------------------------------

/** Undo a soft delete and/or archive — the item returns to the Dashboard. */
function restoreItem(item: Item): void {
  commit((doc) => {
    const it = doc.items[item.id]
    if (it) {
      it.deleted = null
      it.archivedAt = null
      touch('items', it)
      appendActivity(doc, 'item.restore', item.id, {})
    }
  })
}

/**
 * Hard delete: the key is gone from doc.items, but a fresh tombstone is
 * recorded so an older copy on another device can't resurrect it on merge.
 * (Purging the tombstone too would be what actually invites resurrection.)
 */
function purgeItem(item: Item): void {
  commit((doc) => {
    const it = doc.items[item.id]
    if (!it) return
    delete doc.items[item.id]
    recordTombstone(doc, 'item', item.id, writerId())
    appendActivity(doc, 'item.purge', item.id, { title: it.title })
  })
}

/** HLC stamps ("<ms>.<counter>") → display date; tolerates plain ISO strings. */
function when(stamp: string | null): string {
  if (!stamp) return '—'
  const { ms } = decodeHlc(stamp)
  const d = ms > 0 ? new Date(ms) : new Date(stamp)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString()
}

export function Archive(): React.JSX.Element {
  const doc = useStore((s) => s.doc)

  const deleted = useMemo(() => {
    if (!doc) return []
    return Object.values(doc.items)
      .filter((i) => i.deleted !== null)
      .sort((a, b) => compareHlc(b.deleted?.at, a.deleted?.at))
  }, [doc])

  const archived = useMemo(() => {
    if (!doc) return []
    return Object.values(doc.items)
      .filter((i) => i.deleted === null && i.archivedAt !== null)
      .sort((a, b) => compareHlc(b.archivedAt, a.archivedAt))
  }, [doc])

  if (!doc) return <></>

  const writable = canWrite()
  const projectName = (id: string | null): string => (id ? doc.projects[id]?.name ?? '—' : '—')

  const onRestore = (item: Item) => {
    if (!writable) return
    if (confirm(`Restore "${item.title}"? It returns to the Dashboard with its files, labels and history intact.`)) {
      restoreItem(item)
    }
  }

  const onPurge = (item: Item) => {
    if (!writable) return
    if (confirm(`Purge "${item.title}" permanently? The record is erased for good — this cannot be undone.`)) {
      purgeItem(item)
    }
  }

  return (
    <div>
      <div className="content-header">
        <div>
          <h1>Archive</h1>
          <div className="sub">
            {deleted.length} deleted · {archived.length} archived
          </div>
        </div>
      </div>

      <div className="card mb8">
        <p className="muted small" style={{ margin: 0 }}>
          Deleting is soft: the record stays in the workspace — files, labels and history untouched — flagged{' '}
          <code>deleted</code>. A <code>tombstone</code> rides along so a stale copy on another device can't resurrect
          the item during a merge. <b>Purge permanently</b> bypasses that protection and erases the record for good.
        </p>
      </div>

      {!writable &&
        banner('info', 'Read-only view', 'You are browsing as guest or viewer — sign in as an editor or admin to restore or purge items.')}

      <div className="card mb8">
        <div className="spread mb8">
          <h2>Deleted</h2>
          <span className="badge red">{deleted.length}</span>
        </div>
        {deleted.length === 0 ? (
          <Empty icon="⌫">
            Nothing deleted. Items removed from the board wait here, restorable any time.
          </Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Kind</th>
                <th>Project</th>
                <th>Deleted</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {deleted.map((item) => (
                <tr key={item.id}>
                  <td style={{ fontWeight: 550, wordBreak: 'break-word' }}>{item.title}</td>
                  <td><KindBadge kind={item.kind} /></td>
                  <td className="muted">{projectName(item.projectId)}</td>
                  <td className="muted">{when(item.deleted?.at ?? null)}</td>
                  <td>
                    <span className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                      <button
                        className="btn small"
                        disabled={!writable}
                        title={writable ? 'Back to the Dashboard' : 'Editors and admins only'}
                        onClick={() => onRestore(item)}
                      >
                        Restore
                      </button>
                      <button
                        className="btn danger small"
                        disabled={!writable}
                        title={writable ? 'Erase permanently — cannot be undone' : 'Editors and admins only'}
                        onClick={() => onPurge(item)}
                      >
                        Purge permanently
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="spread mb8">
          <h2>Archived</h2>
          <span className="badge">{archived.length}</span>
        </div>
        {archived.length === 0 ? (
          <Empty icon="▤">
            Nothing archived. Archived items are parked here — off the board but never lost.
          </Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Kind</th>
                <th>Project</th>
                <th>Archived</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {archived.map((item) => (
                <tr key={item.id}>
                  <td style={{ fontWeight: 550, wordBreak: 'break-word' }}>{item.title}</td>
                  <td><KindBadge kind={item.kind} /></td>
                  <td className="muted">{projectName(item.projectId)}</td>
                  <td className="muted">{when(item.archivedAt)}</td>
                  <td>
                    <span className="row" style={{ justifyContent: 'flex-end' }}>
                      <button
                        className="btn small"
                        disabled={!writable}
                        title={writable ? 'Back to the Dashboard' : 'Editors and admins only'}
                        onClick={() => onRestore(item)}
                      >
                        Restore
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
