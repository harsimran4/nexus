import { useState } from 'react'
import { useStore } from '../../../sync/store'
import { banner, Empty, Icon, toast } from '../../components'
import { useCanWrite } from '../../../auth/session'
import { createComment, deleteComment, setProjectApproval } from '../../../state/actions'
import { decodeHlc } from '../../../util/hlc'
import { formatRelative } from '../../../util/media'
import type { Comment } from '../../../types/schema'

/** P7 — the project's discussion thread + approval state. Comments live in
 *  the top-level doc.comments array (per-entry LWW — a thread embedded on
 *  the project would let one writer's whole-project save clobber everyone
 *  else's comments); approval is the project's single-slot LWW field. Names
 *  resolve from users.app ∪ users.viewers at render — never stored. */

function nameFor(doc: NonNullable<ReturnType<typeof useStore.getState>['doc']>, actorId: string): string {
  const app = doc.users.app.find((u) => u.id === actorId)
  if (app) return app.name
  const viewer = doc.users.viewers.find((v) => v.id === actorId)
  if (viewer) return viewer.name
  return actorId === 'anonymous' ? 'Someone' : actorId
}

export function DiscussionTab({ projectId }: { projectId: string }): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const writable = useCanWrite()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  const project = doc?.projects[projectId]
  const comments = (doc?.comments ?? [])
    .filter((c) => c.deleted === null && c.projectId === projectId)
    .slice()
    .sort((a, b) => {
      const A = decodeHlc(a.createdAt)
      const B = decodeHlc(b.createdAt)
      return A.ms - B.ms || A.c - B.c || (a.id < b.id ? -1 : 1) // oldest first — a thread reads top-down
    })

  const post = (): void => {
    try {
      createComment(projectId, draft)
      setDraft('')
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not post')
    }
  }

  const remove = (c: Comment): void => {
    try {
      if (!deleteComment(c.id)) toast.info('Already removed')
      else toast.success('Comment removed')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  const approval = project?.approved ?? null
  const approvedBy = doc && approval ? nameFor(doc, approval.by) : ''

  return (
    <div>
      <div className="spread mb8">
        <h3 style={{ margin: 0 }}>
          Discussion{' '}
          {approval && (
            <span className="chip on" title={`Approved by ${approvedBy}`}>
              ✓ Approved{approvedBy ? ` by ${approvedBy}` : ''}
            </span>
          )}
        </h3>
        {writable && (
          <button
            className={`btn small ${approval ? 'danger' : 'primary'}`}
            onClick={() => {
              try {
                setProjectApproval(projectId, !approval)
                toast.success(approval ? 'Approval removed' : 'Project approved')
              } catch (e) {
                toast.error(e instanceof Error ? e.message : 'Failed')
              }
            }}
          >
            <Icon name={approval ? 'x' : 'check'} size={13} />
            {approval ? 'Unapprove' : 'Approve'}
          </button>
        )}
      </div>

      {!writable && banner('info', 'Read-only view', 'Sign in as an editor or admin to comment or approve.')}

      {comments.length === 0 ? (
        <Empty icon="✎">
          No comments yet.{' '}
          {writable ? 'Leave notes for the team — everyone sees them live.' : ''}
        </Empty>
      ) : (
        comments.map((c) => {
          return (
            <div key={c.id} className="card mb8">
              <div className="spread refs-row">
                <div style={{ minWidth: 0 }}>
                  <div className="row refs-title-line">
                    <b className="refs-title">{doc ? nameFor(doc, c.by) : c.by}</b>
                    <span
                      className="faint small refs-when"
                      title={new Date(decodeHlc(c.createdAt).ms).toLocaleString()}
                    >
                      {formatRelative(decodeHlc(c.createdAt).ms)}
                    </span>
                  </div>
                  <div className="mt8" style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div>
                </div>
                {writable && (
                  <button className="btn small ghost" style={{ flexShrink: 0 }} onClick={() => remove(c)}>
                    Delete
                  </button>
                )}
              </div>
            </div>
          )
        })
      )}

      {writable && (
        <div className="card mt8">
          <textarea
            className="input"
            rows={3}
            maxLength={4000}
            placeholder="Write a comment…"
            aria-label="New comment"
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setError(null) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) post()
            }}
          />
          {error && banner('error', error)}
          <div className="row mt8" style={{ justifyContent: 'flex-end' }}>
            <span className="faint small" style={{ marginRight: 'auto' }}>Ctrl+Enter to post</span>
            <button className="btn primary" disabled={!draft.trim()} onClick={post}>
              <Icon name="plus" size={13} /> Comment
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
