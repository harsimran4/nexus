import { useEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Icon } from './Icon'
import { useOverlayTransition } from './motion'

/** Lightweight receipt system: toast = receipt (auto-dismisses), banner =
 *  persistent condition. Module store — no provider; call `toast()` from
 *  anywhere. Errors stay until dismissed so they can't scroll by unseen. */

export interface ToastItem {
  id: number
  tone: 'success' | 'error' | 'info'
  msg: string
  fix?: string
  action?: { label: string; onClick: () => void }
}

const AUTO_DISMISS: Record<ToastItem['tone'], number | null> = { success: 4500, info: 6000, error: null }

let items: ToastItem[] = []
let nextId = 1
const subs = new Set<() => void>()
const timers = new Map<number, ReturnType<typeof setTimeout>>()

function emit(): void {
  for (const fn of subs) fn()
}

function dismiss(id: number): void {
  const t = timers.get(id)
  if (t) clearTimeout(t)
  timers.delete(id)
  const next = items.filter((x) => x.id !== id)
  if (next.length === items.length) return
  items = next
  emit()
}

export function toast(msg: string, opts: Partial<Pick<ToastItem, 'tone' | 'fix' | 'action'>> = {}): number {
  const item: ToastItem = { id: nextId++, tone: opts.tone ?? 'info', msg, fix: opts.fix, action: opts.action }
  items = [...items.slice(-4), item] // keep the last few; receipts are ephemeral
  emit()
  const ttl = AUTO_DISMISS[item.tone]
  if (ttl !== null) timers.set(item.id, setTimeout(() => dismiss(item.id), ttl))
  return item.id
}
toast.success = (msg: string) => toast(msg, { tone: 'success' })
toast.error = (msg: string, fix?: string) => toast(msg, { tone: 'error', fix })
toast.info = (msg: string) => toast(msg, { tone: 'info' })
toast.dismiss = dismiss

const subscribe = (fn: () => void): (() => void) => {
  subs.add(fn)
  return () => subs.delete(fn)
}
const EMPTY: ToastItem[] = []
const getSnapshot = (): ToastItem[] => items
const getServerSnapshot = (): ToastItem[] => EMPTY

const TONE_ICON = { success: 'check', error: 'alert', info: 'clock' } as const

export function ToastViewport(): React.JSX.Element | null {
  const list = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const reduce = useReducedMotion()
  const transition = useOverlayTransition('snappy')
  // The viewport must NOT render during SSR or hydration: a `typeof document`
  // branch here (server null, client div) is a hydration mismatch that fails
  // the WHOLE tree and regenerates it client-side — which is what used to
  // wipe html[data-theme] and flip dark mode off on every full load. Instead
  // the viewport appears right after mount — long before any toast can
  // exist (they're user-triggered), so the live region still precedes its
  // first message for screen readers.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return null
  return createPortal(
    <div className="toast-viewport" role="status" aria-live="polite">
      <AnimatePresence initial={false}>
        {list.map((t) => (
          <motion.div
            key={t.id}
            className={`toast toast-${t.tone}`}
            role={t.tone === 'error' ? 'alert' : undefined}
            /* receipts drop in from the top edge and leave the same way */
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.97 }}
            transition={transition}
          >
            <span className="toast-ic">
              <Icon name={TONE_ICON[t.tone]} size={14} />
            </span>
            <div className="toast-body">
              <span>{t.msg}</span>
              {t.fix && <div className="toast-fix">{t.fix}</div>}
              {t.action && (
                <button
                  className="toast-action"
                  onClick={() => {
                    t.action?.onClick()
                    dismiss(t.id)
                  }}
                >
                  {t.action.label}
                </button>
              )}
            </div>
            <button className="toast-x" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              <Icon name="x" size={13} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>,
    document.body,
  )
}
