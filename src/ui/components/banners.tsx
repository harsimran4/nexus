import type { ReactNode } from 'react'
import { statusToIssue, type HealthIssue } from '../../diagnostics/health'
import { useStore } from '../../sync/store'

export function IssueBanner({ issue, onDismiss }: { issue: HealthIssue; onDismiss?: () => void }) {
  return (
    <div className={`banner ${issue.level}`} role="alert">
      <div className="body">
        <b>{issue.message}</b>
        <div className="fix">{issue.fix}</div>
      </div>
      {onDismiss && (
        <button className="btn ghost small" onClick={onDismiss}>Dismiss</button>
      )}
    </div>
  )
}

export function StatusBanners(): ReactNode {
  const status = useStore((s) => s.status)
  const detail = useStore((s) => s.statusDetail)
  const issue = statusToIssue(status, detail)
  if (!issue) return null
  return <IssueBanner issue={issue} />
}

/** One-shot inline banner — persistent conditions and section-level errors.
 *  Transient receipts belong in the toast system (Toast.tsx). */
export function banner(state: 'error' | 'warn' | 'info', message: string, fix?: string): ReactNode {
  return (
    <div className={`banner ${state}`}>
      <div className="body">
        <b>{message}</b>
        {fix && <div className="fix">{fix}</div>}
      </div>
    </div>
  )
}
