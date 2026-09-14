import { useEffect, useState } from 'react'
import { loginWithSecret } from '../../auth/session'
import { navigate } from '../../App'
import { banner } from '../components'
import { useStore } from '../../sync/store'

export function Login({ viewerTokenFromLink }: { viewerTokenFromLink: string | null }): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const [secret, setSecret] = useState(viewerTokenFromLink ?? '')
  const [showSecret, setShowSecret] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // A login link with a valid token signs straight in.
    if (!viewerTokenFromLink || !doc) return
    void (async () => {
      const result = await loginWithSecret(viewerTokenFromLink)
      if (result.ok) navigate('dash')
      else setError(result.error)
    })()
  }, [viewerTokenFromLink, doc])

  const submit = async () => {
    setBusy(true)
    setError(null)
    const result = await loginWithSecret(secret)
    setBusy(false)
    if (result.ok) navigate('dash')
    else setError(result.error)
  }

  return (
    <div className="card">
      <h1 style={{ marginBottom: 2 }}>Nexus</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Sign in with the access token or password your admin gave you.
      </p>
      <div className="field">
        <label>Access token or password</label>
        <div className="secret-wrap">
          <input
            className="input mono"
            type={showSecret ? 'text' : 'password'}
            autoFocus
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
            placeholder="nexus token or password"
            spellCheck={false}
          />
          <button
            type="button"
            className="eye-btn"
            onClick={() => setShowSecret((v) => !v)}
            aria-label={showSecret ? 'Hide secret' : 'Show secret'}
            aria-pressed={showSecret}
            title={showSecret ? 'Hide secret' : 'Show secret'}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {showSecret ? (
                <>
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                  <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                  <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </>
              ) : (
                <>
                  <path d="M1 12s4-7.5 11-7.5S23 12 23 12s-4 7.5-11 7.5S1 12 1 12z" />
                  <circle cx="12" cy="12" r="3" />
                </>
              )}
            </svg>
          </button>
        </div>
      </div>
      {error && banner('error', error)}
      <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }} disabled={busy || !secret.trim()} onClick={() => void submit()}>
        {busy ? 'Checking…' : 'Sign in'}
      </button>
      <p className="faint small mt16">
        Tokens are single secrets — only their hash is stored on Drive. Lost yours? Ask an admin to mint a new one.
      </p>
    </div>
  )
}
