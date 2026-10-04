// Floating bottom-right tile for uploads running in the background. Mounted
// app-wide (Shell) so progress stays visible on any page; the batch lives
// in state/uploads.ts. Rows render through the shared UploadRoster; the
// footer wires cancel (mid-run) and retry-all/dismiss (finished).

import {
  cancelUploadBatch,
  dismissUploads,
  retryFailedUploads,
  retryUploadEntry,
  useUploadBatch,
  uploadsBusy,
} from '../state/uploads'
import { UploadRoster } from './components/UploadRoster'

export function UploadTile(): React.JSX.Element | null {
  const batch = useUploadBatch()
  if (!batch) return null

  const total = batch.files.length
  const done = batch.files.filter((f) => f.done).length
  const inFlight = batch.files.filter((f) => f.started && !f.done).length
  const busy = uploadsBusy()
  const failedIdx = batch.files.flatMap((f, i) => (f.done && f.ok === false ? [i] : []))
  // Same sniff retryFailedUploads makes: a cancel writes 'Cancelled'/'Upload
  // cancelled' into err — the headline should say so rather than claim victory.
  const cancelled = failedIdx.some((i) => /cancel/i.test(batch.files[i].err ?? ''))

  return (
    <div className="upload-tile" role="status" aria-live="polite">
      <div className="spread">
        <span className="small" style={{ fontWeight: 600 }}>
          {busy ? `Uploading ${done}/${total} · ${inFlight} parallel` : cancelled ? 'Uploads cancelled' : 'Uploads finished'}
        </span>
      </div>
      <div className="upload-tile-list">
        <UploadRoster compact entries={batch.files} onRetry={retryUploadEntry} maxHeight={176} />
      </div>
      <div className="row mt8" style={{ justifyContent: 'flex-end' }}>
        {busy ? (
          <button className="btn small" onClick={cancelUploadBatch}>
            Cancel
          </button>
        ) : failedIdx.length > 0 ? (
          <>
            {/* retryFailedUploads walks the failed entries one run at a time
                and honours a mid-walk cancel; the store's emits re-render
                the headline between runs. */}
            <button className="btn small" onClick={() => void retryFailedUploads()}>
              Retry failed
            </button>
            <button className="btn small ghost" onClick={dismissUploads}>
              Dismiss
            </button>
          </>
        ) : (
          <button className="btn small ghost" onClick={dismissUploads}>
            Dismiss
          </button>
        )}
      </div>
    </div>
  )
}
