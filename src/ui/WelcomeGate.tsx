// The anonymous front door: what visitors see at / when they aren't signed
// in. A quiet hero introduces the product with the sign-in card right there
// — the console is one secret away. Editors/admins land on the Board after
// login; viewers drop straight into read-only.

import type { ReactNode } from 'react'
import { Login } from './pages/Login'

export function WelcomeGate({ viewerTokenFromLink }: { viewerTokenFromLink: string | null }): ReactNode {
  return (
    <>
      <style>{`
        .center-card:has(.welcome-gate) { max-width: 1040px; }
        .welcome-gate { display: grid; grid-template-columns: 1fr; gap: 26px; align-items: start; }
        @media (min-width: 880px) { .welcome-gate { grid-template-columns: 1.15fr 0.85fr; gap: 40px; } }
        .welcome-gate .wg-title { font-weight: 650; letter-spacing: -0.025em;
          font-size: clamp(30px, 4.2vw, 46px); line-height: 1.08; margin: 0 0 12px; }
        .welcome-gate .wg-lede { color: var(--muted); font-size: 15px; line-height: 1.55; max-width: 46ch; margin: 0 0 24px; }
        .welcome-gate .wg-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
        .welcome-gate .wg-card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-lg);
          padding: 14px; font-size: 12.5px; line-height: 1.5; color: var(--muted); box-shadow: var(--elev-1); }
        .welcome-gate .wg-card b { display: flex; align-items: center; gap: 7px; font-weight: var(--fw-semibold);
          font-size: 13.5px; letter-spacing: -0.01em; color: var(--text); margin-bottom: 4px; }
        .welcome-gate .wg-dot { width: 9px; height: 9px; border-radius: 3px; flex: none; }
        .wg-more { font-size: 13px; color: var(--faint); margin-top: 18px; }
        .wg-more a { color: var(--accent-strong); text-decoration: none; }
        .wg-more a:hover { text-decoration: underline; }
      `}</style>
      <div className="welcome-gate">
        <div>
          <h1 className="wg-title">Every cut, on one wall.</h1>
          <p className="wg-lede">
            The team’s shared desk — groups hold projects, projects hold media and scripts,
            and the board shows everyone where every cut stands. Sign in to step inside.
          </p>
          <div className="wg-cards">
            <div className="wg-card">
              <b><span className="wg-dot" style={{ background: 'var(--sticky-1)' }} />The board</b>
              Drag projects from pending to done — the whole room sees it.
            </div>
            <div className="wg-card">
              <b><span className="wg-dot" style={{ background: 'var(--sticky-2)' }} />Media &amp; scripts</b>
              Clips stream in place; scripts keep a frozen copy at Review and Final.
            </div>
            <div className="wg-card">
              <b><span className="wg-dot" style={{ background: 'var(--sticky-4)' }} />Viewer links</b>
              Clients click a link and look — no account, no password.
            </div>
          </div>
          <p className="wg-more">
            New here? <a href="/welcome">Read the full story</a> — how everything connects.
          </p>
        </div>
        <div>
          <Login viewerTokenFromLink={viewerTokenFromLink} />
        </div>
      </div>
    </>
  )
}
