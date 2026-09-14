// Admin: app users, viewer capability tokens, workspace settings, and
// maintenance/health tooling. Every action re-asserts the admin role itself —
// the UI gate below is orientation, not security.

import { useEffect, useState } from 'react'
import { useStore } from '../../sync/store'
import { banner, CopyButton, Empty, IssueBanner, Modal, TokenReveal, useDebouncedCommit } from '../components'
import { canAdmin } from '../../auth/session'
import { getBearerToken } from '../../auth/tokenClient'
import {
  createAppUser,
  mintViewerToken,
  resetUserPassword,
  revokeViewer,
  setApiKeyOverride,
  setUserDisabled,
  updateSettings,
} from '../../state/actions'
import {
  createUserPermission,
  deletePermission,
  listPermissions,
  type DrivePermission,
} from '../../drive/client'
import { BUCKETS, ROLES, type Bucket, type NexusDoc, type Role } from '../../types/schema'
import { runHealthChecks, type HealthIssue } from '../../diagnostics/health'
import { workspaceUsesSystemFolders } from '../../drive/bootstrap'
import { writerId } from '../../sync/writer'
import { hlcNow } from '../../util/hlc'

type Tab = 'users' | 'viewers' | 'settings' | 'maintenance'

const TABS: { id: Tab; label: string }[] = [
  { id: 'users', label: 'Users' },
  { id: 'viewers', label: 'Viewers' },
  { id: 'settings', label: 'Settings' },
  { id: 'maintenance', label: 'Maintenance' },
]

const loginLink = (raw: string, rootFolderId?: string): string =>
  `https://${location.host}/#/login?vw=${raw}${rootFolderId ? `&t=${rootFolderId}` : ''}`

const slugify = (label: string): string =>
  label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')

