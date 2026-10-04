import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { confirmIsOpen } from './ConfirmDialog'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** The app's one dialog primitive: backdrop + card, Escape / backdrop-mousedown
 *  close. Renders through a portal with a focus trap (Tab cycles inside),
 *  initial focus, focus restore to the opener, and body scroll-lock — additively:
 *  existing call sites keep the same props. */
export function Modal({ title, onClose, children, wide, initialFocusRef }: {
  title: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
  initialFocusRef?: React.RefObject<HTMLElement | null>
}): React.JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement>(null)

  // Focus management + scroll lock, both restored on unmount.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const opener = document.activeElement as HTMLElement | null
    const target = initialFocusRef?.current ?? (dialog.querySelector<HTMLElement>(FOCUSABLE) ?? dialog)
    target.focus({ preventScroll: true })

    const scrollbar = window.innerWidth - document.documentElement.clientWidth
    const prevOverflow = document.body.style.overflow
    const prevPad = document.body.style.paddingRight
    document.body.style.overflow = 'hidden'
    if (scrollbar > 0) document.body.style.paddingRight = `${scrollbar}px`
    return () => {
      document.body.style.overflow = prevOverflow
      document.body.style.paddingRight = prevPad
      // The opener may be gone by the time the dialog closes (a delete flow
      // removes the card whose menu opened this dialog) — focusing a
      // detached node would silently dump keyboard focus to <body>.
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A confirm dialog stacked on top owns this Escape — it closes alone,
      // not the dialog beneath it (every Modal listens on window).
      if (e.key === 'Escape' && !confirmIsOpen()) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Tab cycles inside the dialog.
  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !dialogRef.current) return
    const focusables = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    )
    if (focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = document.activeElement
    if (e.shiftKey && (active === first || active === dialogRef.current)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }

  // The build-time prerender has no document to portal into; modals only ever
  // render from user interaction, but guard anyway so a stray one can't crash
  // the prerender.
  if (typeof document === 'undefined') return null

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialogRef}
        className="modal"
        style={wide ? { maxWidth: 760 } : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={trapTab}
      >
        <div className="spread mb8">
          <h2>{title}</h2>
          <button className="btn ghost small" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  )
}
