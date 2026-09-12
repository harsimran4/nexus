import { useRef, useState } from 'react'
import { useStore } from '../../sync/store'
import { Modal, KindBadge, CopyButton, banner } from '../components'
import { canWrite } from '../../auth/session'
import { deleteItem, setItemStatus, updateItem, uploadToItem } from '../../state/actions'
import { isSignedIn } from '../../auth/tokenClient'
import { describeError, downloadToBrowser } from '../../drive/preview'
import { thumbnailUrl, webViewLink } from '../../drive/client'

export function ItemDialog({ itemId, onClose }: { itemId: string; onClose: () => void }): React.JSX.Element | null {
  const doc = useStore((s) => s.doc)
  const session = useStore((s) => s.session)
  const [labelInput, setLabelInput] = useState('')
  const [uploadPct, setUploadPct] = useState<number | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const item = doc?.items[itemId]
  if (!doc || !item) return null

  const writable = canWrite()
  const googleReady = isSignedIn()
  const activity = doc.activity.filter((a) => a.ref === itemId).slice(-12).reverse()
  const project = item.projectId ? doc.projects[item.projectId] : null

  const startUpload = async (file: File) => {
    setUploadError(null)
    setUploadPct(0)
    const result = await uploadToItem(itemId, file, setUploadPct)
    setUploadPct(null)
    if (!result.ok) setUploadError(result.error)
  }

  return (
    <Modal title={item.title} onClose={onClose} wide>
      <div className="row wrap mb8">
        <KindBadge kind={item.kind} />
        {project && <span className="badge">{project.name}</span>}
        {item.fileIds.map((f) => (
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
          value={item.status}
          disabled={!writable}
          onChange={(e) => setItemStatus(itemId, e.target.value)}
        >
          {doc.settings.pipeline.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
        <select
          className="input"
          style={{ maxWidth: 170 }}
          value={item.assigneeAppId ?? ''}
          disabled={!writable}
          onChange={(e) => updateItem(itemId, { assigneeAppId: e.target.value || null })}
        >
          <option value="">Unassigned</option>
          {doc.users.app.map((u) => (
            <option key={u.id} value={u.id}>{u.name}</option>
          ))}
        </select>
        <input
          className="input"
          style={{ maxWidth: 160 }}
          type="date"
          value={item.dueAt ? item.dueAt.slice(0, 10) : ''}
          disabled={!writable}
          onChange={(e) => updateItem(itemId, { dueAt: e.target.value || null })}
        />
      </div>

      <div className="field">
        <label>Labels</label>
        <div className="chips">
          {[...new Set([...doc.settings.labels, ...item.labels])].map((l) => {
            const on = item.labels.includes(l)
            return (
              <button
                key={l}
                className={`chip ${on ? 'on' : ''}`}
                disabled={!writable}
                onClick={() =>
                  updateItem(itemId, { labels: on ? item.labels.filter((x) => x !== l) : [...item.labels, l] })
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
                  updateItem(itemId, { labels: [...new Set([...item.labels, v])] })
                  setLabelInput('')
                }
              }}
            />
          )}
        </div>
      </div>

      <div className="field">
        <label>Files ({item.fileIds.length})</label>
        {item.fileIds.map((f) => (
          <div className="row spread mb8" key={f} style={{ background: 'var(--bg-raised)', padding: '7px 10px', borderRadius: 8 }}>
            <span className="mono small" style={{ wordBreak: 'break-all' }}>{f}</span>
            <span className="row">
              <a className="btn small" href={webViewLink(f)} target="_blank" rel="noreferrer">Open in Drive</a>
              <button
                className="btn small"
                onClick={async () => {
                  try {
                    await downloadToBrowser(f, item.title)
                  } catch (e) {
                    setUploadError(describeError(e).fix)
                  }
                }}
              >
                Download
              </button>
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
              Drop a file here or click to upload → project folder on Drive
              {uploadPct !== null && (
                <div className="progress"><div style={{ width: `${uploadPct}%` }} /></div>
              )}
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
          value={item.notes}
          disabled={!writable}
          onChange={(e) => updateItem(itemId, { notes: e.target.value })}
          placeholder="Context, links, feedback…"
        />
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
            onClick={() => {
              if (confirm(`Delete "${item.title}"? It can be restored from the Archive.`)) {
                deleteItem(itemId)
                onClose()
              }
            }}
          >
            Delete
          </button>
          <CopyButton text={itemId} label="Copy item id" />
        </div>
      )}
      {session === null && banner('info', 'Viewing as guest', 'Sign in to make changes.')}
    </Modal>
  )
}
