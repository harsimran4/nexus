import { useEffect, useState, type ReactNode } from 'react'
import { useStore } from './sync/store'
import { boot } from './boot'
import { logout, currentSession } from './auth/session'
import { checkDraftRecovery, recommitDraft, discardDraft } from './sync/writer'
import { runHealthChecks, type HealthIssue } from './diagnostics/health'
import { IssueBanner, Modal, StatusBanners, SyncPill } from './ui/components'
import { Dashboard } from './ui/pages/Dashboard'
import { config } from './config'
import { Login } from './ui/pages/Login'
import { Init } from './ui/pages/Init'
import { Setup } from './ui/pages/Setup'
import { Groups } from './ui/pages/Groups'
import { GroupView } from './ui/pages/GroupView'
import { ProjectPage } from './ui/pages/ProjectPage'
import { Scripts } from './ui/pages/Scripts'
import { Archive } from './ui/pages/Archive'
import { Admin } from './ui/pages/Admin'
import { Security } from './ui/pages/Security'

// ---------------------------------------------------------------------------
// Hash router: #/dash #/project/<id> #/scripts #/archive #/admin #/security
//              #/init #/login?vw=…&t=…
// ---------------------------------------------------------------------------

function useRoute(): { page: string; arg: string } {
  const [route, setRoute] = useState(() => parseHash())
  useEffect(() => {
    const onChange = () => setRoute(parseHash())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}

function parseHash(): { page: string; arg: string } {
  const hash = location.hash.replace(/^#\/?/, '')
  const path = hash.split('?')[0]
  const [page, arg] = path.split('/')
  return { page: page || 'dash', arg: arg ?? '' }
}

export const navigate = (to: string): void => {
  location.hash = '#/' + to.replace(/^\/+/, '')
}

// ---------------------------------------------------------------------------

export function App(): ReactNode {
  const route = useRoute()
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
  // to create earlier, and flush queued edits (e.g. a project created while
  // signed out) so they reach Drive instead of waiting for the next save.
  useEffect(() => {
    if (!session || session.role === 'viewer') return
    void (async () => {
      const { storeGet } = await import('./sync/store')
      const doc = storeGet().doc
      if (!doc) return
      const { ensureProjectFolder } = await import('./state/actions')
      for (const p of Object.values(doc.projects)) {
        if (p.deleted === null && !p.folderId) {
          await ensureProjectFolder(p.id).catch(() => {})
        }
      }
      const { flush } = await import('./sync/writer')
      await flush().catch(() => {})
    })()
  }, [session?.appUserId])

  // Stale-build detection: Pages pins the old HTML for up to 10 minutes —
  // announce instead of silently running old code.
  useEffect(() => {
    let stopped = false
    const check = async () => {
      const { checkForUpdate } = await import('./diagnostics/update')
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
      // Shallow checks in the interval — the deep download-restriction probe
      // transfers bytes and belongs to boot + the Admin health-check button.
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

  const needsLogin = doc != null && session === null && doc.settings.privacy.requireViewerLogin && route.page !== 'init'
  if (needsLogin) {
    return (
      <Shell bare>
        <Login viewerTokenFromLink={extractVw()} />
      </Shell>
    )
  }

  const page = renderPage(route, doc !== null)
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
      {page}
      <div className="footer">
        <span>Nexus {config.appVersion}</span>
        <span>schema ≤ {config.maxKnownSchema}</span>
        <a href="#/security">security notes</a>
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
  const { takeRecovery } = await import('./sync/drafts')
  const { loadDraft } = await import('./sync/drafts')
  const draft = (await takeRecovery()) ?? (await loadDraft())
  if (draft) await recommitDraft(draft.doc)
}

function extractVw(): string | null {
  const hash = location.hash
  const q = hash.indexOf('?')
  if (q < 0) return null
  return new URLSearchParams(hash.slice(q + 1)).get('vw')
}

function renderPage(route: { page: string; arg: string }, hasDoc: boolean): ReactNode {
  if (!hasDoc) return <Setup title="Connecting…" message="Loading the workspace from Google Drive…" />
  switch (route.page) {
    case 'dash':
      return <Dashboard />
    case 'groups':
      return <Groups />
    case 'group':
      return <GroupView groupId={route.arg} />
    case 'project':
      return <ProjectPage projectId={route.arg} />
    case 'scripts':
      return <Scripts />
    case 'archive':
      return <Archive />
    case 'admin':
      return <Admin />
    case 'security':
      return <Security />
    case 'login':
      // Reachable even when requireViewerLogin is false (sidebar "sign in").
      return <Login viewerTokenFromLink={extractVw()} />
    default:
      return <Dashboard />
  }
}

// ---------------------------------------------------------------------------

function Shell({ children, bare }: { children: ReactNode; bare?: boolean }): ReactNode {
  const session = useStore((s) => s.session)
  const route = useRoute()
  const [, setThemeTick] = useState(0)
  if (bare) return <div className="center-screen"><div className="center-card">{children}</div></div>

  const icon = (paths: React.JSX.Element): React.JSX.Element => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths}
    </svg>
  )
  const nav = [
    { id: 'dash', label: 'Board', icon: icon(<><rect x="3" y="4" width="5" height="16" rx="1" /><rect x="10" y="4" width="5" height="10" rx="1" /><rect x="17" y="4" width="4" height="13" rx="1" /></>) },
    { id: 'groups', label: 'Groups', icon: icon(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />) },
    { id: 'scripts', label: 'Scripts', icon: icon(<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></>) },
    { id: 'archive', label: 'Archive', icon: icon(<><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" /><path d="M10 12h4" /></>) },
    ...(session?.role === 'admin' ? [{ id: 'admin', label: 'Admin', icon: icon(<><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h16" /><circle cx="9" cy="6" r="1.6" fill="currentColor" stroke="none" /><circle cx="15" cy="12" r="1.6" fill="currentColor" stroke="none" /><circle cx="7" cy="18" r="1.6" fill="currentColor" stroke="none" /></>) }] : []),
  ]
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-dot" /> Nexus
        </div>
        {nav.map((n) => (
          <button
            key={n.id}
            className={`nav-item ${route.page === n.id || (n.id === 'dash' && route.page === 'project') ? 'active' : ''}`}
            onClick={() => navigate(n.id)}
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
                href="#logout"
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
              <a
                href="#login"
                onClick={(e) => {
                  e.preventDefault()
                  navigate('login')
                }}
              >
                sign in
              </a>
            </>
          )}
        </div>
      </aside>
      <main className="content">
        <div className="content-header">
          <div className="row" style={{ marginLeft: 'auto' }}>
            <button
              className="icon-btn"
              title="Toggle light/dark theme"
              aria-label="Toggle light/dark theme"
              onClick={() => {
                const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
                document.documentElement.dataset.theme = next
                localStorage.setItem('nexus.theme', next)
                document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', next)
                setThemeTick((t) => t + 1)
              }}
            >
              {document.documentElement.dataset.theme === 'dark' ? '☀️' : '🌙'}
            </button>
            <SyncPill />
          </div>
        </div>
        {children}
      </main>
    </div>
  )
}

export { currentSession }
