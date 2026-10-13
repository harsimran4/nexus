import { useState } from 'react'
import { useStore } from '../../../sync/store'
import { banner, CopyButton, Empty, Icon, Modal, toast } from '../../components'
import { canWrite } from '../../../auth/session'
import { createRef, deleteRef, updateRef } from '../../../state/actions'
import { decodeHlc } from '../../../util/hlc'
import { formatRelative } from '../../../util/media'
import type { Ref } from '../../../types/schema'

/** References assigned to this project — saved external links (research,
 *  inspiration, brand rules). Rows live in the top-level doc.refs array;
 *  read-only users browse and copy but can't mutate. Each row shows the
 *  site's favicon — a domain-only request to a public icon service, hidden
 *  gracefully when the icon can't load. */

function faviconFor(url: string): string | null {
  try {
    return 'https://icons.duckduckgo.com/ip3/' + new URL(url).hostname + '.ico'
  } catch {
    return null
  }
}

export function RefsTab({ projectId }: { projectId: string }): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const writable = canWrite()
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Ref | null>(null)

  const refs = (doc?.refs ?? [])
    .filter((r) => r.deleted === null && r.projectId === projectId)
    .slice()
    .sort((a, b) => {
      const A = decodeHlc(a.createdAt)
      const B = decodeHlc(b.createdAt)
      return B.ms - A.ms || B.c - A.c || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    }) // newest first, deterministic on ties

  const remove = (r: Ref): void => {
    try {
      // A peer may have removed it while we were looking — the action no-ops
      // then, and an honest toast beats a false receipt.
      if (!deleteRef(r.id)) {
        toast.info('Already removed')
        return
      }
      toast.success(`Removed “${r.title || r.url}”`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  return (
    <div>
      <div className="spread mb8">
        <h3 style={{ margin: 0 }}>References</h3>
        {writable && (
          <button className="btn primary small" onClick={() => setAdding(true)}>
            <Icon name="plus" size={13} /> Add reference
          </button>
        )}
      </div>

      {!writable && banner('info', 'Read-only view', 'Sign in as an editor or admin to add or remove references.')}

      {refs.length === 0 ? (
        <Empty icon="❐">
          No references yet.{' '}
          {writable ? 'Save research and inspiration links here — they open in a new tab.' : ''}
        </Empty>
      ) : (
        refs.map((r) => {
          const favicon = faviconFor(r.url)
          return (
            <div key={r.id} className="card mb8">
              <div className="spread refs-row">
                <div style={{ minWidth: 0 }}>
                  <span className="row refs-title-line">
                    {favicon && (
                      <img
                        className="refs-favicon"
                        src={favicon}
                        alt=""
                        loading="lazy"
                        onError={(e) => { e.currentTarget.style.display = 'none' }}
                      />
                    )}
                    {/* URLs are validated on write, but the doc accepts what
                        a peer wrote — never render a non-http(s) url as a link. */}
                    {/^https?:\/\//i.test(r.url) ? (
                      <a href={r.url} target="_blank" rel="noreferrer" className="refs-title">
                        {r.title || r.url}
                      </a>
                    ) : (
                      <span className="refs-title">{r.title || r.url}</span>
                    )}
                  </span>
                  <div className="faint small refs-url">{r.url}</div>
                  {r.note && <div className="muted small mt8" style={{ whiteSpace: 'pre-wrap' }}>{r.note}</div>}
                </div>
                <div className="row" style={{ flexShrink: 0 }}>
                  <span
                    className="faint small refs-when"
                    title={new Date(decodeHlc(r.createdAt).ms).toLocaleString()}
                  >
                    added {formatRelative(decodeHlc(r.createdAt).ms)}
                  </span>
                  <CopyButton text={r.url} label="Copy" />
                  {writable && (
                    <button className="btn small ghost" onClick={() => setEditing(r)}>Edit</button>
                  )}
                  {writable && (
                    <button className="btn small danger" onClick={() => remove(r)}>Delete</button>
                  )}
                </div>
              </div>
            </div>
          )
        })
      )}

      {(adding || editing !== null) && (
        <RefForm existing={editing} projectId={projectId} onClose={() => { setAdding(false); setEditing(null) }} />
      )}
    </div>
  )
}

function RefForm({ existing, projectId, onClose }: {
  existing: Ref | null
  projectId: string
  onClose: () => void
}): React.JSX.Element {
  const [url, setUrl] = useState(existing?.url ?? '')
  const [title, setTitle] = useState(existing?.title ?? '')
  const [note, setNote] = useState(existing?.note ?? '')
  const [error, setError] = useState<string | null>(null)
  const valid = /^https?:\/\//i.test(url.trim())

  const submit = (): void => {
    if (!valid) {
      setError('The link must start with http:// or https://')
      return
    }
    try {
      if (existing) {
        if (!updateRef(existing.id, { url, title, note })) {
          setError('This reference was removed by someone else.')
          return
        }
        toast.success('Reference updated')
      } else {
        createRef({ projectId, url, title, note })
        toast.success('Reference saved')
      }
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    }
  }

  return (
    <Modal title={existing ? 'Edit reference' : 'Add reference'} onClose={onClose}>
      <div className="field">
        <label>Link</label>
        <input
          className="input"
          autoFocus
          value={url}
          placeholder="https://…"
          spellCheck={false}
          onChange={(e) => { setUrl(e.target.value); setError(null) }}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      </div>
      <div className="field">
        <label>Title (optional — the link is shown when empty)</label>
        <input className="input" value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label>Note (optional)</label>
        <textarea className="input" rows={3} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
      </div>
      {error && banner('error', error)}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!url.trim()} onClick={submit}>
          {existing ? 'Save' : 'Add reference'}
        </button>
      </div>
    </Modal>
  )
}
