import { useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'

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
  if (typeof document === 'undefined') return null
  // The viewport mounts EMPTY and stays mounted: a live region that appears
  // together with its first message is routinely skipped by screen readers.
  return createPortal(
    <div className="toast-viewport" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`} role={t.tone === 'error' ? 'alert' : undefined}>
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
        </div>
      ))}
    </div>,
    document.body,
  )
}
