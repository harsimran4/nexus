import { useEffect, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { scopedBootstrapFn } from '../server/fns'
import { config } from '../config'
import { parseDoc } from '../types/schema'
import { storeGet, useStore } from '../sync/store'
import { setScopedSession, clearScopedSession, startScopedRefresh, stopScopedRefresh } from '../sync/scoped'
import { banner } from '../ui/components'

// P8 — the scoped client share link (/share/<token>). Self-contained like the
// guest upload page: boot() never runs for this path, so the workspace doc is
// never downloaded. The server answers scopedBootstrapFn with ONLY the scoped
// project (the enforcement is the server filter); once it lands we hand the
// router the normal project route, which renders straight from the store.
// (ProjectPage can't render UNDER this route — its media-view hooks bind to
// the project route's search params.)
//
// A SCOPED link also persists the session (sync/scoped.ts): the tab's whole
// lifetime — reloads included — stays on the scoped read path, and the
// module-level refresh below keeps it live after we navigate away (this
// component unmounts; its own interval would die with it).
// A WHOLE-workspace link (scope = '') serves the full doc — the same bytes
// the public read already serves — so it engages no special mode.

export const Route = createFileRoute('/share/$token')({
  component: SharePage,
})

function SharePage(): React.JSX.Element {
  const { token } = Route.useParams()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const res = await scopedBootstrapFn({ data: { token } })
        if (cancelled) return
        if (!res.ok) {
          setError(res.message)
          return
        }
        const parsed = parseDoc(res.data.raw)
        if (!parsed.ok || parsed.doc.schema > config.maxKnownSchema) {
          setError('This link served content this version cannot read — update the app')
          return
        }
        if (res.data.projectId) {
          // Scoped: persist + switch to the module-level pulse.
          setScopedSession({
            token,
            projectId: res.data.projectId,
            viewerId: res.data.viewerId,
            viewerName: res.data.viewerName,
          })
          startScopedRefresh()
        } else {
          // Whole-workspace flavor — no scoped mode (and drop any stale one).
          clearScopedSession()
          stopScopedRefresh()
        }
        storeGet().setDoc(parsed.doc)
        useStore.setState({
          session: {
            appUserId: res.data.viewerId,
            name: res.data.viewerName,
            role: 'viewer',
            scope: res.data.projectId ?? undefined,
          },
        })
        storeGet().setStatus('ok')
        storeGet().markSynced()
        const projectId = res.data.projectId ?? Object.keys(parsed.doc.projects)[0]
        if (!projectId) {
          setError('This project is no longer available')
          return
        }
        void navigate({ to: '/project/$projectId', params: { projectId } })
      } catch {
        if (!cancelled) setError('Could not reach the server — try again in a moment')
      }
    }
    void load()
    // Live-ness until navigation; the module-level refresh takes over after
    // (for whole-workspace links, this interval IS the pulse — it fetches
    // through the token fn, never the public read).
    const timer = setInterval(() => void load(), 30_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [token, navigate])

  if (error) {
    return (
      <div className="content" style={{ maxWidth: 560, margin: '10vh auto 0' }}>
        <h1 className="spread" style={{ justifyContent: 'flex-start', gap: 12 }}>
          <span aria-hidden="true">✦</span> Nexus share link
        </h1>
        {banner('error', error)}
        <p className="muted small">Ask the person who sent you this link for a fresh one.</p>
      </div>
    )
  }

  return (
    <div className="content" style={{ maxWidth: 560, margin: '10vh auto 0' }}>
      <p className="muted">Opening the shared project…</p>
    </div>
  )
}
