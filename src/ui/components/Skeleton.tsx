/** Loading placeholder — a shimmering block. The global
 *  `prefers-reduced-motion` kill-switch in styles.css freezes the shimmer. */
export function Skeleton({ className = '', style }: { className?: string; style?: React.CSSProperties }): React.JSX.Element {
  return <div className={`skel ${className}`} style={style} aria-hidden="true" />
}
