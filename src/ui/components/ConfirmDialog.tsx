import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Modal } from './Modal'

/** Promise-based confirm that replaces native confirm() — themed, blocking
 *  only its own caller, with human copy. `confirmDialog` can be called from
 *  anywhere (no provider); ConfirmHost renders the active dialog and mounts
 *  once, in the Shell. The promise settles the moment a button is pressed
 *  (callers unblock immediately); the dialog itself stays on screen through
 *  its exit animation via Modal's `closing` prop, then unmounts. */

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
  const inputRef = useRef<HTMLInputElement>(null)
  // What's on screen: the pending confirm, or — after it settled — the same
  // dialog kept mounted for its exit (cleared when Modal fires onClose).
  const [shown, setShown] = useState<ConfirmOptions | null>(null)
  useEffect(() => {
    if (p) setShown(p.opts)
  }, [p])

  if (!shown) {
    // Reset the typed guard once the dialog is gone.
    if (typed !== null) setTyped(null)
    return null
  }
  const danger = shown.tone === 'danger'
  const blocked = shown.typeToConfirm !== undefined && typed !== shown.typeToConfirm
  return (
    // ownsEscape: the confirm closes on Escape — Modal's guard stands every
    // OTHER modal down while this one is up, so one keypress closes the
    // confirm alone no matter what re-rendered underneath it.
    <Modal
      title={shown.title}
      closing={p === null}
      onClosing={() => {
        // Escape/backdrop/✕ start the exit — settle now so confirmIsOpen()
        // drops and the modal underneath can act without waiting out the
        // animation (the dialog stays painted via `closing`).
        if (p) settle(false)
      }}
      onClose={() => {
        setShown(null)
        if (p) settle(false)
      }}
      ownsEscape
      initialFocusRef={shown.typeToConfirm !== undefined ? inputRef : undefined}
    >
      {shown.body && <div className="confirm-body">{shown.body}</div>}
      {shown.typeToConfirm !== undefined && (
        <input
          ref={inputRef}
          className="input mt8"
          placeholder={`Type “${shown.typeToConfirm}” to confirm`}
          value={typed ?? ''}
          onChange={(e) => setTyped(e.target.value)}
          spellCheck={false}
          autoCapitalize="none"
          autoComplete="off"
        />
      )}
      <div className="row mt8" style={{ justifyContent: 'flex-end' }}>
        {/* Buttons settle the promise immediately (callers unblock); the
            `closing` prop keeps the dialog painted through its exit, and
            Modal's post-exit onClose clears `shown`. */}
        <button className="btn" onClick={() => settle(false)}>
          {shown.cancelLabel ?? 'Cancel'}
        </button>
        <button
          className={`btn ${danger ? 'danger' : 'primary'}`}
          disabled={blocked}
          onClick={() => settle(true)}
        >
          {shown.confirmLabel ?? (danger ? 'Delete' : 'Confirm')}
        </button>
      </div>
    </Modal>
  )
}
