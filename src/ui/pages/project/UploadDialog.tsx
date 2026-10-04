import { useEffect, useRef, useState } from 'react'
import { Modal } from '../../components/Modal'
import { toast } from '../../components/Toast'
import { UploadRoster } from '../../components/UploadRoster'
import { cancelUploadBatch, dismissUploads, retryFailedUploads, retryUploadEntry, startUploadBatch, useUploadBatch } from '../../../state/uploads'
import type { MediaSection } from '../../../types/schema'

/** Upload modal — explicit target choice + queue visibility. Success closes
 *  itself; failures stay open with Retry buttons so they can't scroll by
 *  unseen (the corner tile mirrors the same roster for when you leave). */
export function UploadDialog({ projectId, sections, target, onTargetChange, onClose }: {
  projectId: string
  sections: MediaSection[]
  /** Current target section id ('' = Unsorted). */
  target: string
  onTargetChange: (id: string) => void
  onClose: () => void
}): React.JSX.Element {
  const batch = useUploadBatch()
  const here = batch !== null && batch.projectId === projectId ? batch : null
  const busy = here !== null && here.files.some((u) => !u.done)
  const failed = here ? here.files.filter((u) => u.done && !u.ok).length : 0
  const [dragOver, setDragOver] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  // Auto-close on an ALL-good batch (failures keep it open, with Retry).
  useEffect(() => {
    if (!here || busy || failed > 0) return
    const t = setTimeout(() => {
      onClose()
      dismissUploads()
    }, 1200)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [here, busy, failed])

  const start = (files: File[]) => {
    if (files.length === 0) return
    // Another tab-wide batch may still be running — say so instead of
    // silently swallowing the drop.
    if (!startUploadBatch(projectId, files, target || null)) {
      toast.error('An upload is already running', 'Wait for it to finish or cancel it first.')
    }
  }

  return (
    <Modal title="Upload media" onClose={onClose}>
      <div className="field">
        <label>Upload to</label>
        <select
          className="input"
          value={target}
          disabled={busy}
          onChange={(e) => onTargetChange(e.target.value)}
        >
          <option value="">Unsorted</option>
          {sections.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </div>
      <div
        role="button"
        tabIndex={0}
        aria-label="Drop media here or press Enter to choose files"
        className={`dropzone${dragOver ? ' drag' : ''}`}
        onClick={() => fileInput.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            fileInput.current?.click()
          }
        }}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          start(Array.from(e.dataTransfer.files))
        }}
      >
        {here ? (
          <div className="upload-dialog-roster">
            <div className="small muted">
              {here.files.filter((u) => u.done).length}/{here.files.length} uploaded
              {busy ? ` · ${here.files.filter((u) => u.started && !u.done).length} in parallel` : ''}
            </div>
            <UploadRoster
              entries={here.files}
              onRetry={failed > 0 && !busy ? retryUploadEntry : undefined}
              maxHeight={190}
            />
          </div>
        ) : (
          <div>
            Drop media here or click to upload
            <div className="faint upload-dialog-hint">
              up to 3 files upload in parallel, straight to storage — the app keeps working while they run
            </div>
          </div>
        )}
      </div>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          start(Array.from(e.target.files ?? []))
          e.target.value = ''
        }}
      />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        {busy && (
          <button className="btn" onClick={cancelUploadBatch}>
            Cancel upload
          </button>
        )}
        {!busy && here && failed > 0 && (
          <button className="btn primary" onClick={() => void retryFailedUploads()}>
            Retry failed ({failed})
          </button>
        )}
        <button className="btn ghost" onClick={onClose}>Close</button>
      </div>
    </Modal>
  )
}
