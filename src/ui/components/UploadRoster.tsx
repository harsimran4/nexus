// One roster renderer for every upload list: state icon, name, right-aligned
// status word, and a 3px bar under active rows. The floating tile renders it
// compact; other surfaces pass their own entries and retry hook.

import { Icon } from './Icon'
import './UploadRoster.css'

export interface RosterEntry {
  name: string
  pct: number
  started?: boolean
  done?: boolean
  ok?: boolean
  err?: string
}

/** A failure that's really a cancel — done+!ok either way, so the status
 *  word reads the error text the batch store writes ('Cancelled' for queued
 *  entries, 'Upload cancelled' from the abort path). */
const isCancelledEntry = (e: RosterEntry): boolean =>
  e.done === true && e.ok === false && typeof e.err === 'string' && /cancel/i.test(e.err)

export function UploadRoster({ entries, onRetry, compact, maxHeight }: {
  entries: RosterEntry[]
  /** when provided, failed rows get a Retry button */
  onRetry?: (index: number) => void
  /** tighter rows for the corner tile */
  compact?: boolean
  /** scroll cap for the list */
  maxHeight?: number
}): React.JSX.Element {
  return (
    <div
      className={`upload-roster${compact ? ' compact' : ''}`}
      style={maxHeight !== undefined ? { maxHeight } : undefined}
    >
      {entries.map((e, i) => {
        const state = e.done ? (e.ok ? 'ok' : 'bad') : e.started ? 'run' : 'wait'
        const word = e.done
          ? e.ok
            ? 'done'
            : isCancelledEntry(e)
              ? 'cancelled'
              : 'failed'
          : e.started
            ? `${e.pct}%`
            : 'queued'
        const failed = e.done === true && e.ok === false
        return (
          <div key={i} className="upload-roster-row">
            <div className="upload-roster-line">
              <Icon
                name={state === 'ok' ? 'check' : state === 'bad' ? 'alert' : state === 'run' ? 'refresh' : 'clock'}
                size={compact ? 13 : 14}
                className={`upload-roster-icon ${state}`}
              />
              <span className="upload-roster-name" title={e.err ?? e.name}>
                {e.name}
              </span>
              <span className={`upload-roster-word${failed && !isCancelledEntry(e) ? ' bad' : ''}`}>{word}</span>
            </div>
            {e.started && !e.done && (
              <div className="upload-roster-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={e.pct}>
                <div style={{ width: `${e.pct}%` }} />
              </div>
            )}
            {failed && e.err && (
              <span className="upload-roster-err" title={e.err}>
                {e.err}
              </span>
            )}
            {failed && onRetry && (
              <button className="btn small ghost upload-roster-retry" onClick={() => onRetry(i)}>
                <Icon name="refresh" size={12} /> Retry
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