/** Formats HLC stamps ("<ms>.<counter>") and ISO stamps alike. */
function fmtWhen(stamp: string, withTime = false): string {
  const ms = Number(stamp.split('.')[0])
  const d = Number.isFinite(ms) && ms > 1e12 ? new Date(ms) : new Date(stamp)
  return Number.isNaN(d.getTime()) ? '—' : withTime ? d.toLocaleString() : d.toLocaleDateString()
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function Admin(): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const session = useStore((s) => s.session)
  const [tab, setTab] = useState<Tab>('users')

  if (!doc) return <></>

  if (!canAdmin()) {
    return (
      <div>
        <div className="content-header">
          <div>
            <h1>Admin</h1>
            <div className="sub">Users · viewer tokens · settings · maintenance</div>
          </div>
        </div>
        <div className="card">
          <Empty icon="🔒">
            <h2>Admin login required</h2>
            <p className="muted" style={{ maxWidth: 480, margin: '8px auto 0' }}>
              {session
                ? `You're signed in as ${session.name} (${session.role}). Only admins can manage users, viewer tokens, settings and maintenance — ask an admin, or sign in with an admin secret.`
                : 'Sign in with an admin token or password to manage users, viewer tokens, settings and maintenance.'}
            </p>
          </Empty>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="content-header">
        <div>
          <h1>Admin</h1>
          <div className="sub">
            {doc.users.app.length} user{doc.users.app.length === 1 ? '' : 's'} ·{' '}
            {doc.users.viewers.filter((v) => !v.revokedAt).length} active viewer token
            {doc.users.viewers.filter((v) => !v.revokedAt).length === 1 ? '' : 's'}
          </div>
        </div>
      </div>

      <div className="chips mb8">
        {TABS.map((t) => (
          <button key={t.id} className={`chip ${tab === t.id ? 'on' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'users' && <UsersTab doc={doc} />}
      {tab === 'viewers' && <ViewersTab doc={doc} />}
      {tab === 'settings' && <SettingsTab doc={doc} />}
      {tab === 'maintenance' && <MaintenanceTab doc={doc} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

function UsersTab({ doc }: { doc: NexusDoc }): React.JSX.Element {
  const [adding, setAdding] = useState(false)
  const [resetting, setResetting] = useState<{ id: string; name: string } | null>(null)

  return (
    <>
      <div className="card">
        <div className="spread mb8">
          <h2>App users</h2>
          <button className="btn primary" onClick={() => setAdding(true)}>Add user</button>
        </div>

      {doc.users.app.length === 0 ? (
        <Empty icon="◍">
          No users yet — add a teammate and hand them the minted token or password.
        </Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Created</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {doc.users.app.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td><span className={`badge ${u.role === 'admin' ? 'label' : ''}`}>{u.role}</span></td>
                <td className="muted small">{fmtWhen(u.createdAt)}</td>
                <td>
                  {u.disabled
                    ? <span className="badge red">disabled</span>
                    : <span className="badge done">active</span>}
                </td>
                <td>
                  <span className="row">
                    <button
                      className="btn small"
                      onClick={() => {
                        const verb = u.disabled ? 'Enable' : 'Disable'
                        if (confirm(`${verb} ${u.name}'s account?${!u.disabled ? ' Their active sessions sign out within one poll.' : ''}`)) {
                          try {
                            setUserDisabled(u.id, !u.disabled)
                          } catch (e) {
                            alert(e instanceof Error ? e.message : 'Action failed')
                          }
                        }
                      }}
                    >
                      {u.disabled ? 'Enable' : 'Disable'}
                    </button>
                    <button className="btn small" onClick={() => setResetting({ id: u.id, name: u.name })}>
                      Reset secret…
                    </button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {adding && <AddUserModal onClose={() => setAdding(false)} />}
      {resetting && <ResetSecretModal user={resetting} onClose={() => setResetting(null)} />}
      </div>
      <DriveSharingCard doc={doc} />
    </>
  )
}

/** Drive-level share for editors: their Google account needs Editor on the
 *  Nexus Root folder before the app's picker connect can grant write access.
 *  This card does what the Drive "Share" dialog does, without leaving Nexus. */
function DriveSharingCard({ doc }: { doc: NexusDoc }): React.JSX.Element {
  const rootId = doc.ids.rootFolderId
  const [perms, setPerms] = useState<DrivePermission[] | null>(null)
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const load = async () => {
    try {
      setPerms(await listPermissions(rootId, { mode: 'bearer' }))
      setError(null)
    } catch (e) {
      setPerms([])
      setError(errText(e))
    }
  }
  useEffect(() => { void load() }, [rootId])

  const people = (perms ?? []).filter((p) => p.type === 'user' && p.role !== 'organizer' && p.role !== 'owner')
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  const googleReady = getBearerToken() !== null

  const share = async () => {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      await createUserPermission(rootId, email.trim(), 'writer', { mode: 'bearer' })
      setNote(
        `Invite sent to ${email.trim()}. They sign in with that Google account and click "Connect workspace folder" in the app — once; Google remembers it.`,
      )
      setEmail('')
      await load()
    } catch (e) {
      setError(errText(e))
    }
    setBusy(false)
  }

  const revoke = async (p: DrivePermission) => {
    if (!confirm(`Remove ${p.emailAddress ?? p.id}'s access to the Nexus Root folder on Drive?`)) return
    setError(null)
    try {
      await deletePermission(rootId, p.id, { mode: 'bearer' })
      await load()
    } catch (e) {
      setError(errText(e))
    }
  }

  return (
    <div className="card">
      <h2>Drive folder sharing</h2>
      <p className="muted small" style={{ maxWidth: 640 }}>
        The workspace lives in the studio account&apos;s Drive. To let an editor work, share the Nexus Root folder with their
        Gmail address here — then the next time the app shows them the connect banner, their own Google account can pick the
        folder and Google remembers the grant. The in-app role above decides what they may touch; this share only decides
        whether their Google account can connect at all.
      </p>

      {!googleReady && banner('warn', 'Not signed in to Google', 'Sharing needs the studio Google session — click Reconnect in the header, then reload this page.')}
      {note && banner('info', note)}
      {error && banner('error', error)}

      <div className="row wrap mt8">
        <input
          className="input"
          style={{ maxWidth: 320 }}
          type="email"
          placeholder="editor@gmail.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && valid && !busy && void share()}
          disabled={!googleReady}
        />
        <button className="btn primary" disabled={busy || !valid || !googleReady} onClick={() => void share()}>
          {busy ? 'Sharing…' : 'Share as editor'}
        </button>
      </div>

      {perms === null ? (
        <p className="muted small mt8">Loading shares…</p>
      ) : people.length === 0 ? (
        <p className="muted small mt8">No individual Google accounts have access yet.</p>
      ) : (
        <table className="table mt8">
          <thead>
            <tr>
              <th>Google account</th>
              <th>Drive role</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.id}>
                <td>{p.emailAddress ?? p.id}</td>
                <td><span className="badge">{p.role === 'writer' ? 'editor' : p.role}</span></td>
                <td>
                  <button className="btn small danger" onClick={() => void revoke(p)}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function AddUserModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [name, setName] = useState('')
  const [role, setRole] = useState<Role>('editor')
  const [mode, setMode] = useState<'token' | 'password'>('token')
  const [pw, setPw] = useState('')
  const [reveal, setReveal] = useState<{ raw: string; kind: 'token' | 'password' } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const { raw } =
        mode === 'token' ? await createAppUser(name.trim(), role) : await createAppUser(name.trim(), role, pw)
      setReveal({ raw, kind: mode })
    } catch (e) {
      setError(errText(e))
    }
    setBusy(false)
  }

  return (
    <Modal title="Add user" onClose={onClose}>
      {reveal ? (
        <>
          <p className="muted small">
            {name.trim()} can sign in now. Hand over the secret through a safe channel.
          </p>
          <TokenReveal
            raw={reveal.raw}
            kind={reveal.kind}
            link={reveal.kind === 'token' ? loginLink(reveal.raw) : undefined}
          />
          <div className="row mt16">
            <button className="btn primary" onClick={onClose}>Done</button>
          </div>
        </>
      ) : (
        <>
          <div className="field">
            <label>Name</label>
            <input
              className="input"
              autoFocus
              placeholder="Who is this?"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="field">
            <label>Role</label>
            <select className="input" style={{ maxWidth: 200 }} value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}{r === 'admin' ? ' — users, tokens, settings' : r === 'editor' ? ' — full content access' : ' — content access, no admin'}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Secret</label>
            <div className="chips mb8">
              <button className={`chip ${mode === 'token' ? 'on' : ''}`} onClick={() => setMode('token')}>
                Minted token
              </button>
              <button className={`chip ${mode === 'password' ? 'on' : ''}`} onClick={() => setMode('password')}>
                Typed password
              </button>
            </div>
            {mode === 'password' && (
              <input
                className="input mono"
                placeholder="password (only its hash is stored)"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
              />
            )}
          </div>
          {error && banner('error', error)}
          <div className="row mt16">
            <button
              className="btn primary"
              disabled={busy || !name.trim() || (mode === 'password' && !pw.trim())}
              onClick={() => void create()}
            >
              {busy ? 'Creating…' : 'Create user'}
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}

function ResetSecretModal(
  { user, onClose }: { user: { id: string; name: string }; onClose: () => void },
): React.JSX.Element {
  const [reveal, setReveal] = useState<{ raw: string; kind: 'token' | 'password' } | null>(null)
  const [pw, setPw] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reset = async (secret: string | undefined) => {
    setBusy(true)
    setError(null)
    try {
      const { raw } = await resetUserPassword(user.id, secret)
      setReveal({ raw, kind: secret === undefined ? 'token' : 'password' })
      setPw('')
    } catch (e) {
      setError(errText(e))
    }
    setBusy(false)
  }

  return (
    <Modal title={`Reset secret — ${user.name}`} onClose={onClose}>
      {reveal ? (
        <>
          <TokenReveal
            raw={reveal.raw}
            kind={reveal.kind}
            link={reveal.kind === 'token' ? loginLink(reveal.raw) : undefined}
          />
          <div className="row mt16">
            <button className="btn primary" onClick={onClose}>Done</button>
          </div>
        </>
      ) : (
        <>
          <p className="muted small">
            The old token or password stops working immediately; sessions signed in with it are
            logged out on their next check.
          </p>
          <div className="row wrap mb8">
            <button className="btn primary" disabled={busy} onClick={() => void reset(undefined)}>
              Reset with new token
            </button>
          </div>
          <div className="field">
            <label>…or set a password</label>
            <div className="row wrap">
              <input
                className="input mono"
                style={{ maxWidth: 260 }}
                placeholder="new password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
              />
              <button className="btn" disabled={busy || !pw.trim()} onClick={() => void reset(pw)}>
                Set password
              </button>
            </div>
          </div>
          {error && banner('error', error)}
        </>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Viewers
// ---------------------------------------------------------------------------

function ViewersTab({ doc }: { doc: NexusDoc }): React.JSX.Element {
  const [minting, setMinting] = useState(false)

  return (
    <div className="card">
      <div className="spread mb8">
        <h2>Viewer tokens</h2>
        <button className="btn primary" onClick={() => setMinting(true)}>Mint viewer token</button>
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>
        Viewer tokens are read-only capability links — whoever holds the link can see the dashboard
        until the token is revoked.
      </p>

      {doc.users.viewers.length === 0 ? (
        <Empty icon="🞂">
          No viewer tokens yet — mint one and send the login link to a client.
        </Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Note</th>
              <th>Created</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {doc.users.viewers.map((v) => (
              <tr key={v.id}>
                <td>{v.name}</td>
                <td className="muted small">{v.note || '—'}</td>
                <td className="muted small">{fmtWhen(v.createdAt)}</td>
                <td>
                  {v.revokedAt
                    ? <span className="badge red">revoked</span>
                    : <span className="badge done">active</span>}
                </td>
                <td>
                  {!v.revokedAt && (
                    <button
                      className="btn small danger"
                      onClick={() => {
                        if (
                          confirm(
                            `Revoke "${v.name}"? Revocation takes effect at the viewer's next poll — ` +
                            'and anyone who already loaded content keeps their local copy; it cannot be clawed back.',
                          )
                        ) {
                          revokeViewer(v.id)
                        }
                      }}
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {minting && (
        <MintViewerModal rootFolderId={doc.ids.rootFolderId} onClose={() => setMinting(false)} />
      )}
    </div>
  )
}

function MintViewerModal(
  { rootFolderId, onClose }: { rootFolderId: string; onClose: () => void },
): React.JSX.Element {
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [reveal, setReveal] = useState<{ raw: string; link: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const mint = async () => {
    setBusy(true)
    setError(null)
    try {
      const { raw } = await mintViewerToken(name.trim(), note.trim())
      setReveal({ raw, link: loginLink(raw, rootFolderId) })
    } catch (e) {
      setError(errText(e))
    }
    setBusy(false)
  }

  return (
    <Modal title="Mint viewer token" onClose={onClose}>
      {reveal ? (
        <>
          <p className="muted small">Send this login link — opening it signs the viewer straight in.</p>
          <TokenReveal raw={reveal.raw} kind="token" link={reveal.link} />
          <div className="row mt16">
            <button className="btn primary" onClick={onClose}>Done</button>
          </div>
        </>
      ) : (
        <>
          <div className="field">
            <label>Name</label>
            <input
              className="input"
              autoFocus
              placeholder="Who is this for?"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="field">
            <label>Note (for you)</label>
            <input
              className="input"
              placeholder="e.g. Acme review link, expires when the project wraps"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          {error && banner('error', error)}
          <div className="row mt16">
            <button className="btn primary" disabled={busy || !name.trim()} onClick={() => void mint()}>
              {busy ? 'Minting…' : 'Mint token'}
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function SettingsTab({ doc }: { doc: NexusDoc }): React.JSX.Element {
  const [newLabel, setNewLabel] = useState('')
  const [newId, setNewId] = useState('')
  const [newBucket, setNewBucket] = useState<Bucket>('todo')
  const [labelDraft, setLabelDraft] = useState('')
  const [keyDraft, setKeyDraft] = useState(doc.settings.api.keyOverride ?? '')
  const [keySaved, setKeySaved] = useState(false)
  const commitLabel = useDebouncedCommit(800)

  const addLabel = () => {
    const v = labelDraft.trim()
    if (!v) return
    updateSettings((s) => {
      s.labels = [...new Set([...s.labels, v])]
    })
    setLabelDraft('')
  }

  const addStage = () => {
    const label = newLabel.trim()
    const id = newId.trim()
    if (!label || !id || doc.settings.pipeline.some((p) => p.id === id)) return
    updateSettings((s) => {
      s.pipeline = [...s.pipeline, { id, label, bucket: newBucket }]
    })
    setNewLabel('')
    setNewId('')
    setNewBucket('todo')
  }

  return (
    <div>
      <div className="card">
        <h2>Pipeline</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Stages keep their id forever — items reference it. Editing a label or bucket is safe; new
          stages append at the end, and removing one never renumbers the others.
        </p>
        {doc.settings.pipeline.length === 0 ? (
          <Empty icon="▤">No stages — items need at least one. Add one below.</Empty>
        ) : (
          doc.settings.pipeline.map((stage, i) => (
            <div
              className="row wrap mb8"
              key={stage.id}
              style={{ background: 'var(--bg-raised)', padding: '7px 10px', borderRadius: 8 }}
            >
              <input
                className="input"
                style={{ maxWidth: 220 }}
                value={stage.label}
                onChange={(e) => {
                  const value = e.target.value
                  commitLabel((d) => {
                    const entry = d.settings.pipeline[i]
                    if (!entry) return
                    entry.label = value
                    d.settings.updatedAt = hlcNow()
                    d.settings.writerId = writerId()
                  })
                }}
              />
              <select
                className="input"
                style={{ maxWidth: 130 }}
                value={stage.bucket}
                onChange={(e) =>
                  updateSettings((s) => {
                    const entry = s.pipeline[i]
                    if (entry) entry.bucket = e.target.value as Bucket
                  })
                }
              >
                {BUCKETS.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
              <span className="mono faint small">{stage.id}</span>
              <span style={{ marginLeft: 'auto' }}>
                <button
                  className="btn small ghost"
                  onClick={() =>
                    updateSettings((s) => {
                      s.pipeline.splice(i, 1)
                    })
                  }
                >
                  Remove
                </button>
              </span>
            </div>
          ))
        )}
        <div className="row wrap mt8">
          <input
            className="input"
            style={{ maxWidth: 220 }}
            placeholder="New stage label…"
            value={newLabel}
            onChange={(e) => {
              setNewLabel(e.target.value)
              setNewId(slugify(e.target.value))
            }}
          />
          <input
            className="input mono"
            style={{ maxWidth: 170 }}
            placeholder="id"
            title="Stage id — slugified from the label, never renumbered later"
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
          />
          <select
            className="input"
            style={{ maxWidth: 130 }}
            value={newBucket}
            onChange={(e) => setNewBucket(e.target.value as Bucket)}
          >
            {BUCKETS.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
          <button
            className="btn"
            disabled={!newLabel.trim() || !newId.trim() || doc.settings.pipeline.some((p) => p.id === newId.trim())}
            onClick={addStage}
          >
            Add stage
          </button>
        </div>
      </div>

      <div className="card">
        <h2>Labels</h2>
        <div className="chips mb8">
          {doc.settings.labels.length === 0 && <span className="faint small">No labels yet.</span>}
          {doc.settings.labels.map((l) => (
            <span
              key={l}
              className="chip on"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 6px 3px 11px' }}
            >
              {l}
              <button
                className="btn ghost small"
                style={{ border: 'none', padding: '0 3px', color: 'inherit', lineHeight: 1 }}
                aria-label={`Remove label ${l}`}
                onClick={() =>
                  updateSettings((s) => {
                    s.labels = s.labels.filter((x) => x !== l)
                  })
                }
              >
                ✕
              </button>
            </span>
          ))}
        </div>
        <div className="row wrap">
          <input
            className="input"
            style={{ maxWidth: 200 }}
            placeholder="+ new label"
            value={labelDraft}
            onChange={(e) => setLabelDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addLabel()}
          />
          <button className="btn small" disabled={!labelDraft.trim()} onClick={addLabel}>
            Add label
          </button>
        </div>
      </div>

      <div className="card">
        <h2>Privacy</h2>
        <label className="row" style={{ gap: 8, fontSize: 13.5, marginBottom: 4 }}>
          <input
            type="checkbox"
            checked={doc.settings.privacy.requireViewerLogin}
            onChange={(e) =>
              updateSettings((s) => {
                s.privacy.requireViewerLogin = e.target.checked
              })
            }
          />
          Require login to view
        </label>
        <div className="muted small">OFF: anyone with the site URL sees the dashboard anonymously.</div>
        <label className="row" style={{ gap: 8, fontSize: 13.5, marginTop: 8, marginBottom: 0 }}>
          <input
            type="checkbox"
            checked={doc.settings.privacy.redactNames}
            onChange={(e) =>
              updateSettings((s) => {
                s.privacy.redactNames = e.target.checked
              })
            }
          />
          Redact names on the dashboard
        </label>
        <div className="muted small">Hides assignee and user names from viewers and anonymous visitors.</div>
      </div>

      <div className="card">
        <h2>Drive API key override</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Read-only viewers fetch through this key. Blank = the key baked into the build.
        </p>
        <div className="row wrap mb8">
          <input
            className="input mono"
            style={{ maxWidth: 420 }}
            placeholder="AIza…"
            value={keyDraft}
            onChange={(e) => {
              setKeyDraft(e.target.value)
              setKeySaved(false)
            }}
          />
          <button
            className="btn primary"
            onClick={() => {
              setApiKeyOverride(keyDraft.trim() || null)
              setKeySaved(true)
            }}
          >
            Save
          </button>
          {keySaved && <span className="small muted">Saved — takes effect on the next read.</span>}
        </div>
        <div className="muted small">
          Rotation order: create the new key in Google Cloud → set it here → verify reads work →
          revoke the old key LAST.
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

function MaintenanceTab({ doc }: { doc: NexusDoc }): React.JSX.Element {
  const [issues, setIssues] = useState<HealthIssue[] | null>(null)
  const [running, setRunning] = useState(false)
  const [reorgState, setReorgState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [reorgMsg, setReorgMsg] = useState<string | null>(null)
  const reorganized = workspaceUsesSystemFolders(doc)

  const reorganize = async () => {
    if (!confirm(
      'Reorganize the Drive workspace into system folders?\n\n' +
      'Creates master/, projects/, scripts/ and Unsorted/ inside the workspace folder and moves nexus.json into master/.\n\n' +
      'File IDs never change — the app, links and .env keep working. No content is deleted.',
    )) return
    setReorgState('busy')
    try {
      const { migrateWorkspaceFolders } = await import('../../drive/bootstrap')
      const r = await migrateWorkspaceFolders({ mode: 'bearer' })
      setReorgMsg(`Done — folders created: ${r.created.length ? r.created.join(', ') : 'none (already existed)'}; nexus.json ${r.movedNexus ? 'moved into master/' : 'was already in place'}.`)
      setReorgState('done')
    } catch (e) {
      setReorgMsg(errText(e))
      setReorgState('error')
    }
  }

  const run = async () => {
    setRunning(true)
    try {
      setIssues(await runHealthChecks({ deep: true }))
    } catch (e) {
      setIssues([
        { level: 'error', code: 'checkFailed', message: 'Health check crashed', fix: errText(e) },
      ])
    }
    setRunning(false)
  }

  const ids: [string, string][] = [
    ['Root folder id', doc.ids.rootFolderId],
    ['nexus.json file id', doc.ids.nexusFileId],
  ]
  const snapshots = [...doc.snapshots].reverse()

  return (
    <div>
      <div className="card">
        <div className="spread mb8">
          <h2>Drive layout</h2>
          {reorganized ? (
            <span className="badge done">organized</span>
          ) : (
            <button className="btn primary" disabled={reorgState === 'busy'} onClick={() => void reorganize()}>
              {reorgState === 'busy' ? 'Reorganizing…' : 'Reorganize into system folders'}
            </button>
          )}
        </div>
        <p className="muted small" style={{ marginTop: 0 }}>
          Creates <code>master/</code> (nexus.json), <code>projects/</code>, <code>scripts/</code> and{' '}
          <code>Unsorted/</code> inside the workspace folder. File IDs never change — the app, links and
          .env keep working; nothing is deleted.
        </p>
        {reorgMsg && banner(reorgState === 'error' ? 'error' : 'info', reorgMsg)}
      </div>

      <div className="card">
        <div className="spread mb8">
          <h2>Health checks</h2>
          <button className="btn primary" disabled={running} onClick={() => void run()}>
            {running ? 'Running…' : 'Run health checks'}
          </button>
        </div>
        {issues === null ? (
          <span className="muted small">
            Probes origin, build config, the Drive API key path, link-sharing and doc size. The app
            also runs these automatically every 30 seconds.
          </span>
        ) : issues.length === 0 ? (
          <Empty icon="✓">All checks passed.</Empty>
        ) : (
          issues.map((issue, i) => <IssueBanner key={issue.code + String(i)} issue={issue} />)
        )}
      </div>

      <div className="card">
        <div className="spread mb8">
          <h2>Reset workspace data</h2>
          <button
            className="btn danger"
            onClick={async () => {
              const msg =
                'Wipe ALL groups, projects and scripts?\n\n' +
                'Their Drive files move to Drive trash (30-day recovery). Your login, settings and the workspace itself are kept.'
              if (!confirm(msg)) return
              try {
                const { resetWorkspaceData } = await import('../../state/actions')
                const r = await resetWorkspaceData()
                alert(`Wiped: ${r.groups} groups, ${r.projects} projects, ${r.scripts} scripts. Drive files are in Drive trash.`)
              } catch (e) {
                alert(e instanceof Error ? e.message : 'Wipe failed')
              }
            }}
          >
            Wipe workspace data
          </button>
        </div>
        <p className="muted small" style={{ marginTop: 0 }}>
          Removes every group, project and script from the database and moves their Drive files to trash.
          Your login, other users, settings and the workspace folders are kept. For starting over while testing.
        </p>
      </div>

      <div className="card">
        <h2>Workspace ids</h2>
        {ids.map(([label, id]) => (
          <div
            className="row spread mb8"
            key={label}
            style={{ background: 'var(--bg-raised)', padding: '7px 10px', borderRadius: 8 }}
          >
            <span className="small muted" style={{ minWidth: 130 }}>{label}</span>
            <span className="mono small" style={{ wordBreak: 'break-all', flex: 1 }}>
              {id || '—'}
            </span>
            {id && <CopyButton text={id} label="Copy" />}
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Snapshots</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Daily copies of nexus.json kept in the Drive “snapshots” folder, newest first.
        </p>
        {snapshots.length === 0 ? (
          <Empty icon="🗂">No snapshots yet — the first appears after the first successful sync.</Empty>
        ) : (
          <div className="small muted">
            {snapshots.map((s) => (
              <div className="row spread mb8" key={s.fileId}>
                <span>
                  {s.note || 'snapshot'} · rev {s.rev} · {fmtWhen(s.at, true)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
