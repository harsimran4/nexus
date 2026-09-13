import { useEffect, useRef, useState, type ReactNode } from 'react'
import { statusBucket, statusLabel, type NexusDoc } from '../types/schema'
import { useStore } from '../sync/store'
import { statusToIssue, type HealthIssue } from '../diagnostics/health'
import { commit, flush } from '../sync/writer'
import { clearToken, requestToken } from '../auth/tokenClient'

/**
 * Merge rapid mutations (typing in an input) into ONE commit after the user
 * pauses. Every keystroke calling commit() directly floods the activity log
 * and churns Drive revisions.
 */
export function useDebouncedCommit(delay = 800): (fn: (doc: NexusDoc) => void) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<((doc: NexusDoc) => void) | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )
  return (fn) => {
    pending.current = fn
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const p = pending.current
      pending.current = null
      timer.current = null
      if (p) commit(p)
    }, delay)
  }
}

// ---- modal ----------------------------------------------------------------

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={wide ? { maxWidth: 760 } : undefined}>
        <div className="spread mb8">
          <h2>{title}</h2>
          <button className="btn ghost small" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

// ---- banners ---------------------------------------------------------------

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

// ---- sync pill -------------------------------------------------------------

const STATUS_LABEL: Record<string, string> = {
  booting: 'Connecting…',
  ok: 'Synced',
  saving: 'Saving…',
  queued: 'Queued',
  reconnect: 'Reconnect',
  readOnly: 'Read-only',
  blocked: 'Blocked',
  corrupt: 'Needs repair',
  needsInit: 'Setup',
  needsReset: 'Reset needed',
}

export function SyncPill(): ReactNode {
  const status = useStore((s) => s.status)
  const pendingCount = useStore((s) => s.pendingCount)
  const lastSyncAt = useStore((s) => s.lastSyncAt)
  const cls = ['pill', status].join(' ')
  const label =
    pendingCount > 0 && (status === 'ok' || status === 'saving')
      ? `${pendingCount} change${pendingCount === 1 ? '' : 's'} · syncing…`
      : STATUS_LABEL[status] ?? status
  const time = lastSyncAt ? new Date(lastSyncAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null
  const onClick = () => {
    if (status === 'queued') void flush()
    if (status === 'reconnect') {
      // Click is a user gesture: drop the dead token and mint a fresh one
      // (direct popup — no silent attempt to lose the gesture context).
      clearToken()
      void requestToken()
    }
  }
  return (
    <button
      className={cls}
      style={{ cursor: status === 'reconnect' || status === 'queued' ? 'pointer' : 'default', font: 'inherit' }}
      onClick={onClick}
      title={time ? `Last synced ${time}` : undefined}
    >
      <span className="dot" />
      {label}
    </button>
  )
}

// ---- badges -----------------------------------------------------------------

export function StatusBadge({ doc, status }: { doc: NexusDoc; status: string }) {
  const bucket = statusBucket(doc, status)
  return <span className={`badge ${bucket}`}>{statusLabel(doc, status)}</span>
}

export function KindBadge({ kind }: { kind: string }) {
  return <span className="badge kind">{kind}</span>
}

// ---- empty state -------------------------------------------------------------

export function Empty({ icon = '◎', children }: { icon?: string; children: ReactNode }) {
  return (
    <div className="empty">
      <div className="big">{icon}</div>
      <div>{children}</div>
    </div>
  )
}

// ---- clipboard ---------------------------------------------------------------

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="btn small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
        } catch {
          const ta = document.createElement('textarea')
          ta.value = text
          document.body.appendChild(ta)
          ta.select()
          document.execCommand('copy')
          ta.remove()
        }
        setDone(true)
        setTimeout(() => setDone(false), 1600)
      }}
    >
      {done ? '✓ Copied' : label}
    </button>
  )
}

/** Show-once reveal for minted tokens — the raw secret never appears again. */
export function TokenReveal({ raw, kind, link }: { raw: string; kind: 'token' | 'password'; link?: string }) {
  return (
    <div>
      <p className="muted small">
        {kind === 'token'
          ? 'This access token is shown ONCE — copy it now. Only its hash is stored, it cannot be recovered later.'
          : 'Password set. Share it through a safe channel — only its hash is stored.'}
      </p>
      <div className="token-box">{raw}</div>
      <div className="row mt8">
        <CopyButton text={raw} label="Copy secret" />
        {link && <CopyButton text={link} label="Copy login link" />}
      </div>
      {link && (
        <p className="faint small mt8" style={{ wordBreak: 'break-all' }}>{link}</p>
      )}
    </div>
  )
}

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
