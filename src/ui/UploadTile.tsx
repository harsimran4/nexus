// Floating bottom-right tile for uploads running in the background. Mounted
// app-wide (App.tsx) so progress stays visible on any page; the batch lives
// in state/uploads.ts.

import { dismissUploads, uploadsBusy, useUploadBatch } from '../state/uploads'

export function UploadTile(): React.JSX.Element | null {
  const batch = useUploadBatch()
  if (!batch) return null

  const total = batch.files.length
  const done = batch.files.filter((f) => f.done).length
  const current = batch.files.find((f) => !f.done)
  const busy = uploadsBusy()
  const failed = batch.files.filter((f) => f.done && !f.ok).length
  const pct = total > 0 ? Math.round(batch.files.reduce((acc, f) => acc + (f.done ? 100 : f.pct), 0) / total) : 0

  return (
    <div className="upload-tile" role="status">
      <div className="spread">
        <span className="small" style={{ fontWeight: 600 }}>
          {busy ? `Uploading ${done + 1}/${total}` : 'Uploads finished'}
        </span>
        {!busy && (
          <button className="btn small ghost" aria-label="Dismiss" title="Dismiss" onClick={dismissUploads}>
            ✕
          </button>
        )}
      </div>
      <div className="upload-tile-file small faint">
        {busy ? current?.name : `${done} uploaded${failed > 0 ? ` · ${failed} failed` : ''}`}
      </div>
      <div className="progress">
        <div style={{ width: `${busy ? pct : 100}%` }} />
      </div>
    </div>
  )
}
