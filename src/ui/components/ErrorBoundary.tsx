import { Component, useEffect, useRef, type ReactNode } from 'react'
import type { ErrorComponentProps } from '@tanstack/react-router'
import { reportRenderCrash } from '../errorReport'

interface BoundaryState {
  error: Error | null
}

interface FallbackProps {
  error: Error
  /** TanStack route errors hand back a reset; the root boundary remounts via
   *  state instead. Either way "Try again" is best-effort — Reload is the
   *  reliable path, so it leads. */
  reset?: () => void
  compact?: boolean
}

function CrashFallback({ error, reset, compact }: FallbackProps): React.JSX.Element {
  return (
    <div className={compact ? 'card' : 'center-screen'}>
      <div className={compact ? '' : 'center-card card'} style={{ textAlign: 'center' }}>
        <p style={{ fontSize: 28, margin: 0 }}>⚠</p>
        <h2 style={{ margin: '8px 0 4px' }}>Something broke on this screen</h2>
        <p className="muted small" style={{ maxWidth: 460, margin: '4px auto 12px' }}>
          The rest of Nexus is fine — this view hit an error it couldn't recover from. The crash was
          reported; reloading brings everything back.
        </p>
        <p className="faint small mono" style={{ wordBreak: 'break-word', margin: '0 auto 14px', maxWidth: 460 }}>
          {error.message.slice(0, 200)}
        </p>
        <div className="row" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
          <button className="btn primary" onClick={() => location.reload()}>
            Reload Nexus
          </button>
          {reset && (
            <button className="btn" onClick={reset}>
              Try again
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** TanStack route-level error component — set as `defaultErrorComponent` so a
 *  crash inside any page replaces just that page; the shell stays alive. */
export function RouteError(props: ErrorComponentProps): React.JSX.Element {
  const error = props.error instanceof Error ? props.error : new Error(String(props.error))
  const sent = useRef<Error | null>(null)
  useEffect(() => {
    if (sent.current === error) return
    sent.current = error
    reportRenderCrash(error, props.info?.componentStack ?? '')
  }, [error, props.info])
  return <CrashFallback error={error} reset={props.reset} compact />
}

/** The root crash net. Until this existed, an uncaught render error unmounted
 *  React to a blank white screen (no boundary anywhere, no recovery). */
export class RootErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    reportRenderCrash(error, info.componentStack ?? '')
  }

  render(): ReactNode {
    const { error } = this.state
    if (error) return <CrashFallback error={error} />
    return this.props.children
  }
}
