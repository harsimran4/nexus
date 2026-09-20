import { useEffect, useState } from 'react'
import { loginWithSecret } from '../../auth/session'
import { navigate } from '../../App'
import { banner, SecretInput } from '../components'
import { useStore } from '../../sync/store'

export function Login({ viewerTokenFromLink }: { viewerTokenFromLink: string | null }): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const [secret, setSecret] = useState(viewerTokenFromLink ?? '')
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
    <div className="card letterhead">
      <span className="eyebrow">Nexus Studio</span>
      <h1 style={{ marginBottom: 2 }}>Nexus</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Sign in with the access token or password your admin gave you.
      </p>
      <div className="field">
        <label>Access token or password</label>
        <SecretInput
          className="input mono"
          autoFocus
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
          placeholder="nexus token or password"
        />
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
