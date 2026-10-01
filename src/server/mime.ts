// Extension → MIME for listings. ListObjectsV2 doesn't return Content-Type,
// and per-object HEADs would blow the Workers free-plan subrequest cap — so
// the key extension is the single source of truth for FileMeta.mimeType.
// (Downloads/streams still use the object's stored Content-Type.)

const MAP: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  heic: 'image/heic',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
  aac: 'audio/aac',
  pdf: 'application/pdf',
  zip: 'application/zip',
  json: 'application/json',
  md: 'text/markdown',
  txt: 'text/plain',
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  csv: 'text/csv',
  xml: 'application/xml',
  psd: 'image/vnd.adobe.photoshop',
  ai: 'application/postscript',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

/** Display name from a key like `projects/p1/f_ab12__My Clip.mp4` — the text
 *  after the first `__` (ids never contain `__`). Keys without `__` use the
 *  basename. */
export function nameFromKey(key: string): string {
  const base = key.endsWith('/') ? key.slice(0, -1).split('/').slice(-1)[0] ?? key : key.split('/').pop() ?? key
  const i = base.indexOf('__')
  return i >= 0 ? base.slice(i + 2) : base
}

/** MIME derived from the key's extension (unknown → octet-stream). */
export function mimeFromKey(key: string): string {
  const base = key.split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return 'application/octet-stream'
  return MAP[base.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream'
}

/** Make a display name safe for use as a key segment: no separators or
 *  control chars, never containing `__` (which marks the id/name boundary). */
export function sanitizeNameSegment(name: string): string {
  return (
    name
      .replace(/[/\\]/g, '_')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f]/g, '')
      .replace(/__/g, '_')
      .trim() || 'untitled'
  )
}

/** Per-segment key encoding for URLs — separators stay literal. */
export function encodeKeyPath(key: string): string {
  return key.split('/').map((seg) => encodeURIComponent(seg)).join('/')
}
