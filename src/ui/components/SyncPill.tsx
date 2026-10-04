import type { ReactNode } from 'react'
import { useStore } from '../../sync/store'
import { flush } from '../../sync/writer'
import { navigate } from '../../nav'

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
      // Session expired — the login page is the one way back.
      navigate('/login')
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
