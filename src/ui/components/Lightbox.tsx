// The lightbox — Nexus's first in-app media viewer. Until now clicking a file
// did nothing; this is the full-screen read path over /files/<key>: images
// (zoom + pan + pre-rendered neighbors), native video/audio, pdf via iframe,
// and a download card for everything else. Read-path only, so anonymous
// viewers can use it — writable actions (rename/move/delete) are injected by
// the caller through `actions`.
//
// Viewer kind comes from kindFromMime, falling back to the key's extension
// (mimeFromKey) when the item carries no mime — items without meta yet still
// get the right viewer.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { webViewLink } from '../../drive/client'
import { downloadToBrowserProgress, describeError } from '../../drive/preview'
import { mimeFromKey } from '../../server/mime'
import { kindFromMime } from '../../util/media'
import { toast } from './Toast'
import { Icon } from './Icon'
import './Lightbox.css'

export interface LightboxItem { fileId: string; name: string; mime?: string }

type Kind = 'image' | 'video' | 'audio' | 'pdf' | 'other'

const ZOOM = 2.5
const ZERO_PAN = { x: 0, y: 0 }

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Viewer kind for an item: kindFromMime with pdf promoted out of 'other'
 *  (a pdf gets a real iframe, not the download card). */
function kindOf(item: LightboxItem): Kind {
  const mime = item.mime ?? mimeFromKey(item.fileId)
  const k = kindFromMime(mime)
  return k === 'other' && mime === 'application/pdf' ? 'pdf' : k
}

