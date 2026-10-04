// Floating bottom-right tile for uploads running in the background. Mounted
// app-wide (App.tsx) so progress stays visible on any page; the batch lives
// in state/uploads.ts. Up to UPLOAD_CONCURRENCY files transfer at once; the
// roster shows EVERY file in the batch with its state (queued / percent /
// ✓ / ✗) so a big drop stays legible.

import { dismissUploads, uploadsBusy, useUploadBatch } from '../state/uploads'

export function UploadTile(): React.JSX.Element | null {
  const batch = useUploadBatch()
  if (!batch) return null

  const total = batch.files.length
  const done = batch.files.filter((f) => f.done).length
  const inFlight = batch.files.filter((f) => f.started && !f.done).length
  const busy = uploadsBusy()
  const pct = total > 0 ? Math.round(batch.files.reduce((acc, f) => acc + (f.done ? 100 : f.pct), 0) / total) : 0

  return (
    <div className="upload-tile" role="status">
      <div className="spread">
        <span className="small" style={{ fontWeight: 600 }}>
          {busy ? `Uploading ${done}/${total} · ${inFlight} parallel` : 'Uploads finished'}
        </span>
        {!busy && (
          <button className="btn small ghost" aria-label="Dismiss" title="Dismiss" onClick={dismissUploads}>
            ✕
          </button>
        )}
      </div>
      <div className="upload-tile-list">
        {batch.files.map((f, i) => (
          <div key={i} className="upload-tile-row">
            <div className="spread small">
              <span className={`upload-tile-file${f.done && !f.ok ? ' upload-tile-fail' : ''}`} title={f.err ?? f.name}>
                {f.done ? (f.ok ? '✓ ' : '✗ ') : !f.started ? '· ' : ''}
                {f.name}
              </span>
              <span className="muted">{f.done ? (f.ok ? 'done' : 'failed') : f.started ? `${f.pct}%` : 'queued'}</span>
            </div>
            {f.started && !f.done && (
              <div className="progress">
                <div style={{ width: `${f.pct}%` }} />
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="progress">
        <div style={{ width: `${busy ? pct : 100}%` }} />
      </div>
    </div>
  )
}
