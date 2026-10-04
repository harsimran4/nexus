// Thumbnail for any stored file. Preference order for videos: a generated
// JPEG (thumbs/<id>.jpg — small, immutable, fast), falling back to the
// video's own first frame (muted <video preload="metadata"> pinned to
// #t=0.1 — the browser range-fetches only the front bytes). Drive used to
// generate posters server-side; plain object storage doesn't, so an editor's
// browser generates each JPEG once and uploads it — after that EVERY client,
// viewers included, loads the small image. Images render directly.

import { useEffect, useRef, useState } from 'react'
import { mimeFromKey } from '../server/mime'
import { extFromKey, kindFromMime, thumbKeyFor } from '../util/media'
import { thumbnailUrl } from '../drive/client'
import { canWrite } from '../auth/session'
import { Icon, type IconName } from './components/Icon'
import type { MediaKind } from '../util/media'

const KIND_ICON: Record<MediaKind, IconName> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  other: 'file',
}

/** Centered glyph tile for kinds without a visual thumbnail (audio, docs,
 *  failed images) — never a blank well. */
export function ThumbGlyphTile({ icon, ext, style }: { icon: IconName; ext?: string; style?: React.CSSProperties }) {
  return (
    <div className="thumb-fallback" style={style} aria-hidden="true">
      <Icon name={icon} size={26} />
      {ext && <span className="thumb-fallback-ext">{ext}</span>}
    </div>
  )
}

// One generation attempt per media key per session; failures are not retried
// (the video-poster fallback is the permanent answer for that file).
const attempted = new Set<string>()
// Generation runs strictly one-at-a-time — a grid of fresh videos must not
// open a dozen concurrent decode+upload bursts.
let chain: Promise<unknown> = Promise.resolve()

async function generateThumb(fileKey: string, src: string): Promise<boolean> {
  try {
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'auto'
    video.src = src + '#t=1'
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve()
      video.onerror = () => reject(new Error('load failed'))
      setTimeout(() => reject(new Error('timeout')), 20_000)
    })
    // Seek ~10% in — dodges black lead-in frames.
    const at = Number.isFinite(video.duration) ? Math.min(1, video.duration * 0.1) : 0.5
    await new Promise<void>((resolve) => {
      video.onseeked = () => resolve()
      video.currentTime = at
      setTimeout(resolve, 4_000)
    })
    const scale = Math.min(1, 480 / (video.videoWidth || 480))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(2, Math.round((video.videoWidth || 480) * scale))
    canvas.height = Math.max(2, Math.round((video.videoHeight || 270) * scale))
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.72))
    if (!blob) return false
    const form = new FormData()
    form.set('mediaKey', fileKey)
    form.set('file', new File([blob], 'thumb.jpg', { type: 'image/jpeg' }))
    const { putThumbFn } = await import('../server/fns')
    return (await putThumbFn({ data: form })).ok
  } catch {
    return false
  }
}

export function MediaThumb({
  fileKey,
  alt = '',
  style,
  mime,
}: {
  fileKey: string
  alt?: string
  style?: React.CSSProperties
  /** Stored Content-Type when known (meta) — beats the extension guess for
   *  files uploaded without one (e.g. 'photo dump' → image/jpeg). */
  mime?: string
}): React.JSX.Element {
  const kind = kindFromMime(mime ?? mimeFromKey(fileKey))
  const src = thumbnailUrl(fileKey)
  const tUrl = kind === 'video' ? (thumbKeyFor(fileKey) ? '/files/' + thumbKeyFor(fileKey) : null) : null
  // 'thumb' until the JPEG proves missing; then poster (+ generation).
  const [mode, setMode] = useState<'thumb' | 'poster'>(tUrl ? 'thumb' : 'poster')
  const [imgFailed, setImgFailed] = useState(false)
  const queued = useRef(false)

  useEffect(() => {
    setImgFailed(false)
  }, [fileKey])

  useEffect(() => {
    setMode(tUrl ? 'thumb' : 'poster')
  }, [tUrl])

  // Editor viewing a poster-mode video: generate + upload the JPEG once.
  useEffect(() => {
    if (mode !== 'poster' || kind !== 'video' || !tUrl || !canWrite() || queued.current) return
    if (attempted.has(fileKey)) return
    queued.current = true
    attempted.add(fileKey)
    chain = chain
      .then(() => generateThumb(fileKey, src))
      .then((ok) => {
        if (ok) setMode('thumb')
      })
      .catch(() => {})
  }, [mode, kind, tUrl, fileKey, src])

  // Audio, docs, and images that failed to load get a glyph tile — a blank
  // well teaches nothing. This branch sits AFTER every hook: the same
  // instance can flip between it and the media branches (meta arriving
  // changes the kind; a 404ing image flips imgFailed) and the hook count
  // must stay constant.
  if (kind === 'audio' || kind === 'other' || (kind === 'image' && imgFailed)) {
    return <ThumbGlyphTile icon={KIND_ICON[kind]} ext={extFromKey(fileKey)} style={style} />
  }

  if (kind === 'video' && mode === 'thumb' && tUrl) {
    return (
      <img
        src={tUrl}
        alt={alt}
        loading="lazy"
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', ...style }}
        onError={() => setMode('poster')}
      />
    )
  }
  if (kind === 'video') {
    return (
      <video
        src={src + '#t=0.1'}
        preload="metadata"
        muted
        playsInline
        tabIndex={-1}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', ...style }}
      />
    )
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', ...style }}
      onError={() => setImgFailed(true)}
    />
  )
}
