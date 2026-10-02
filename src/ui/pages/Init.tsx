import { useRef, useState } from 'react'
import { mintToken, newStretchSalt, passwordPolicyError, stretchedAuth } from '../../auth/hashing'
import { emptyDoc, parseDoc, type NexusDoc } from '../../types/schema'
import { SYSTEM_PREFIXES } from '../../types/storage'
import { DOC_KEY } from '../../server/keys'
import { initFn } from '../../server/fns'
import { hlcNow } from '../../util/hlc'
import { newUserId, newDeviceId } from '../../util/id'
import { useStore } from '../../sync/store'
import { startPolling } from '../../sync/poller'
import { navigate } from '../../nav'
import { banner, PageQuote, SecretInput } from '../components'

type Step = 0 | 1

export function Init(): React.JSX.Element {
  const [step, setStep] = useState<Step>(0)
  const [setupToken, setSetupToken] = useState('')
  const [adminName, setAdminName] = useState('')
  const [secretMode, setSecretMode] = useState<'token' | 'password'>('password')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loginRef = useRef<Promise<unknown> | null>(null)

  const create = async () => {
    setError(null)
    if (!setupToken.trim()) {
      setError('Enter the setup token (SETUP_TOKEN on the Worker — `wrangler secret put SETUP_TOKEN`)')
      return
    }
    if (!adminName.trim()) {
      setError('Enter an admin name')
      return
    }
    const stretchSalt = newStretchSalt()
    let auth: NexusDoc['users']['app'][number]['auth']
    let rawSecret: string
    if (secretMode === 'token') {
      const minted = await mintToken()
      auth = await stretchedAuth(minted.raw, stretchSalt)
      rawSecret = minted.raw
    } else {
      const policy = passwordPolicyError(password)
      if (policy) {
        setError(policy)
        return
      }
      auth = await stretchedAuth(password, stretchSalt)
      rawSecret = password
    }
    setBusy(true)
    try {
      const doc = emptyDoc()
      doc.settings.authStretchSalt = stretchSalt
      doc.users.app = [
        {
          id: newUserId(),
          name: adminName.trim(),
          role: 'admin',
          disabled: false,
          auth,
          createdAt: hlcNow(),
          createdBy: 'bootstrap',
        },
      ]
      doc.writerId = `bootstrap|${newDeviceId()}|init`
      doc.updatedAt = hlcNow()

      // The server validates SETUP_TOKEN, refuses when a workspace already
      // exists, creates the system-folder markers, stamps ids, and writes
      // master/nexus.json.
      const result = await initFn({ data: { setupToken: setupToken.trim(), doc: JSON.parse(JSON.stringify(doc)) } })
      if (!result.ok) {
        setError(result.message)
        return
      }
      // Re-parse the fully-formed doc (with ids) so the app boots on it directly.
      const done = { ...doc, ids: { rootFolderId: '', nexusFileId: DOC_KEY, systemFolders: { ...SYSTEM_PREFIXES } } }
      const parsed = parseDoc(JSON.stringify(done))
      if (!parsed.ok) {
        setError('Workspace created but could not be loaded — reload the page and sign in')
        return
      }
      // Doc goes into the store, but status STAYS needsInit: that is what
      // keeps THIS card mounted — the shell and the login gate only take
      // over at status 'ok', which happens on "Go to dashboard".
      useStore.getState().setDoc(parsed.doc)
      startPolling(DOC_KEY)
      // Reveal the secret BEFORE any async login — a slow or failed
      // auto-login must never eat the one-time display. The auto-login runs
      // in the background; the dashboard button awaits it before flipping
      // status, so a successful login skips the login gate.
      sessionStorage.setItem('nexus.initSecret', rawSecret)
      loginRef.current = import('../../auth/session')
        .then((s) => s.loginWithSecretPublic(rawSecret))
        .catch(() => null)
      setStep(1)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Workspace creation failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <h1>Welcome to Nexus</h1>
      <p className="muted">Initialize your content workspace in object storage. One-time, admin only.</p>
      <PageQuote topic="setup" />

      {step === 0 && (
        <>
          <div className="steps">
            <div className="step"><span className="n">1</span> Paste the one-time setup token (a Worker secret — SETUP_TOKEN).</div>
            <div className="step"><span className="n">2</span> Nexus creates the system folders in the bucket and stores all metadata in one master/nexus.json.</div>
            <div className="step"><span className="n">3</span> You create the first admin login. Everyone else gets logins from the Admin page.</div>
          </div>
          <div className="field">
            <label>Setup token</label>
            <SecretInput className="input" value={setupToken} onChange={(e) => setSetupToken(e.target.value)} placeholder="SETUP_TOKEN" />
          </div>
          <div className="field">
            <label>Your (admin) name</label>
            <input className="input" value={adminName} onChange={(e) => setAdminName(e.target.value)} placeholder="e.g. Harsimran" />
          </div>
          <div className="field">
            <label>Admin login type</label>
            <div className="row">
              <button className={`chip ${secretMode === 'password' ? 'on' : ''}`} onClick={() => setSecretMode('password')}>Password</button>
              <button className={`chip ${secretMode === 'token' ? 'on' : ''}`} onClick={() => setSecretMode('token')}>Minted token</button>
            </div>
          </div>
          {secretMode === 'password' && (
            <div className="field">
              <label>Admin password (15+ chars, or 12+ with a space)</label>
              <SecretInput className="input" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
          )}
          {error && banner('error', error)}
          <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }} disabled={busy} onClick={() => void create()}>
            {busy ? 'Creating workspace…' : 'Create workspace'}
          </button>
        </>
      )}

      {step === 1 && (
        <>
          {banner('info', 'Workspace created', 'Content is private in the bucket; the app serves reads, and only signed-in editors can write.')}
          <InitSecret />
          <div className="row mt16">
            <button
              className="btn primary"
              onClick={() => {
                void (async () => {
                  await (loginRef.current ?? Promise.resolve())
                  useStore.getState().setStatus('ok') // releases the shell; session skips the login gate
                  navigate('dash')
                })()
              }}
            >
              Go to dashboard →
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function InitSecret(): React.JSX.Element | null {
  const [secret] = useState(() => sessionStorage.getItem('nexus.initSecret'))
  if (!secret) return null
  return (
    <div className="mt16">
      <p className="muted small">Your admin login secret — shown once, sign in with it below:</p>
      <div className="token-box">{secret}</div>
    </div>
  )
}
