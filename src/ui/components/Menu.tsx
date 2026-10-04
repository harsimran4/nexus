import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from './Icon'
import './Menu.css'

/** Dropdown menu for card overflow actions (the "..." on a media card). The
 *  trigger is the caller's own button — Menu only forwards the ref plus the
 *  click/aria props through the render prop. The panel renders through a
 *  PORTAL positioned from the trigger's viewport rect: it must escape the
 *  media card's thumb well (overflow:hidden) and any content-visibility paint
 *  containment, which would otherwise clip it to a sliver. It hangs below the
 *  trigger, flipping above when the trigger sits near the viewport floor.
 *  Arrow keys move real DOM focus between enabled items, Enter/Space activate
 *  (items are real buttons), Escape closes back to the trigger — stopped
 *  there so a Modal behind the menu stays open — and Tab falls through. */

interface MenuContextValue {
  open: boolean
  /** Close the menu; refocusTrigger also hands focus back to the trigger. */
  close: (refocusTrigger: boolean) => void
}

const MenuContext = createContext<MenuContextValue | null>(null)

/** Enabled items only — native `disabled` already keeps an item out of click
 *  and tab order, the selector also keeps it out of the arrow-key roving. */
const enabledItems = (panel: HTMLElement | null): HTMLButtonElement[] =>
  Array.from(panel?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [])

/** Viewport floor (px) under the trigger before the panel flips above. */
const FLIP_FLOOR = 150
/** Horizontal margin the panel keeps from the viewport edges. */
const EDGE = 8

export function Menu({ trigger, align = 'end', label, children }: {
  trigger: (p: {
    ref: (el: HTMLButtonElement | null) => void
    onClick: (e: React.MouseEvent) => void
    'aria-expanded': boolean
    'aria-haspopup': 'menu'
  }) => ReactNode
  align?: 'start' | 'end'
  label?: string
  children: ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  // Fixed-position coordinates, measured from the trigger once per open.
  const [pos, setPos] = useState<{ css: React.CSSProperties; dropUp: boolean } | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // Where the open effect lands focus — ArrowUp opens on the last item.
  const openFocus = useRef<'first' | 'last'>('first')

  const setTrigger = useCallback((el: HTMLButtonElement | null) => {
    triggerRef.current = el
  }, [])

  const close = useCallback((refocusTrigger: boolean) => {
    setOpen(false)
    if (refocusTrigger) triggerRef.current?.focus({ preventScroll: true })
  }, [])

  const openMenu = useCallback((focus: 'first' | 'last' = 'first') => {
    const el = triggerRef.current
    openFocus.current = focus
    if (!el) {
      setPos(null)
      setOpen(true)
      return
    }
    // Measured once per open; a later resize re-decides on the next open.
    const r = el.getBoundingClientRect()
    const dropUp = window.innerHeight - r.bottom < FLIP_FLOOR
    const vertical = dropUp
      ? { bottom: window.innerHeight - r.top + 4 }
      : { top: r.bottom + 4 }
    // Keep the panel on-screen horizontally even for edge cards.
    const side = align === 'end'
      ? { right: Math.max(EDGE, window.innerWidth - r.right) }
      : { left: Math.min(r.left, window.innerWidth - 190) }
    setPos({ css: { position: 'fixed', ...vertical, ...side }, dropUp })
    setOpen(true)
  }, [align])

  // Land focus on the first (or last) enabled item once the panel mounts.
  useEffect(() => {
    if (!open) return
    const items = enabledItems(panelRef.current)
    ;(openFocus.current === 'last' ? items[items.length - 1] : items[0])?.focus({ preventScroll: true })
  }, [open])

  // Click-outside closes while open. Both the trigger's wrapper and the
  // portaled panel count as inside, so a second click on the trigger toggles
  // closed through its own onClick instead of racing close-then-reopen.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target instanceof Node ? e.target : null
      const inside = (t && wrapperRef.current?.contains(t)) || (t && panelRef.current?.contains(t))
      if (!inside) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const items = enabledItems(panelRef.current)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) {
        openMenu(e.key === 'ArrowUp' ? 'last' : 'first')
        return
      }
      const idx = items.indexOf(document.activeElement as HTMLButtonElement)
      const step = e.key === 'ArrowDown' ? 1 : -1
      const next = idx < 0
        ? (step === 1 ? items[0] : items[items.length - 1])
        : items[(idx + step + items.length) % items.length]
      next?.focus({ preventScroll: true })
    } else if (open && (e.key === 'Home' || e.key === 'End')) {
      e.preventDefault()
      ;(e.key === 'Home' ? items[0] : items[items.length - 1])?.focus({ preventScroll: true })
    } else if (open && e.key === 'Escape') {
      // Ours first — keep the event from closing a Modal behind this menu.
      e.stopPropagation()
      close(true)
    } else if (open && e.key === 'Tab') {
      close(false) // let Tab carry focus out of the menu
    }
    // Enter/Space need nothing here: real buttons activate natively.
  }

  const panel = open ? (
    <div
      ref={panelRef}
      role="menu"
      aria-label={label}
      className={`menu-panel${align === 'start' ? ' menu-start' : ''}${pos?.dropUp ? ' menu-up' : ''}`}
      style={pos?.css}
      onKeyDown={onKeyDown}
    >
      <MenuContext.Provider value={{ open, close }}>{children}</MenuContext.Provider>
    </div>
  ) : null

  return (
    <div ref={wrapperRef} className="menu" onKeyDown={onKeyDown}>
      {trigger({
        ref: setTrigger,
        onClick: () => (open ? close(false) : openMenu('first')),
        'aria-expanded': open,
        'aria-haspopup': 'menu',
        // `label` names the trigger for AT; it rides along past the four
        // props the render-prop type guarantees.
        ...(label !== undefined ? { 'aria-label': label } : {}),
      })}
      {panel && (typeof document === 'undefined' ? panel : createPortal(panel, document.body))}
    </div>
  )
}

export function MenuItem({ icon, tone, disabled, onSelect, children }: {
  icon?: IconName
  tone?: 'danger'
  disabled?: boolean
  onSelect: () => void
  children: ReactNode
}): React.JSX.Element {
  const menu = useContext(MenuContext)
  return (
    <button
      type="button"
      role="menuitem"
      className={`menu-item${tone === 'danger' ? ' danger' : ''}`}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (disabled) return
        onSelect()
        menu?.close(true) // action runs first, then close + focus the trigger
      }}
    >
      {icon && (
        <span className="menu-item-icon">
          <Icon name={icon} />
        </span>
      )}
      {children}
    </button>
  )
}
