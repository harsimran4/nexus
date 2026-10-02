// The anonymous front door: what visitors see at / when they aren't signed
// in. The artistic welcome (same paper theme as /welcome) with the sign-in
// card right there — the console is one secret away. Editors/admins land on
// the Board after login; viewers drop straight into read-only.

import type { ReactNode } from 'react'
import { Login } from './pages/Login'

export function WelcomeGate({ viewerTokenFromLink }: { viewerTokenFromLink: string | null }): ReactNode {
  return (
    <>
      <style>{`
        .center-card:has(.welcome-gate) { max-width: 1040px; }
        .welcome-gate { display: grid; grid-template-columns: 1fr; gap: 26px; align-items: start; }
        @media (min-width: 880px) { .welcome-gate { grid-template-columns: 1.15fr 0.85fr; gap: 40px; } }
        .welcome-gate .wg-title { font-family: var(--serif); font-weight: 600; letter-spacing: -0.015em;
          font-size: clamp(30px, 4.2vw, 46px); line-height: 1.06; margin: 0 0 12px; }
        .welcome-gate .wg-lede { color: var(--muted); font-size: 15px; max-width: 46ch; margin: 0 0 20px; }
        .welcome-gate .wg-stickies { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 14px; }
        .welcome-gate .wg-sticky { border-radius: 3px; padding: 13px 13px 12px; font-size: 12.5px; line-height: 1.45;
          box-shadow: 0 2px 3px rgba(60,54,38,0.08), 0 8px 18px rgba(60,54,38,0.09); }
        .welcome-gate .wg-sticky b { display: block; font-family: var(--serif); font-size: 14.5px; margin-bottom: 3px; }
        .wg-more { font-size: 13px; color: var(--faint); margin-top: 16px; }
        .wg-more a { color: var(--muted); border-bottom: 1px dotted var(--border-strong); text-decoration: none; }
      `}</style>
      <div className="welcome-gate">
        <div>
          <h1 className="wg-title">
            Every cut,{' '}
            <span style={{ position: 'relative', whiteSpace: 'nowrap' }}>
              on one wall.
              <svg viewBox="0 0 200 14" preserveAspectRatio="none" aria-hidden="true"
                   style={{ position: 'absolute', left: '-2%', bottom: '-0.26em', width: '104%', height: '0.3em', overflow: 'visible' }}>
                <path d="M3 9 C 40 3, 78 12, 112 7 S 176 4, 197 8" fill="none" stroke="#c05621" strokeWidth="3.4" strokeLinecap="round" opacity="0.85" />
              </svg>
            </span>
          </h1>
          <p className="wg-lede">
            The team’s shared desk — groups hold projects, projects hold media and scripts,
            and the board shows everyone where every cut stands. Sign in to step inside.
          </p>
          <div className="wg-stickies">
            <div className="wg-sticky" style={{ background: 'var(--sticky-1)', transform: 'rotate(-1.1deg)' }}>
              <b>The board</b>Drag projects from pending to done — the whole room sees it.
            </div>
            <div className="wg-sticky" style={{ background: 'var(--sticky-2)', transform: 'rotate(0.9deg)' }}>
              <b>Media &amp; scripts</b>Clips stream in place; scripts keep a frozen copy at Review and Final.
            </div>
            <div className="wg-sticky" style={{ background: 'var(--sticky-4)', transform: 'rotate(-0.8deg)' }}>
              <b>Viewer links</b>Clients click a link and look — no account, no password.
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
