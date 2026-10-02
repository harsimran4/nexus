// Thumbnail for any stored file. Images render directly; videos render as a
// muted <video> pinned to ~0.1s so the browser's own first-frame decode acts
// as the poster — preload="metadata" pulls only the front bytes (the storage
// route supports Range). Drive used to generate poster images server-side;
// plain object storage doesn't, and this needs no upload pipeline or extra
// objects — and works the same for viewers and editors.

import { mimeFromKey } from '../server/mime'
import { kindFromMime } from '../util/media'
import { thumbnailUrl } from '../drive/client'

export function MediaThumb({
  fileKey,
  alt = '',
  style,
}: {
  fileKey: string
  alt?: string
  style?: React.CSSProperties
}): React.JSX.Element {
  const kind = kindFromMime(mimeFromKey(fileKey))
  const src = thumbnailUrl(fileKey)
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
      onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
    />
  )
}
