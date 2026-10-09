// Admin: app users, viewer capability tokens, workspace settings, and
// maintenance/health tooling. Every action re-asserts the admin role itself —
// the UI gate below is orientation, not security.

import { useState } from 'react'
import { useStore, storeGet } from '../../sync/store'
import { banner, CopyButton, Empty, Icon, IssueBanner, Modal, SecretInput, TokenReveal, useDebouncedCommit, confirmDialog, toast } from '../components'
import { canAdmin } from '../../auth/session'
import {
  changeUserRole,
  createAppUser,
  deleteUser,
  mintViewerToken,
  resetUserPassword,
  restoreSnapshot,
  revokeViewer,
  setUserDisabled,
  updateSettings,
} from '../../state/actions'
import { BUCKETS, ROLES, type Bucket, type NexusDoc, type Role } from '../../types/schema'
import { runHealthChecks, type HealthIssue } from '../../diagnostics/health'
import { writerId } from '../../sync/writer'
import { hlcNow } from '../../util/hlc'
import { PageQuote } from '../components'

type Tab = 'users' | 'viewers' | 'settings' | 'maintenance'

const TABS: { id: Tab; label: string }[] = [
  { id: 'users', label: 'Users' },
  { id: 'viewers', label: 'Viewers' },
  { id: 'settings', label: 'Settings' },
  { id: 'maintenance', label: 'Maintenance' },
]

