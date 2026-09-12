import { useEffect, useState, type ReactNode } from 'react'
import { useStore } from './sync/store'
import { boot } from './boot'
import { requestToken, isSignedIn, onTokenChange } from './auth/tokenClient'
import { logout, currentSession } from './auth/session'
import { checkDraftRecovery, recommitDraft, discardDraft } from './sync/writer'
import { runHealthChecks, type HealthIssue } from './diagnostics/health'
import { IssueBanner, Modal, StatusBanners, SyncPill } from './ui/components'
import { Dashboard } from './ui/pages/Dashboard'
import { config } from './config'
import { Login } from './ui/pages/Login'
import { Init } from './ui/pages/Init'
import { Setup } from './ui/pages/Setup'
import { ProjectView } from './ui/pages/ProjectView'
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
  const [signedInGoogle, setSignedInGoogle] = useState(isSignedIn())
  const [health, setHealth] = useState<HealthIssue[]>([])
  const [draftRecovery, setDraftRecovery] = useState<string | null>(null)

  useEffect(() => {
    void boot().then(() => {
      void checkDraftRecovery().then((d) => {
        if (d) setDraftRecovery(d.savedAt)
      })
    })
    return onTokenChange(setSignedInGoogle)
  }, [])

  // GIS tokens expire ~1h with no library-side callback — re-check so the
  // Connect button re-appears when the token goes stale.
  useEffect(() => {
    const t = setInterval(() => setSignedInGoogle(isSignedIn()), 60_000)
    return () => clearInterval(t)
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
        <Setup title="Nexus can't start" message={bootError} />
      </Shell>
    )
  }

  if (status === 'needsInit') {
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
    <Shell signedInGoogle={signedInGoogle}>
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
    case 'project':
      return <ProjectView projectId={route.arg} />
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

function Shell({ children, bare, signedInGoogle }: { children: ReactNode; bare?: boolean; signedInGoogle?: boolean }): ReactNode {
  const session = useStore((s) => s.session)
  const route = useRoute()
  if (bare) return <div className="center-screen"><div className="center-card">{children}</div></div>

  const nav = [
    { id: 'dash', label: 'Dashboard', icon: '▦' },
    { id: 'scripts', label: 'Scripts', icon: '✎' },
    { id: 'archive', label: 'Archive', icon: '🗄' },
    ...(session?.role === 'admin' ? [{ id: 'admin', label: 'Admin', icon: '⚙' }] : []),
    { id: 'security', label: 'Security', icon: '🛡' },
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
          <div className="row">
            {signedInGoogle === false && (session?.role === 'admin' || session?.role === 'editor') && (
              <button
                className="btn primary"
                onClick={() => void requestToken({ silentFirst: true }).catch(() => void requestToken())}
              >
                Connect Google (studio account)
              </button>
            )}
          </div>
          <SyncPill />
        </div>
        {children}
      </main>
    </div>
  )
}

export { currentSession }
