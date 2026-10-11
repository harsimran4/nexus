// Live guest-upload monitor for the app chrome — the owner's window into a
// share-link upload in flight. The guest page beacons coarse progress to
// progress/<linkId>.json (single-object overwrites, no doc contention); this
// pill polls it alongside the doc's 10s poll and shows per-session detail:
// what landed, what failed, how much is left. Hidden entirely when no guest
// has uploaded recently, so the chrome stays quiet otherwise.

import { useEffect, useState } from 'react'
import { uploadProgressFn } from '../../server/fns'
import type { UploadProgressSession } from '../../types/storage'
import { useStore } from '../../sync/store'
import { Icon } from './Icon'

const ACTIVE_MS = 30 * 60_000 // beacon quiet this long → the guest is gone

export function GuestUploadPill(): React.JSX.Element | null {
  const session = useStore((s) => s.session)
  const canWrite = !!session && (session.role === 'admin' || session.role === 'editor')
  const [sessions, setSessions] = useState<UploadProgressSession[] | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!canWrite) return
    let stopped = false
    const poll = async (): Promise<void> => {
      try {
        const res = await uploadProgressFn()
        if (!stopped && res.ok) setSessions(res.data)
      } catch {
        /* the pill is additive — a failed poll just leaves it stale */
      }
    }
    void poll()
    const t = setInterval(() => void poll(), 10_000)
    return () => {
      stopped = true
      clearInterval(t)
    }
  }, [canWrite])

  if (!canWrite || !sessions || sessions.length === 0) return null
  const now = Date.now()
  const active = sessions.filter((s) => s.state === 'active' && now - Date.parse(s.at) < ACTIVE_MS)
  const settled = sessions
    .filter((s) => s.state !== 'active' || now - Date.parse(s.at) >= ACTIVE_MS)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 3)
  if (active.length === 0 && settled.length === 0) return null

  const totalDone = active.reduce((n, s) => n + s.done, 0)
  const totalAll = active.reduce((n, s) => n + s.total, 0)
  const totalFailed = active.reduce((n, s) => n + s.failed, 0)

  return (
    <div className="guest-pill-wrap">
      <button
        className={`pill guest-pill ${active.length > 0 ? 'live' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title="Guest upload progress"
      >
        <Icon name="upload" size={13} />
        {active.length > 0 ? (
          <span>
            guest {totalDone}/{totalAll}
            {totalFailed > 0 ? ` · ${totalFailed} failed` : ''}
          </span>
        ) : (
          <span>guest uploads</span>
        )}
      </button>
      {open && (
        <div className="guest-pop card" role="dialog" aria-label="Guest upload progress">
          <div className="guest-pop-head">
            <b>Guest uploads</b>
            <button className="icon-btn" aria-label="Close" onClick={() => setOpen(false)}>
              <Icon name="x" />
            </button>
          </div>
          {active.map((s) => (
            <GuestRow key={s.linkId} s={s} now={now} />
          ))}
          {active.length === 0 && <div className="guest-pop-none muted small">No upload in progress right now.</div>}
          {settled.length > 0 && (
            <>
              <div className="guest-pop-sep faint small">recently finished</div>
              {settled.map((s) => (
                <GuestRow key={s.linkId} s={s} now={now} />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function GuestRow({ s, now }: { s: UploadProgressSession; now: number }): React.JSX.Element {
  const done = s.state === 'active' && now - Date.parse(s.at) >= ACTIVE_MS
  const pct = s.total > 0 ? Math.round(((s.done + s.failed) / s.total) * 100) : 0
  return (
    <div className="guest-row">
      <div className="guest-row-top">
        <b className="guest-row-name">{s.projectName ?? 'A project'}</b>
        <span className={`chip ${done || s.state === 'complete' ? 'on' : s.state === 'failed' ? '' : 'on'}`}>
          {s.state === 'complete' ? '✓ complete' : s.state === 'failed' ? 'ended with failures' : done ? 'stalled?' : 'uploading'}
        </span>
      </div>
      <div className="guest-row-mid small">
        {s.done} of {s.total} saved
        {s.failed > 0 ? ` · ${s.failed} failed` : ''}
        {s.repaired ? ` · ${s.repaired} repaired at the end` : ''}
        {s.state === 'active' && !done ? ' · still transferring' : ''}
      </div>
      <div className="guest-row-bar">
        <div className="guest-row-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="faint small">last update {new Date(s.at).toLocaleTimeString()}</div>
    </div>
  )
}
