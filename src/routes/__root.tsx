// Root route — the document shell + the app layout. Absorbs the old
// App.tsx: boot gating (blocked → Setup, needsInit → Init, viewer login),
// the sidebar Shell, health-check/stale-build/draft-recovery effects.

import { createRootRoute, HeadContent, Link, Outlet, Scripts, useNavigate, useRouterState } from '@tanstack/react-router'
import { useEffect, useState, type ReactNode } from 'react'
import { useStore } from '../sync/store'
import { boot } from '../boot'
import { logout, currentSession } from '../auth/session'
import { checkDraftRecovery, recommitDraft, discardDraft } from '../sync/writer'
import { runHealthChecks, type HealthIssue } from '../diagnostics/health'
import { IssueBanner, Modal, StatusBanners, SyncPill } from '../ui/components'
import { config } from '../config'
import { Login } from '../ui/pages/Login'
import { Init } from '../ui/pages/Init'
import { Setup } from '../ui/pages/Setup'
import { UploadTile } from '../ui/UploadTile'
import '../ui/styles.css'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1.0' },
      { name: 'color-scheme', content: 'light' },
      { name: 'google-site-verification', content: 'mwemML4cI0Mq3l-aDufEFCiDkakirKx_X-SoEFEXe1M' },
      { title: 'Nexus — Content Manager' },
    ],
    links: [
      {
        rel: 'icon',
        href:
          "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='22' fill='%236c8cff'/><text x='50' y='72' font-size='58' text-anchor='middle' fill='%230b0e14' font-family='system-ui' font-weight='700'>N</text></svg>",
      },
    ],
    scripts: [
      {
        // Apply the stored theme before first paint (no flash of the wrong theme).
        children:
          'try{if(localStorage.getItem("nexus.theme")==="dark"){document.documentElement.dataset.theme="dark"}}catch(e){}',
      },
    ],
  }),
  component: RootComponent,
})

function RootComponent(): ReactNode {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <AppBody />
        <Scripts />
      </body>
    </html>
  )
}

// ---------------------------------------------------------------------------

function AppBody(): ReactNode {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const status = useStore((s) => s.status)
  const bootError = useStore((s) => s.bootError)
  const doc = useStore((s) => s.doc)
  const session = useStore((s) => s.session)
  const [health, setHealth] = useState<HealthIssue[]>([])
  const [draftRecovery, setDraftRecovery] = useState<string | null>(null)
  const [staleBuild, setStaleBuild] = useState(false)

  useEffect(() => {
    void boot().then(() => {
      void checkDraftRecovery().then((d) => {
        if (d) setDraftRecovery(d.savedAt)
      })
    })
  }, [])

  // The moment an editor/admin signs in: retry any project folders that failed
  // to create earlier, and flush queued edits so they reach storage instead
  // of waiting for the next save.
  useEffect(() => {
    if (!session || session.role === 'viewer') return
    void (async () => {
      const { storeGet } = await import('../sync/store')
      const doc = storeGet().doc
      if (!doc) return
      const { ensureProjectFolder } = await import('../state/actions')
      for (const p of Object.values(doc.projects)) {
        if (p.deleted === null && !p.folderId) {
          await ensureProjectFolder(p.id).catch(() => {})
        }
      }
      const { flush } = await import('../sync/writer')
      await flush().catch(() => {})
    })()
  }, [session?.appUserId])

  // Stale-build detection: announce instead of silently running old code.
  useEffect(() => {
    let stopped = false
    const check = async () => {
      const { checkForUpdate } = await import('../diagnostics/update')
      const stale = await checkForUpdate()
      if (!stopped && stale) setStaleBuild(true)
    }
    const t = setInterval(() => void check(), 5 * 60_000)
    window.addEventListener('focus', () => void check())
    void check()
    return () => {
      stopped = true
      clearInterval(t)
    }
  }, [])

  useEffect(() => {
    if (status === 'ok' || status === 'queued' || status === 'reconnect') {
      // Shallow checks in the interval — the deep probe transfers bytes and
      // belongs to boot + the Admin health-check button.
      const t = setInterval(() => void runHealthChecks({ deep: false }).then(setHealth), 30_000)
      void runHealthChecks({ deep: true }).then(setHealth)
      return () => clearInterval(t)
    }
  }, [status])

  if (status === 'blocked' && bootError && !doc) {
    return (
      <Shell bare>
        <Setup title="Nexus can't start" message={bootError} stamp="Blocked" tone="red" />
      </Shell>
    )
  }

  if (status === 'needsReset' || status === 'needsInit') {
    return (
      <Shell bare>
        <Init />
      </Shell>
    )
  }

  const needsLogin = doc != null && session === null && doc.settings.privacy.requireViewerLogin && pathname !== '/init'
  if (needsLogin) {
    return (
      <Shell bare>
        <Login viewerTokenFromLink={new URLSearchParams(location.search).get('vw')} />
      </Shell>
    )
  }

  return (
    <Shell>
      {staleBuild && (
        <div className="banner info">
          <div className="body">
            <b>A new version of Nexus is available</b>
            <div className="fix">Reload to switch to it — your queued changes are kept.</div>
          </div>
          <button className="btn primary small" onClick={() => location.reload()}>Refresh now</button>
        </div>
      )}
      {health.map((h, i) => (
        <IssueBanner key={h.code + String(i)} issue={h} />
      ))}
      <StatusBanners />
      {doc === null ? (
        <Setup title="Connecting…" message="Loading the workspace…" />
      ) : (
        <Outlet />
      )}
      <div className="footer">
        <span>Nexus {config.appVersion}</span>
        <span>schema ≤ {config.maxKnownSchema}</span>
        <Link to="/security">security notes</Link>
      </div>
      {draftRecovery && (
        <Modal title="Unsaved changes from last session" onClose={() => setDraftRecovery(null)}>
          <p className="muted">
            A tab closed before its changes finished syncing (saved {new Date(draftRecovery).toLocaleTimeString()}).
            They were kept safe in this browser.
          </p>
          <div className="row">
            <button
              className="btn primary"
              onClick={async () => {
                setDraftRecovery(null)
                await recommitFromRecovery()
              }}
            >
              Review &amp; re-commit
            </button>
            <button
              className="btn"
              onClick={() => {
                setDraftRecovery(null)
                void discardDraft()
              }}
            >
              Discard
            </button>
          </div>
        </Modal>
      )}
    </Shell>
  )
}

