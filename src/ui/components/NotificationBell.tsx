// Notification center bell — the digest of things that happened while you
// weren't watching (guest uploads completing and failing today; more later).
// The pop mirrors GuestUploadPill's: thin material, scales from its trigger.

import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { clearNotices, markAllRead, useNotices, useUnreadCount } from '../../state/notifications'
import { useMaterialVariants } from './motion'
import { Icon } from './Icon'

function when(at: string): string {
  const then = new Date(at).getTime()
  const mins = Math.max(0, Math.round((Date.now() - then) / 60_000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return new Date(then).toLocaleDateString()
}

export function NotificationBell(): React.JSX.Element {
  const notices = useNotices()
  const unread = useUnreadCount()
  const [open, setOpen] = useState(false)
  const pop = useMaterialVariants('snappy')

  return (
    <div className="guest-pill-wrap">
      <button
        className={`icon-btn${unread > 0 ? ' notice-bell-live' : ''}`}
        aria-label={`Notifications${unread > 0 ? ` — ${unread} unread` : ''}`}
        aria-expanded={open}
        title="Notifications"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="bell" size={15} />
        {unread > 0 && <span className="notice-dot" aria-hidden="true" />}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="notice-pop"
            role="dialog"
            aria-label="Notifications"
            style={{ transformOrigin: 'top right' }}
            variants={pop.variants}
            initial="hidden"
            animate="shown"
            exit="exit"
            transition={pop.transition}
          >
            <div className="guest-pop-head">
              <b>Notifications</b>
              <button className="icon-btn" aria-label="Close notifications" onClick={() => setOpen(false)}>
                <Icon name="x" />
              </button>
            </div>
            {notices.length === 0 ? (
              <div className="muted small" style={{ padding: '4px 0 6px' }}>
                Nothing yet — guest upload results land here.
              </div>
            ) : (
              <>
                {notices.map((n) => (
                  <div key={n.id} className="notice-row">
                    <span className={`notice-dot-inline${n.read ? ' read' : ''}`} aria-hidden="true" />
                    <div style={{ minWidth: 0 }}>
                      <div className="small" style={{ fontWeight: n.read ? 400 : 600 }}>{n.title}</div>
                      <div className="faint small">{n.body}</div>
                      <div className="faint small">{when(n.at)}</div>
                    </div>
                  </div>
                ))}
                <div className="row" style={{ justifyContent: 'space-between', paddingTop: 4 }}>
                  <button className="btn ghost small" onClick={markAllRead}>
                    Mark all read
                  </button>
                  <button className="btn ghost small" onClick={clearNotices}>
                    Clear
                  </button>
                </div>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
