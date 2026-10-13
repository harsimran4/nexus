import { useRef, useState } from 'react'
import { useStore } from '../../../sync/store'
import { banner, CopyButton, Empty, Icon, Modal, toast } from '../../components'
import { canWrite } from '../../../auth/session'
import { createRef, deleteRef, updateRef } from '../../../state/actions'
import { decodeHlc } from '../../../util/hlc'
import { formatRelative } from '../../../util/media'
import type { Ref } from '../../../types/schema'

/** References assigned to this project — saved external links (research,
 *  inspiration, brand rules). Rows live in the top-level doc.refs array;
 *  read-only users browse and copy but can't mutate. */
export function RefsTab({ projectId }: { projectId: string }): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const writable = canWrite()
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Ref | null>(null)

  const refs = (doc?.refs ?? [])
    .filter((r) => r.deleted === null && r.projectId === projectId)
    .slice()
    .sort((a, b) => decodeHlc(b.createdAt).ms - decodeHlc(a.createdAt).ms) // newest first

  const remove = (r: Ref): void => {
    try {
      deleteRef(r.id)
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
        refs.map((r) => (
          <div key={r.id} className="card mb8">
            <div className="spread">
              <div style={{ minWidth: 0 }}>
                <a
                  href={r.url}
                  target="_blank"
                  rel="noreferrer"
                  className="refs-title"
                >
                  {r.title || r.url}
                </a>
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
        ))
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
  const urlInput = useRef<HTMLInputElement>(null)
  const valid = /^https?:\/\//i.test(url.trim())

  const submit = (): void => {
    if (!valid) {
      setError('The link must start with http:// or https://')
      return
    }
    try {
      if (existing) {
        updateRef(existing.id, { url, title, note })
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
    <Modal title={existing ? 'Edit reference' : 'Add reference'} onClose={onClose} initialFocusRef={urlInput}>
      <div className="field">
        <label>Link</label>
        <input
          ref={urlInput}
          className="input"
          value={url}
          placeholder="https://…"
          spellCheck={false}
          onChange={(e) => { setUrl(e.target.value); setError(null) }}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      </div>
      <div className="field">
        <label>Title (optional — the link is shown when empty)</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label>Note (optional)</label>
        <textarea className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
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