async function recommitFromRecovery(): Promise<void> {
  const { takeRecovery } = await import('../sync/drafts')
  const { loadDraft } = await import('../sync/drafts')
  const draft = (await takeRecovery()) ?? (await loadDraft())
  if (draft) await recommitDraft(draft.doc)
}

// ---------------------------------------------------------------------------

function Shell({ children, bare }: { children: ReactNode; bare?: boolean }): ReactNode {
  const session = useStore((s) => s.session)
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const navigateTo = useNavigate()
  const [, setThemeTick] = useState(0)
  const [menuOpen, setMenuOpen] = useState(false)

  // The mobile drawer closes whenever the route changes or Escape is pressed.
  useEffect(() => {
    setMenuOpen(false)
  }, [pathname])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (bare) return <div className="center-screen"><div className="center-card">{children}</div></div>

  const icon = (paths: React.JSX.Element): React.JSX.Element => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths}
    </svg>
  )
  const isActive = (id: string): boolean =>
    pathname === '/' + id || (id === 'dash' && (pathname === '/' || pathname.startsWith('/project')))
  const nav = [
    { id: 'dash', label: 'Board', to: '/', icon: icon(<><rect x="3" y="4" width="5" height="16" rx="1" /><rect x="10" y="4" width="5" height="10" rx="1" /><rect x="17" y="4" width="4" height="13" rx="1" /></>) },
    { id: 'groups', label: 'Groups', to: '/groups', icon: icon(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />) },
    { id: 'scripts', label: 'Scripts', to: '/scripts', icon: icon(<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></>) },
    { id: 'archive', label: 'Archive', to: '/archive', icon: icon(<><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" /><path d="M10 12h4" /></>) },
    ...(session?.role === 'admin' ? [{ id: 'admin', label: 'Admin', to: '/admin', icon: icon(<><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h16" /><circle cx="9" cy="6" r="1.6" fill="currentColor" stroke="none" /><circle cx="15" cy="12" r="1.6" fill="currentColor" stroke="none" /><circle cx="7" cy="18" r="1.6" fill="currentColor" stroke="none" /></>) }] : []),
  ]
  const setTheme = (): void => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    localStorage.setItem('nexus.theme', next)
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', next)
    setThemeTick((t) => t + 1)
  }
  return (
    <div className="shell">
      {menuOpen && <div className="drawer-backdrop" onClick={() => setMenuOpen(false)} />}
      <aside className={`sidebar ${menuOpen ? 'drawer-open' : ''}`}>
        <div className="drawer-head">
          <div className="brand">
            <span className="brand-dot" /> Nexus
          </div>
          <button className="icon-btn drawer-close" aria-label="Close menu" onClick={() => setMenuOpen(false)}>
            ✕
          </button>
        </div>
        {nav.map((n) => (
          <button
            key={n.id}
            className={`nav-item ${isActive(n.id) ? 'active' : ''}`}
            onClick={() => {
              setMenuOpen(false)
              void navigateTo({ to: n.to })
            }}
          >
            <span className="icon">{n.icon}</span> {n.label}
          </button>
        ))}
        <div className="nav-spacer" />
        <div className="nav-user">
          {session ? (
            <>
              <b>{session.name}</b>
              {session.role} ·{' '}
              <a
                href="/logout"
                onClick={(e) => {
                  e.preventDefault()
                  logout()
                }}
              >
                sign out
              </a>
            </>
          ) : (
            <>
              <b>Not signed in</b>
              <Link to="/login">sign in</Link>
            </>
          )}
        </div>
      </aside>
      <main className="content">
        <div className="mobile-topbar">
          <button className="icon-btn hamburger" aria-label="Open menu" onClick={() => setMenuOpen(true)}>
            ☰
          </button>
          <div className="mobile-brand">
            <span className="brand-dot" /> Nexus
          </div>
          <button
            className="icon-btn"
            style={{ marginLeft: 'auto' }}
            title="Toggle light/dark theme"
            aria-label="Toggle light/dark theme"
            onClick={setTheme}
          >
            {document.documentElement.dataset.theme === 'dark' ? '☀️' : '🌙'}
          </button>
        </div>
        <div className="content-header">
          <div className="row desktop-tools" style={{ marginLeft: 'auto' }}>
            <button
              className="icon-btn"
              title="Toggle light/dark theme"
              aria-label="Toggle light/dark theme"
              onClick={setTheme}
            >
              {document.documentElement.dataset.theme === 'dark' ? '☀️' : '🌙'}
            </button>
            <SyncPill />
          </div>
        </div>
        {children}
        <UploadTile />
      </main>
    </div>
  )
}

export { currentSession }
