import { useEffect, useRef, useState, type ReactNode } from 'react'
import { statusBucket, statusLabel, type NexusDoc } from '../types/schema'
import { useStore } from '../sync/store'
import { statusToIssue, type HealthIssue } from '../diagnostics/health'
import { commit, flush } from '../sync/writer'
import { clearToken, requestToken, getBearerToken } from '../auth/tokenClient'
import { connectWorkspace } from '../auth/connect'
import { relayConfigured } from '../auth/relay'

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
  const needConnect = useStore((s) => s.needConnect)
  const nexusFileId = useStore((s) => s.doc?.ids.nexusFileId ?? null)
  if (status === 'blocked' && needConnect && nexusFileId) {
    return <ConnectBanner expectedNexusFileId={nexusFileId} />
  }
  const issue = statusToIssue(status, detail)
  if (!issue) return null
  return <IssueBanner issue={issue} />
}

/** The editor path: Google is signed in with an account whose drive.file
 *  grant can't see the workspace (it lives in the studio account's Drive).
 *  The editor connects their OWN account to the shared folder — one-time
 *  picker pick; Google persists the grant for that (user, app) pair. */
function ConnectBanner({ expectedNexusFileId }: { expectedNexusFileId: string }): ReactNode {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const run = async () => {
    setBusy(true)
    setErr(null)
    try {
      const result = await connectWorkspace(expectedNexusFileId)
      if (result === 'connected') {
        useStore.getState().setNeedConnect(false)
        useStore.getState().setStatus('saving', 'Connected — syncing…')
        const ok = await flush() // push the queued edits through the new grant
        if (!ok) {
          useStore.getState().setStatus('queued', 'Connected, but the sync did not finish — your changes stay queued; click the status pill to retry.')
        }
      } else if (result === 'wrongFolder') {
        setErr("That folder doesn't hold this workspace's nexus.json — pick the Nexus Root folder the studio shared with you.")
      } else if (result === 'noGrant') {
        setErr('The folder is right, but Google has not unlocked it for your account yet — this usually clears within a minute. Click Connect workspace folder again.')
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Connect failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="banner error" role="alert">
      <div className="body">
        <b>Google can&apos;t see the workspace from the signed-in account</b>
        <div className="fix">
          The workspace lives in the studio account&apos;s Drive. Your Nexus login is separate — it decides your role.
          Click Connect and pick the Nexus Root folder that was shared with your Google account (one-time).
        </div>
        {err && <div className="fix" style={{ color: 'var(--red)' }}>{err}</div>}
      </div>
      <button className="btn small" disabled={busy} onClick={() => void run()}>
        {busy ? 'Connecting…' : 'Connect workspace folder'}
      </button>
    </div>
  )
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
      // Relay-only editor (no Google session by design): the fix is a Nexus
      // re-login, not a Google popup — send them to the login page.
      if (getBearerToken() === null && relayConfigured()) {
        void import('../App').then((m) => m.navigate('login'))
        return
      }
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

// ---------------------------------------------------------------------------
// Page quotes — one quiet serif line per section, picked fresh each visit.
// ---------------------------------------------------------------------------

const QUOTES: Record<string, { text: string; by: string }[]> = {
  board: [
    { text: 'Plans are worthless, but planning is everything.', by: 'Dwight D. Eisenhower' },
    { text: 'The secret of getting ahead is getting started.', by: 'Mark Twain' },
    { text: 'Vision without execution is just hallucination.', by: 'Thomas Edison' },
  ],
  groups: [
    { text: 'Out of clutter, find simplicity.', by: 'Albert Einstein' },
    { text: 'For every minute spent organizing, an hour is earned.', by: 'Benjamin Franklin' },
    { text: 'The ability to simplify means to eliminate the unnecessary.', by: 'Hans Hofmann' },
  ],
  scripts: [
    { text: 'The first draft is just you telling yourself the story.', by: 'Terry Pratchett' },
    { text: 'Get it down. Take chances. It may be bad, but it’s the only way you can do anything really good.', by: 'William Faulkner' },
    { text: 'You can’t wait for inspiration. You have to go after it with a club.', by: 'Jack London' },
  ],
  project: [
    { text: 'Cinema is truth twenty-four times per second.', by: 'Jean-Luc Godard' },
    { text: 'Art is never finished, only abandoned.', by: 'Leonardo da Vinci' },
    { text: 'Everything you can imagine is real.', by: 'Pablo Picasso' },
  ],
  archive: [
    { text: 'The past is never dead. It’s not even past.', by: 'William Faulkner' },
    { text: 'Those who cannot remember the past are condemned to repeat it.', by: 'George Santayana' },
    { text: 'Real museums are places where time is transformed into space.', by: 'Orhan Pamuk' },
  ],
  login: [
    { text: 'The way to get started is to quit talking and begin doing.', by: 'Walt Disney' },
    { text: 'Every artist was first an amateur.', by: 'Ralph Waldo Emerson' },
    { text: 'Start where you are. Use what you have. Do what you can.', by: 'Arthur Ashe' },
  ],
}

export type QuoteTopic = keyof typeof QUOTES

export function PageQuote({ topic }: { topic: QuoteTopic }): ReactNode {
  const pool = QUOTES[topic]
  if (!pool || pool.length === 0) return null
  const pick = pool[Math.floor(Math.random() * pool.length)]
  return (
    <div className="page-quote">
      <span className="q">{pick.text}</span>
      <span className="by">— {pick.by}</span>
    </div>
  )
}