const loginLink = (raw: string): string => `${location.origin}/login?vw=${raw}`

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
      <div className="content-header" style={{ marginTop: 10 }}>
        <div>
          <h1>Admin</h1>
          <div className="sub">
            {doc.users.app.length} user{doc.users.app.length === 1 ? '' : 's'} ·{' '}
            {doc.users.viewers.filter((v) => !v.revokedAt).length} active viewer token
            {doc.users.viewers.filter((v) => !v.revokedAt).length === 1 ? '' : 's'}
          </div>
        </div>
      </div>

      <PageQuote topic="admin" />

      <div className="chips mb8" role="group" aria-label="Admin section">
        {TABS.map((t) => (
          <button key={t.id} className={`chip ${tab === t.id ? 'on' : ''}`} aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>
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
  const session = useStore((s) => s.session)
  const [adding, setAdding] = useState(false)
  const [resetting, setResetting] = useState<{ id: string; name: string } | null>(null)

  const setDisabled = (u: NexusDoc['users']['app'][number]): void => {
    void (async () => {
      const verb = u.disabled ? 'Enable' : 'Disable'
      const ok = await confirmDialog({
        title: `${verb} ${u.name}'s account?`,
        body: (
          <div className="confirm-body">
            <div className="confirm-what">
              {u.disabled ? 'They can sign in again right away.' : 'Their active sessions sign out within one poll.'}
            </div>
          </div>
        ),
        confirmLabel: verb,
      })
      if (!ok) return
      // The dialog can sit open while another admin removes the user — the
      // action silently no-ops then, which must not earn a success toast.
      if (!storeGet().doc?.users.app.some((x) => x.id === u.id)) return
      try {
        setUserDisabled(u.id, !u.disabled)
        toast.success(`“${u.name}” ${u.disabled ? 'enabled' : 'disabled'}`)
      } catch (e) {
        toast.error(errText(e))
      }
    })()
  }

  const removeUser = (u: NexusDoc['users']['app'][number]): void => {
    void (async () => {
      const ok = await confirmDialog({
        title: `Delete ${u.name}'s account?`,
        body: (
          <div className="confirm-body">
            <div className="confirm-what">Their login stops working immediately.</div>
            Stale devices can't bring it back.
          </div>
        ),
        confirmLabel: 'Delete user',
        tone: 'danger',
      })
      if (!ok) return
      // Same window as disable: gone is gone, and a no-op must not toast.
      if (!storeGet().doc?.users.app.some((x) => x.id === u.id)) return
      try {
        deleteUser(u.id)
        toast.success(`“${u.name}” deleted`)
      } catch (e) {
        toast.error(errText(e))
      }
    })()
  }

  return (
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
        <table className="table ledger">
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
            {doc.users.app.map((u) => {
              const isSelf = u.id === session?.appUserId
              return (
                <tr key={u.id}>
                  <td>{u.name}{isSelf && <span className="faint small"> (you)</span>}</td>
                  <td>
                    <select
                      className="input admin-role-select"
                      value={u.role}
                      disabled={isSelf}
                      title={isSelf ? 'Ask another admin to change your role' : 'Change role'}
                      onChange={(e) => {
                        try {
                          changeUserRole(u.id, e.target.value as Role)
                          toast.success(`“${u.name}” is now ${e.target.value}`)
                        } catch (err) {
                          toast.error(errText(err))
                        }
                      }}
                    >
                      {(['admin', 'editor', 'viewer'] as Role[]).map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                  </td>
                  <td className="muted small">{fmtWhen(u.createdAt)}</td>
                  <td>
                    {u.disabled
                      ? <span className="badge red">disabled</span>
                      : <span className="badge done">active</span>}
                  </td>
                  <td>
                    <span className="row">
                      <button className="btn small" onClick={() => setDisabled(u)}>
                        {u.disabled ? 'Enable' : 'Disable'}
                      </button>
                      <button className="btn small" onClick={() => setResetting({ id: u.id, name: u.name })}>
                        Reset secret…
                      </button>
                      {!isSelf && (
                        <button className="btn small danger" onClick={() => removeUser(u)}>
                          Delete
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {adding && <AddUserModal onClose={() => setAdding(false)} />}
      {resetting && <ResetSecretModal user={resetting} onClose={() => setResetting(null)} />}
    </div>
  )
}

function AddUserModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [name, setName] = useState('')
  const [role, setRole] = useState<Role>('editor')
  const [mode, setMode] = useState<'token' | 'password'>('token')
  const [pw, setPw] = useState('')
  const [reveal, setReveal] = useState<{ raw: string; kind: 'token' | 'password'; synced: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const { raw, synced } =
        mode === 'token' ? await createAppUser(name.trim(), role) : await createAppUser(name.trim(), role, pw)
      setReveal({ raw, kind: mode, synced })
    } catch (e) {
      setError(errText(e))
    }
    setBusy(false)
  }

  return (
    <Modal title="Add user" onClose={onClose}>
      {reveal ? (
        <>
          {!reveal.synced && banner('warn', 'Not synced yet', 'The account will retry automatically — the secret below works once it syncs.')}
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
            <select className="input admin-role-input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
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
              <button className={`chip ${mode === 'token' ? 'on' : ''}`} aria-pressed={mode === 'token'} onClick={() => setMode('token')}>
                Minted token
              </button>
              <button className={`chip ${mode === 'password' ? 'on' : ''}`} aria-pressed={mode === 'password'} onClick={() => setMode('password')}>
                Typed password
              </button>
            </div>
            {mode === 'password' && (
              <SecretInput
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
  const [reveal, setReveal] = useState<{ raw: string; kind: 'token' | 'password'; synced: boolean } | null>(null)
  const [pw, setPw] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reset = async (secret: string | undefined) => {
    setBusy(true)
    setError(null)
    try {
      const { raw, synced } = await resetUserPassword(user.id, secret)
      setReveal({ raw, kind: secret === undefined ? 'token' : 'password', synced })
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
          {!reveal.synced && banner('warn', 'Not synced yet', 'The new secret works once it syncs — it retries automatically.')}
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
              <SecretInput
                className="input mono admin-pw-input"
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

  const revoke = (v: NexusDoc['users']['viewers'][number]): void => {
    void (async () => {
      const ok = await confirmDialog({
        title: `Revoke “${v.name}”?`,
        body: (
          <div className="confirm-body">
            <div className="confirm-what">The link stops working at the viewer's next poll.</div>
            Anyone who already loaded content keeps their local copy — it cannot be clawed back.
          </div>
        ),
        confirmLabel: 'Revoke',
        tone: 'danger',
      })
      if (!ok) return
      try {
        revokeViewer(v.id)
        toast.success(`“${v.name}” revoked`)
      } catch (e) {
        toast.error(errText(e))
      }
    })()
  }

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
        <div className="ticket-grid">
          {doc.users.viewers.map((v) => (
            <div key={v.id} className={`ticket ${v.revokedAt ? 'ticket-revoked' : ''}`}>
              <div className="ticket-stub">
                <span className="ticket-caption">Admit one</span>
                <span className="mono faint" style={{ fontSize: 10 }}>{fmtWhen(v.createdAt)}</span>
              </div>
              <div className="ticket-body">
                <b style={{ fontSize: 14 }}>{v.name}</b>
                <span className="muted small" style={{ wordBreak: 'break-word' }}>{v.note || '—'}</span>
                {v.revokedAt ? (
                  <span className="badge red">revoked</span>
                ) : (
                  <span className="badge done">active · read-only</span>
                )}
                {!v.revokedAt && (
                  <button className="btn small danger" style={{ marginTop: 2 }} onClick={() => revoke(v)}>
                    Revoke
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {minting && <MintViewerModal onClose={() => setMinting(false)} />}
    </div>
  )
}

function MintViewerModal({ onClose }: { onClose: () => void }): React.JSX.Element {
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
      setReveal({ raw, link: loginLink(raw) })
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
            <div className="admin-row mb8" key={stage.id}>
              <input
                className="input admin-stage-label"
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
                className="input admin-stage-bucket"
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
            className="input admin-stage-label"
            placeholder="New stage label…"
            value={newLabel}
            onChange={(e) => {
              setNewLabel(e.target.value)
              setNewId(slugify(e.target.value))
            }}
          />
          <input
            className="input mono admin-stage-id"
            placeholder="id"
            title="Stage id — slugified from the label, never renumbered later"
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
          />
          <select
            className="input admin-stage-bucket"
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
            <span key={l} className="chip on admin-label-chip">
              {l}
              <button
                className="admin-label-x"
                aria-label={`Remove label ${l}`}
                onClick={() =>
                  updateSettings((s) => {
                    s.labels = s.labels.filter((x) => x !== l)
                  })
                }
              >
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
        </div>
        <div className="row wrap">
          <input
            className="input admin-label-input"
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
        <label className="admin-check-row mb8">
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
        <label className="admin-check-row mt8">
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
    </div>
  )
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

function MaintenanceTab({ doc }: { doc: NexusDoc }): React.JSX.Element {
  const [issues, setIssues] = useState<HealthIssue[] | null>(null)
  const [running, setRunning] = useState(false)
  const [snapBusy, setSnapBusy] = useState<string | null>(null)
  const [snapMsg, setSnapMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [backupBusy, setBackupBusy] = useState(false)
  const [storage, setStorage] = useState<{ bucket: string; endpoint: string; region: string } | null>(null)

  const downloadRaw = async (raw: string, filename: string): Promise<void> => {
    const blob = new Blob([raw], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  const downloadSnap = async (s: { fileId: string; note: string }): Promise<void> => {
    setSnapBusy(s.fileId)
    setSnapMsg(null)
    try {
      const { readFile } = await import('../../drive/client')
      const raw = await readFile(s.fileId)
      await downloadRaw(raw, `nexus-snapshot-${(s.note || 'copy').replace(/[^\w-]+/g, '_')}.json`)
    } catch (e) {
      setSnapMsg({ kind: 'error', text: errText(e) })
    }
    setSnapBusy(null)
  }

  const doRestore = async (s: { fileId: string; rev: number }): Promise<void> => {
    setSnapBusy(s.fileId)
    setSnapMsg(null)
    try {
      await restoreSnapshot(s.fileId)
      setSnapMsg({ kind: 'ok', text: `Restored to rev ${s.rev} — the pre-restore state was saved as its own snapshot.` })
    } catch (e) {
      setSnapMsg({ kind: 'error', text: errText(e) })
    }
    setSnapBusy(null)
  }

  const restoreAfterConfirm = (s: { fileId: string; rev: number }): void => {
    void (async () => {
      const ok = await confirmDialog({
        title: `Restore snapshot rev ${s.rev}?`,
        body: (
          <div className="confirm-body">
            <div className="confirm-what">The workspace is replaced with this snapshot's contents.</div>
            The current state is saved first as a “pre-restore” snapshot.
          </div>
        ),
        confirmLabel: 'Restore snapshot',
        tone: 'danger',
        typeToConfirm: 'restore',
      })
      if (!ok) return
      void doRestore(s)
    })()
  }

  const downloadCurrent = async (): Promise<void> => {
    setBackupBusy(true)
    try {
      const { readFile } = await import('../../drive/client')
      const nexusId = doc.ids.nexusFileId
      if (!nexusId) throw new Error('Workspace file id unknown')
      const raw = await readFile(nexusId)
      await downloadRaw(raw, `nexus-backup-${new Date().toISOString().slice(0, 10)}.json`)
    } catch (e) {
      setSnapMsg({ kind: 'error', text: errText(e) })
    }
    setBackupBusy(false)
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

  const wipe = (): void => {
    void (async () => {
      const ok = await confirmDialog({
        title: 'Wipe all workspace data?',
        body: (
          <div className="confirm-body">
            <div className="confirm-what">Every group, project and script is removed — their files move to the trash.</div>
            Your login, settings and the workspace itself are kept.
          </div>
        ),
        confirmLabel: 'Wipe workspace',
        tone: 'danger',
        typeToConfirm: 'wipe',
      })
      if (!ok) return
      try {
        const { resetWorkspaceData } = await import('../../state/actions')
        const r = await resetWorkspaceData()
        toast.success(`Wiped: ${r.groups} groups · ${r.projects} projects · ${r.scripts} scripts — files are in the trash.`)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Wipe failed')
      }
    })()
  }

  const ids: [string, string][] = [
    ['nexus.json key', doc.ids.nexusFileId],
  ]
  const snapshots = [...doc.snapshots].reverse()

  // Admin-only server fn — the bucket facts come from the Worker's secrets/vars.
  void (async () => {
    if (storage) return
    try {
      const { storageInfoFn } = await import('../../server/fns')
      const r = await storageInfoFn()
      if (r.ok) setStorage(r.data)
    } catch {
      /* the card simply stays empty */
    }
  })()

  return (
    <div>
      <div className="card">
        <h2 className="mb8">Storage</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          All content lives in one OCI Object Storage bucket over the S3-compatible API. Layout:{' '}
          <code>master/</code> (nexus.json), <code>snapshots/</code>, <code>groups/</code>,{' '}
          <code>scripts/</code>, <code>trash/</code>.
        </p>
        <div className="muted small mono admin-storage-facts">
          {storage
            ? `${storage.bucket} @ ${storage.region}\n${storage.endpoint}`
            : 'Bucket facts unavailable (admin session required).'}
        </div>
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
            Probes the public read path (the exact route viewers use) and doc size. The app
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
          <h2>
            Reset workspace data <span className="admin-stamp-danger">danger</span>
          </h2>
          <button className="btn danger" onClick={wipe}>
            Wipe workspace data
          </button>
        </div>
        <p className="muted small" style={{ marginTop: 0 }}>
          Removes every group, project and script from the database and moves their files to trash/.
          Your login, other users, settings and the system folders are kept. For starting over while testing.
        </p>
      </div>

      <div className="card">
        <h2>Workspace ids</h2>
        {ids.map(([label, id]) => (
          <div className="admin-row spread mb8" key={label}>
            <span className="small muted admin-id-label">{label}</span>
            <span className="mono small admin-id-value">{id || '—'}</span>
            {id && <CopyButton text={id} label="Copy" />}
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Snapshots</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Daily copies of nexus.json kept in the bucket's <code>snapshots/</code> prefix, newest first.
          Restoring replaces the workspace with the snapshot's contents — the current state is saved as a
          “pre-restore” snapshot first.
        </p>
        {snapMsg && banner(snapMsg.kind === 'error' ? 'error' : 'info', snapMsg.text)}
        {snapshots.length === 0 ? (
          <Empty icon="🗂">No snapshots yet — the first appears after the first successful sync.</Empty>
        ) : (
          <div className="small muted">
            {snapshots.map((s) => (
              <div className="admin-row spread mb8" key={s.fileId}>
                <span>
                  {s.note || 'snapshot'} · rev {s.rev} · {fmtWhen(s.at, true)}
                </span>
                <span className="row" style={{ gap: 6 }}>
                  <button className="btn small" disabled={snapBusy === s.fileId} onClick={() => void downloadSnap(s)}>
                    Download
                  </button>
                  <button className="btn small" disabled={snapBusy === s.fileId} onClick={() => restoreAfterConfirm(s)}>
                    Restore
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="spread mb8">
          <h2>Local backup</h2>
          <button className="btn primary" disabled={backupBusy} onClick={() => void downloadCurrent()}>
            {backupBusy ? 'Preparing…' : 'Download nexus.json backup'}
          </button>
        </div>
        <p className="muted small" style={{ marginTop: 0 }}>
          A local copy of the whole workspace database, independent of Drive.
        </p>
      </div>
    </div>
  )
}
