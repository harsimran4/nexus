import { useState, useSyncExternalStore, type ReactNode } from 'react'
import { Modal } from './Modal'

/** Promise-based confirm that replaces native confirm() — themed, blocking
 *  only its own caller, with human copy. `confirmDialog` can be called from
 *  anywhere (no provider); ConfirmHost renders the active dialog and mounts
 *  once, in the Shell. */

export interface ConfirmOptions {
  title: string
  /** Body copy — say what happens in studio terms, not storage terms. */
  body?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'danger' | 'default'
  /** When set, the confirm button stays disabled until typed exactly. */
  typeToConfirm?: string
}

interface PendingConfirm {
  opts: ConfirmOptions
  resolve: (ok: boolean) => void
}

let pending: PendingConfirm | null = null
const subs = new Set<() => void>()

function emit(): void {
  for (const fn of subs) fn()
}

function settle(ok: boolean): void {
  const p = pending
  pending = null
  p?.resolve(ok)
  emit()
}

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    // A second call while one is open cancels the first — dialogs never stack.
    if (pending) pending.resolve(false)
    pending = { opts, resolve }
    emit()
  })
}

/** True while a confirm dialog is on screen. Other Escape handlers (e.g. the
 *  Media tab's select-mode exit) check this so one keypress doesn't act
 *  twice — the dialog owns that Escape. */
export function confirmIsOpen(): boolean {
  return pending !== null
}

const subscribe = (fn: () => void): (() => void) => {
  subs.add(fn)
  return () => subs.delete(fn)
}
const getSnapshot = (): PendingConfirm | null => pending
const getServerSnapshot = (): PendingConfirm | null => null

export function ConfirmHost(): React.JSX.Element | null {
  const p = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const [typed, setTyped] = useState<string | null>(null)
  if (!p) {
    // Reset the typed guard once the dialog is gone.
    if (typed !== null) setTyped(null)
    return null
  }
  const danger = p.opts.tone === 'danger'
  const blocked = p.opts.typeToConfirm !== undefined && typed !== p.opts.typeToConfirm
  return (
    <Modal title={p.opts.title} onClose={() => settle(false)}>
      {p.opts.body && <div className="confirm-body">{p.opts.body}</div>}
      {p.opts.typeToConfirm !== undefined && (
        <input
          className="input mt8"
          placeholder={`Type “${p.opts.typeToConfirm}” to confirm`}
          value={typed ?? ''}
          onChange={(e) => setTyped(e.target.value)}
          spellCheck={false}
        />
      )}
      <div className="row mt8" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={() => settle(false)}>
          {p.opts.cancelLabel ?? 'Cancel'}
        </button>
        <button
          className={`btn ${danger ? 'danger' : 'primary'}`}
          disabled={blocked}
          onClick={() => settle(true)}
        >
          {p.opts.confirmLabel ?? (danger ? 'Delete' : 'Confirm')}
        </button>
      </div>
    </Modal>
  )
}
