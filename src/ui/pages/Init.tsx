import { useEffect, useState } from 'react'
import { requestToken, isSignedIn, onTokenChange, getBearerToken } from '../../auth/tokenClient'
import { mintToken, newStretchSalt, passwordPolicyError, stretchedAuth } from '../../auth/hashing'
import { createWorkspace, initialDoc } from '../../drive/bootstrap'
import { type NexusDoc } from '../../types/schema'
import { hlcNow } from '../../util/hlc'
import { newUserId, newDeviceId } from '../../util/id'
import { useStore } from '../../sync/store'
import { rememberIds } from '../../sync/drafts'
import { startPolling } from '../../sync/poller'
import { navigate } from '../../App'
import { banner, CopyButton, PageQuote, SecretInput } from '../components'
import { config } from '../../config'

type Step = 0 | 1 | 2

export function Init(): React.JSX.Element {
  const [step, setStep] = useState<Step>(isSignedIn() ? 1 : 0)
  const [rootName, setRootName] = useState('Nexus Root')
  const [adminName, setAdminName] = useState('')
  const [secretMode, setSecretMode] = useState<'token' | 'password'>('password')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<{ rootFolderId: string; nexusFileId: string; needsManualShare: boolean } | null>(null)

  useEffect(() => onTokenChange((si) => {
    if (si && step === 0) setStep(1)
  }), [step])

  const create = async () => {
    setError(null)
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
      // The token is memory-only and dies on reload — this click is a user
      // gesture, so silently re-mint it (or pop consent) before any Drive call.
      if (!isSignedIn()) {
        try {
          await requestToken({ silentFirst: true })
        } catch {
          setError('Your Google session ended — click "Sign in with Google" again, then retry')
          setBusy(false)
          return
        }
      }
      // Refuse to create a second workspace from this Google account — unless
      // the found nexus.json is unreadable by THIS app version (old format /
      // corrupted). In that case we reset: reuse the same root folder and
      // write a fresh database into it.
      const { findWorkspace } = await import('../../drive/bootstrap')
      const existing = await findWorkspace('', { mode: 'google', bearer: getBearerToken() })
      let existingRootId: string | null = null
      let oldBrokenNexusId: string | null = null
      if (existing?.rootFolderId) {
        if (existing.nexusFileId) {
          const { readFile } = await import('../../drive/client')
          const raw = await readFile(existing.nexusFileId, { mode: 'google', bearer: getBearerToken() }).catch(() => null)
          const parsed = raw ? (await import('../../types/schema')).parseDoc(raw) : null
          if (parsed?.ok) {
            setError(
              `A working workspace already exists on this account (root ${existing.rootFolderId.slice(0, 12)}…). ` +
                'Reload the app to open it, or delete its nexus.json on Drive to reset.',
            )
            setBusy(false)
            return
          }
          // Old format / broken — reset into the same folder.
          existingRootId = existing.rootFolderId
          oldBrokenNexusId = existing.nexusFileId
        } else {
          existingRootId = existing.rootFolderId
        }
      }
      const doc = initialDoc()
      doc.settings.rootFolderName = rootName.trim() || 'Nexus Root'
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
      const ws = await createWorkspace(doc, { mode: 'google', bearer: getBearerToken() }, existingRootId)
      if (oldBrokenNexusId && oldBrokenNexusId !== ws.nexusFileId) {
        // The unreadable old database goes to Drive trash (30-day recovery).
        const { trashFile } = await import('../../drive/client')
        await trashFile(oldBrokenNexusId, { mode: 'google', bearer: getBearerToken() }).catch(() => {})
      }
      // Re-parse the fully-formed doc (with ids) so the app boots on it directly.
      const { parseDoc } = await import('../../types/schema')
      const done = { ...doc, ids: { rootFolderId: ws.rootFolderId, nexusFileId: ws.nexusFileId ?? '' } }
      const parsed = parseDoc(JSON.stringify(done))
      if (parsed.ok) {
        useStore.getState().setDoc(parsed.doc)
        useStore.getState().setStatus('ok')
        startPolling(done.ids.nexusFileId)
        rememberIds(done.ids)
      }
      setCreated({
        rootFolderId: ws.rootFolderId,
        nexusFileId: done.ids.nexusFileId,
        needsManualShare: Boolean((ws as { needsManualShare?: boolean }).needsManualShare),
      })
      sessionStorage.setItem('nexus.initSecret', rawSecret)
      setStep(2)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Workspace creation failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <h1>Welcome to Nexus</h1>
      <p className="muted">Set up your content workspace on Google Drive. One-time, admin only.</p>
      <PageQuote topic="setup" />

      {step === 0 && (
        <>
          <div className="steps">
            <div className="step"><span className="n">1</span> Sign in with the Google account that will own the workspace (the studio account).</div>
            <div className="step"><span className="n">2</span> Nexus creates a Drive folder, link-shares it for read-only viewing, and stores all metadata in one nexus.json.</div>
            <div className="step"><span className="n">3</span> You create the first admin login. Everyone else gets logins from the Admin page.</div>
          </div>
          <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }} onClick={() => void requestToken().catch((e: unknown) => setError(e instanceof Error ? e.message : 'Sign-in failed'))}>
            Sign in with Google
          </button>
          {error && banner('error', error)}
        </>
      )}

      {step === 1 && (
        <>
          <div className="field">
            <label>Workspace folder name (on Drive)</label>
            <input className="input" value={rootName} onChange={(e) => setRootName(e.target.value)} />
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
            {busy ? 'Creating workspace…' : 'Create workspace on Drive'}
          </button>
        </>
      )}

      {step === 2 && created && (
        <>
          {created.needsManualShare
            ? banner('warn', 'Automatic link-sharing was blocked', 'Open the folder in Drive → Share → "Anyone with the link — Viewer". Viewer access will not work until then.')
            : banner('info', 'Workspace created', 'The Drive folder is link-shared "Viewer", so viewers can read; only signed-in editors can write.')}
          <InitSecret />
          <div className="field mt16">
            <label>Give these to whoever builds/deploys the app (paste into .env.local)</label>
            <div className="token-box">
              VITE_NEXUS_CLIENT_ID={config.clientId ? '(already set)' : '<your oauth client id>'}
              {'\n'}VITE_NEXUS_API_KEY={config.apiKey ? '(already set)' : '<your api key>'}
              {'\n'}VITE_NEXUS_ROOT_FOLDER_ID={created.rootFolderId}
              {'\n'}VITE_NEXUS_FILE_ID={created.nexusFileId}
            </div>
            <div className="row mt8">
              <CopyButton
                label="Copy .env block"
                text={`VITE_NEXUS_CLIENT_ID=${config.clientId}\nVITE_NEXUS_API_KEY=${config.apiKey}\nVITE_NEXUS_ROOT_FOLDER_ID=${created.rootFolderId}\nVITE_NEXUS_FILE_ID=${created.nexusFileId}`}
              />
              <a className="btn" href={`https://drive.google.com/drive/folders/${created.rootFolderId}`} target="_blank" rel="noreferrer">
                Open folder in Drive
              </a>
              <button className="btn primary" onClick={() => navigate('dash')}>Go to dashboard →</button>
            </div>
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