export function Lightbox({ items, index, onClose, onNavigate, actions }: {
  items: LightboxItem[]
  index: number
  onClose: () => void
  /** omitted → single-item mode: no arrows/counter/keys */
  onNavigate?: (next: number) => void
  /** extra buttons for the top bar (the caller injects writable-only Rename/Move/Delete) */
  actions?: (item: LightboxItem) => ReactNode
}): React.JSX.Element | null {
  const item = items[index]
  const kind = item ? kindOf(item) : null

  const dialogRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)

  // Image zoom: one toggle level (1x ↔ ZOOM) plus a pan offset while zoomed.
  // Panning (the CSS transition off) tracks the pointer 1:1; the flag also
  // swallows the scrim-close click a pan would otherwise end with.
  const [zoomed, setZoomed] = useState(false)
  const [pan, setPan] = useState(ZERO_PAN)
  const [panning, setPanning] = useState(false)
  const drag = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null)
  const dragMoved = useRef(false)

  // Top-bar download state: null idle, else live percent (null pct = response
  // had no Content-Length — show an indeterminate "…").
  const [dl, setDl] = useState<{ pct: number | null } | null>(null)
  const dlSeq = useRef(0)

  const multi = onNavigate !== undefined && items.length > 1

  // Navigation resets the viewer and orphans any in-flight download (the seq
  // guard keeps its callbacks off the next item's button).
  useEffect(() => {
    setZoomed(false)
    setPan(ZERO_PAN)
    drag.current = null
    dragMoved.current = false
    dlSeq.current += 1
    setDl(null)
  }, [index])

  // Focus + scroll lock on mount, both restored on unmount — same contract
  // as Modal, but the dialog itself takes focus (the media is the content).
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const opener = document.activeElement as HTMLElement | null
    dialog.focus({ preventScroll: true })
    const scrollbar = window.innerWidth - document.documentElement.clientWidth
    const prevOverflow = document.body.style.overflow
    const prevPad = document.body.style.paddingRight
    document.body.style.overflow = 'hidden'
    if (scrollbar > 0) document.body.style.paddingRight = `${scrollbar}px`
    return () => {
      document.body.style.overflow = prevOverflow
      document.body.style.paddingRight = prevPad
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Window keys: arrows wrap via onNavigate, Escape closes. Inputs keep their
  // keys; a focused video owns its arrows (native seek) — navigating under it
  // would fight the player.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const tag = t?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable) return
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (tag === 'VIDEO' || !multi || !onNavigate) return
      if (e.key === 'ArrowRight') onNavigate((index + 1) % items.length)
      else if (e.key === 'ArrowLeft') onNavigate((index - 1 + items.length) % items.length)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onNavigate, multi, index, items.length])

  // Wheel zoom — a native non-passive listener: React's onWheel registers
  // passive and could not preventDefault the page gesture underneath.
  useEffect(() => {
    if (kind !== 'image') return
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (zoomed) {
        setZoomed(false)
        setPan(ZERO_PAN)
      } else {
        setZoomed(true)
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [kind, zoomed])

  if (!item || typeof document === 'undefined') return null

  const toggleZoom = () => {
    if (zoomed) {
      setZoomed(false)
      setPan(ZERO_PAN)
    } else {
      setZoomed(true)
    }
  }

  // Max travel = half the zoomed image's overflow past the stage — keeps a
  // dragged image from being flung entirely out of view.
  const clampPan = (x: number, y: number): { x: number; y: number } => {
    const img = imgRef.current
    const stage = stageRef.current
    if (!img || !stage) return { x, y }
    const mx = Math.max(0, (img.clientWidth * ZOOM - stage.clientWidth) / 2)
    const my = Math.max(0, (img.clientHeight * ZOOM - stage.clientHeight) / 2)
    return { x: Math.min(mx, Math.max(-mx, x)), y: Math.min(my, Math.max(-my, y)) }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    dragMoved.current = false
    if (!zoomed) return
    drag.current = { px: e.clientX, py: e.clientY, ox: pan.x, oy: pan.y }
    setPanning(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.px
    const dy = e.clientY - d.py
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragMoved.current = true
    setPan(clampPan(d.ox + dx, d.oy + dy))
  }
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    drag.current = null
    setPanning(false)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }

  // Clicks on the media or chrome never reach here with target === stage —
  // only empty scrim ground does. A pan that ends on the ground isn't a close.
  const onStageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    if (dragMoved.current) {
      dragMoved.current = false
      return
    }
    onClose()
  }

  const startDownload = () => {
    if (dl) return
    const seq = ++dlSeq.current
    setDl({ pct: 0 })
    downloadToBrowserProgress(item.fileId, item.name, (pct) => {
      if (dlSeq.current === seq) setDl({ pct })
    })
      .then(() => {
        if (dlSeq.current === seq) setDl(null)
      })
      .catch((e) => {
        if (dlSeq.current !== seq) return
        setDl(null)
        const d = describeError(e)
        toast.error(d.message, d.fix)
      })
  }

  // Tab cycles inside the dialog (same trap as Modal).
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

  // Images window: [index-1, index, index+1], neighbors hidden in the same
  // centered slot so the browser has them decoded when an arrow promotes
  // them. Heavy kinds (video/audio/pdf) only ever render the active item —
  // navigating unmounts the player, which stops playback.
  const media =
    kind === 'image' ? (
      ([-1, 0, 1] as const).map((off) => {
        const i = index + off
        if (i < 0 || i >= items.length) return null
        const it = items[i]
        if (kindOf(it) !== 'image') return null
        const active = off === 0
        return (
          <img
            key={`${i}:${it.fileId}`}
            ref={active ? imgRef : undefined}
            className={`lightbox-img${active && zoomed ? ' zoomed' : ''}${active && panning ? ' panning' : ''}`}
            src={webViewLink(it.fileId)}
            alt={it.name}
            draggable={false}
            style={{
              visibility: active ? 'visible' : 'hidden',
              transform: active ? `translate(${pan.x}px, ${pan.y}px) scale(${zoomed ? ZOOM : 1})` : undefined,
            }}
            onDoubleClick={active ? toggleZoom : undefined}
          />
        )
      })
    ) : kind === 'video' ? (
      <video key={item.fileId} className="lightbox-video" src={webViewLink(item.fileId)} controls autoPlay playsInline />
    ) : kind === 'audio' ? (
      <div key={item.fileId} className="lightbox-card">
        <Icon name="audio" size={34} />
        <div className="lightbox-card-name">{item.name}</div>
        <audio src={webViewLink(item.fileId)} controls />
      </div>
    ) : kind === 'pdf' ? (
      <iframe key={item.fileId} className="lightbox-pdf" src={webViewLink(item.fileId)} title={item.name} />
    ) : (
      <div key={item.fileId} className="lightbox-card">
        <Icon name="file" size={34} />
        <div className="lightbox-card-name">{item.name}</div>
        <button className="btn" onClick={startDownload} disabled={dl !== null}>
          <Icon name="download" size={14} />
          {dl ? (dl.pct === null ? '…' : `${dl.pct}%`) : 'Download'}
        </button>
        <div className="lightbox-hint">Download to view</div>
      </div>
    )

  return createPortal(
    <div
      ref={dialogRef}
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={item.name}
      tabIndex={-1}
      onKeyDown={trapTab}
    >
      <div
        ref={stageRef}
        className="lightbox-stage"
        onClick={onStageClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {media}
      </div>

      <header className="lightbox-bar">
        <div className="lightbox-name" title={item.name}>
          {item.name}
        </div>
        {multi && (
          <span className="lightbox-count">
            {index + 1} of {items.length}
          </span>
        )}
        <button className="lightbox-btn" onClick={startDownload} disabled={dl !== null}>
          <Icon name="download" size={14} />
          <span>{dl ? (dl.pct === null ? '…' : `${dl.pct}%`) : 'Download'}</span>
        </button>
        <a className="lightbox-btn icon" href={webViewLink(item.fileId)} target="_blank" rel="noreferrer" aria-label="Open in new tab" title="Open in new tab">
          <Icon name="external" size={14} />
        </a>
        {actions?.(item)}
        <button className="lightbox-btn icon" onClick={onClose} aria-label="Close">
          <Icon name="x" size={15} />
        </button>
      </header>

      {multi && (
        <>
          <button
            className="lightbox-btn lightbox-nav prev"
            aria-label="Previous"
            onClick={() => onNavigate?.((index - 1 + items.length) % items.length)}
          >
            <Icon name="chevron-left" size={17} />
          </button>
          <button
            className="lightbox-btn lightbox-nav next"
            aria-label="Next"
            onClick={() => onNavigate?.((index + 1) % items.length)}
          >
            <Icon name="chevron-right" size={17} />
          </button>
        </>
      )}
    </div>,
    document.body,
  )
}
