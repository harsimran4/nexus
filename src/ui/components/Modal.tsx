import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { motion, usePresence } from 'motion/react'
import { confirmIsOpen } from './ConfirmDialog'
import { useMaterialVariants, useOverlayTransition } from './motion'
import { lockBodyScroll, unlockBodyScroll } from './scrollLock'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** The app's one dialog primitive: backdrop + card, Escape / backdrop-mousedown
 *  close. Renders through a portal with a focus trap (Tab cycles inside),
 *  initial focus, focus restore to the opener, and body scroll-lock — additively:
 *  existing call sites keep the same props.
 *
 *  Exit runs in place: a close request flips to the exit animation (backdrop
 *  fades, card shrinks back along its entry path) and only when it settles
 *  does `onClose` actually fire and the parent unmount us — so `{open &&
 *  <Modal/>}` call sites get the exit for free, and focus/scroll-lock restore
 *  land after the animation instead of mid-flight. */
export function Modal({ title, onClose, children, wide, initialFocusRef, ownsEscape, closing: closingProp, onClosing }: {
  title: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
  initialFocusRef?: React.RefObject<HTMLElement | null>
  /** The confirm dialog's own instance: it acts on Escape even while
   *  confirmIsOpen(), because it IS the confirm. Every other modal stands
   *  down so a stacked confirm closes alone. Order-independent by design —
   *  no reliance on listener registration order. */
  ownsEscape?: boolean
  /** Parent-driven exit: true animates the dialog out, then fires onClose.
   *  ConfirmHost resolves its promise the instant a button is pressed and
   *  uses this to keep the dialog visible while it leaves. */
  closing?: boolean
  /** Fires when a close REQUEST first starts the exit (not for the
   *  parent-driven `closing` prop). ConfirmHost settles its promise here so
   *  confirmIsOpen() drops while the exit is still playing — a second Escape
   *  then reaches the modal underneath without waiting out the animation. */
  onClosing?: () => void
}): React.JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement>(null)
  const [selfClosing, setSelfClosing] = useState(false)
  const closing = closingProp || selfClosing
  // False while an AnimatePresence up the tree is playing our exit — input
  // stands down and the scrim stops swallowing clicks until unmount lands.
  const [isPresent] = usePresence()
  const card = useMaterialVariants('snappy')
  const fade = useOverlayTransition('snappy')
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const onClosingRef = useRef(onClosing)
  onClosingRef.current = onClosing

  // A parent flipping `closing` back to false means a NEW dialog is
  // superseding this one mid-exit (ConfirmHost reusing the instance) —
  // re-target the animation to "shown" instead of finishing the exit and
  // resolving the new confirm as cancelled.
  useEffect(() => {
    if (closingProp === false) setSelfClosing(false)
  }, [closingProp])

  const requestClose = useCallback((): void => {
    if (selfClosing || !isPresent) return // one close per open
    setSelfClosing(true)
    onClosingRef.current?.()
  }, [selfClosing, isPresent])

  // Focus management + scroll lock (shared, ref-counted — see scrollLock.ts),
  // both restored on unmount.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const opener = document.activeElement as HTMLElement | null
    const target = initialFocusRef?.current ?? (dialog.querySelector<HTMLElement>(FOCUSABLE) ?? dialog)
    target.focus({ preventScroll: true })

    lockBodyScroll()
    return () => {
      unlockBodyScroll()
      // The opener may be gone by the time the dialog closes (a delete flow
      // removes the card whose menu opened this dialog) — focusing a
      // detached node would silently dump keyboard focus to <body>.
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (closing || !isPresent) return // exit already running — one close per open
      // A confirm dialog stacked on top owns this Escape — other modals close
      // alone, never together with it. The confirm's own modal is the actor.
      if (e.key === 'Escape' && (ownsEscape || !confirmIsOpen())) requestClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [requestClose, ownsEscape, closing, isPresent])

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
    <motion.div
      className="modal-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: closing ? 0 : 1 }}
      exit={{ opacity: 0 }}
      transition={fade}
      style={closing || !isPresent ? { pointerEvents: 'none' } : undefined}
      onMouseDown={(e) => e.target === e.currentTarget && requestClose()}
    >
      <motion.div
        ref={dialogRef}
        className="modal"
        style={wide ? { maxWidth: 760 } : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={trapTab}
        variants={card.variants}
        initial="hidden"
        animate={closing ? 'exit' : 'shown'}
        exit="exit"
        transition={card.transition}
        onAnimationComplete={() => {
          if (closing) onCloseRef.current() // exit settled — hand back to the parent
        }}
      >
        <div className="spread mb8">
          <h2>{title}</h2>
          <button className="btn ghost small" onClick={requestClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </motion.div>
    </motion.div>,
    document.body,
  )
}
