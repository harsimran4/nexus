/** Hand-drawn stroke icon set — one component, no icon library. Same
 *  conventions as the nav icons in routes/__root.tsx (15-16px, stroke 1.8,
 *  round caps on a 24-grid), so everything reads as one hand. */

const P = (d: string) => <path d={d} />

const PATHS = {
  upload: (
    <>
      {P('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4')}
      {P('m17 8-5-5-5 5')}
      {P('M12 3v12')}
    </>
  ),
  download: (
    <>
      {P('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4')}
      {P('m7 10 5 5 5-5')}
      {P('M12 15V3')}
    </>
  ),
  external: (
    <>
      {P('M15 3h6v6')}
      {P('M10 14 21 3')}
      {P('M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6')}
    </>
  ),
  trash: (
    <>
      {P('M3 6h18')}
      {P('M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6')}
      {P('M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2')}
      {P('M10 11v6')}
      {P('M14 11v6')}
    </>
  ),
  pencil: (
    <>
      {P('M12 20h9')}
      {P('M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z')}
    </>
  ),
  dots: (
    <>
      <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  x: (
    <>
      {P('M18 6 6 18')}
      {P('m6 6 12 12')}
    </>
  ),
  check: P('M20 6 9 17l-5-5'),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      {P('m21 21-4.3-4.3')}
    </>
  ),
  'chevron-left': P('m15 18-6-6 6-6'),
  'chevron-right': P('m9 18 6-6-6-6'),
  'chevron-down': P('m6 9 6 6 6-6'),
  'chevron-up': P('m18 15-6-6-6 6'),
  'arrow-left': (
    <>
      {P('m12 19-7-7 7-7')}
      {P('M19 12H5')}
    </>
  ),
  folder: P('M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'),
  'folder-plus': (
    <>
      {P('M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z')}
      {P('M12 10v6')}
      {P('M9 13h6')}
    </>
  ),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      {P('m21 15-4.5-4.5L5 21')}
    </>
  ),
  video: (
    <>
      {P('m22 8-6 4 6 4V8z')}
      <rect x="2" y="6" width="14" height="12" rx="2" />
    </>
  ),
  audio: (
    <>
      {P('M9 18V5l12-2v13')}
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </>
  ),
  file: (
    <>
      {P('M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z')}
      {P('M15 2v5h5')}
    </>
  ),
  'file-text': (
    <>
      {P('M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z')}
      {P('M15 2v5h5')}
      {P('M10 9H8')}
      {P('M16 13H8')}
      {P('M16 17H8')}
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      {P('M12 2v2')}
      {P('M12 20v2')}
      {P('m4.9 4.9 1.4 1.4')}
      {P('m17.7 17.7 1.4 1.4')}
      {P('M2 12h2')}
      {P('M20 12h2')}
      {P('m6.3 17.7-1.4 1.4')}
      {P('m19.1 4.9-1.4 1.4')}
    </>
  ),
  moon: P('M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z'),
  menu: (
    <>
      {P('M4 6h16')}
      {P('M4 12h16')}
      {P('M4 18h16')}
    </>
  ),
  plus: (
    <>
      {P('M12 5v14')}
      {P('M5 12h14')}
    </>
  ),
  eye: (
    <>
      {P('M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z')}
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      {P('M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1')}
    </>
  ),
  play: P('m7 4 13 8-13 8z'),
  refresh: (
    <>
      {P('M3 12a9 9 0 0 1 15.5-6.2L21 8')}
      {P('M21 3v5h-5')}
      {P('M21 12a9 9 0 0 1-15.5 6.2L3 16')}
      {P('M3 21v-5h5')}
    </>
  ),
  'check-square': (
    <>
      {P('m9 11 3 3L22 4')}
      {P('M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11')}
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      {P('M12 7v5l3 2')}
    </>
  ),
  alert: (
    <>
      {P('m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3z')}
      {P('M12 9v4')}
      {P('M12 17h.01')}
    </>
  ),
  move: (
    <>
      {P('m5 9-3 3 3 3')}
      {P('m9 5 3-3 3 3')}
      {P('m15 19 3-3-3-3')}
      {P('m19 9 3 3-3 3')}
      {P('M2 12h20')}
      {P('M12 2v20')}
    </>
  ),
  link: (
    <>
      {P('M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7')}
      {P('M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7')}
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  'zoom-in': (
    <>
      <circle cx="11" cy="11" r="7" />
      {P('m21 21-4.3-4.3')}
      {P('M11 8v6')}
      {P('M8 11h6')}
    </>
  ),
}

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 15, label, className }: {
  name: IconName
  size?: number
  /** When set, the svg is announced as an image with this name; otherwise decorative. */
  label?: string
  className?: string
}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      className={className}
    >
      {label ? <title>{label}</title> : null}
      {PATHS[name]}
    </svg>
  )
}
