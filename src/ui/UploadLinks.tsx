// "Share upload link" modal for a project's Media tab: mint a guest link
// (project + section + expiry + size cap, raw token revealed ONCE) and
// manage this project's existing links. Link metadata is non-secret (only
// hashes are in the doc), so the list renders straight from the client doc.

import { useState } from 'react'
import { useStore } from '../sync/store'
import { createUploadLink, revokeUploadLink } from '../state/actions'
import { confirmDialog } from './components/ConfirmDialog'
import { CopyButton, Modal } from './components'

const SIZE_CHIPS: { label: string; bytes: number }[] = [
  { label: '100 MB', bytes: 100 * 1024 * 1024 },
  { label: '500 MB', bytes: 500 * 1024 * 1024 },
  { label: '2 GB', bytes: 2 * 1024 * 1024 * 1024 },
  { label: '4 GB', bytes: 4 * 1024 * 1024 * 1024 },
  { label: '10 GB', bytes: 10 * 1024 * 1024 * 1024 },
]

export function UploadLinksModal({ projectId, onClose }: { projectId: string; onClose: () => void }): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const project = doc?.projects[projectId]
  const [sectionId, setSectionId] = useState<string>(project?.mediaSections[0]?.id ?? '')
  const [days, setDays] = useState<1 | 7 | 30>(7)
  const [maxBytes, setMaxBytes] = useState(2 * 1024 * 1024 * 1024)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [reveal, setReveal] = useState<{ url: string; synced: boolean } | null>(null)

  const links = (doc?.uploadLinks ?? []).filter((l) => l.projectId === projectId).slice().reverse()
  const sectionName = (id: string): string => project?.mediaSections.find((s) => s.id === id)?.name ?? 'All files'
  const linkState = (l: { revokedAt: string | null; expiresAt: string }): { label: string; tone: 'green' | 'muted' | 'red' } => {
    if (l.revokedAt) return { label: 'revoked', tone: 'red' }
    if (Date.parse(l.expiresAt) <= Date.now()) return { label: 'expired', tone: 'muted' }
    return { label: 'active', tone: 'green' }
  }

  const create = (): void => {
    setError(null)
    setCreating(true)
    void (async () => {
      try {
        const { raw, synced } = await createUploadLink(projectId, sectionId, days, maxBytes, note.trim())
        setReveal({ url: `${location.origin}/upload/${raw}`, synced })
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not create the link')
      } finally {
        setCreating(false)
      }
    })()
  }

  return (
    <Modal title="Share upload link" onClose={onClose}>
      {reveal ? (
        <div>
          {reveal.synced ? (
            <p className="small muted" style={{ marginTop: 0 }}>
              Send this link — anyone who opens it can upload media into <b>{sectionName(sectionId)}</b> until it expires or you revoke it.
              Nothing else of the workspace is visible to them.
            </p>
          ) : (
            <div className="banner warn">Not saved yet — the link only works once it finishes syncing. Check your connection, then copy and share.</div>
          )}
          <div className="token-box">{reveal.url}</div>
          <div className="row mt8">
            <CopyButton text={reveal.url} label="Copy link" />
          </div>
          <div className="row mt16" style={{ justifyContent: 'flex-end' }}>
            <button
              className="btn primary"
              onClick={() => {
                setReveal(null)
                setNote('')
              }}
            >
              Done
            </button>
          </div>
        </div>
      ) : (
        <div>
          {error && <div className="banner error" style={{ marginBottom: 8 }}>{error}</div>}

          <div className="field">
            <label>Existing links for this project</label>
            {links.length === 0 ? (
              <p className="faint small" style={{ margin: '2px 0 0' }}>None yet.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 200, overflowY: 'auto' }}>
                {links.map((l) => {
                  const st = linkState(l)
                  return (
                    <div key={l.id} className="row spread" style={{ gap: 8, alignItems: 'center', borderBottom: '1px solid var(--border)', paddingBottom: 6 }}>
                      <div style={{ minWidth: 0 }}>
                        <div className="small">
                          {sectionName(l.sectionId)}
                          <span className={`muted small`}> · {st.label}</span>
                          {l.note ? <span className="faint small"> · {l.note}</span> : null}
                        </div>
                        <div className="faint small">
                          up to {l.maxFileBytes >= 1024 * 1024 * 1024 ? `${Math.round(l.maxFileBytes / (1024 * 1024 * 1024))} GB` : `${Math.round(l.maxFileBytes / (1024 * 1024))} MB`} ·
                          expires {new Date(l.expiresAt).toLocaleString()}
                        </div>
                      </div>
                      {st.label === 'active' ? (
                        <button
                          className="btn small danger"
                          onClick={async () => {
                            const ok = await confirmDialog({
                              title: 'Revoke this link?',
                              body: 'New uploads with it stop immediately. Links already sent stop working.',
                              confirmLabel: 'Revoke link',
                              tone: 'danger',
                            })
                            if (ok) void revokeUploadLink(l.id).catch((e) => setError(e instanceof Error ? e.message : 'Revoke failed'))
                          }}
                        >
                          Revoke
                        </button>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {project && project.mediaSections.length > 0 ? (
            <>
              <div className="field">
                <label>Uploads land in section</label>
                <select className="input" value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
                  {project.mediaSections.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Expires after</label>
                <div className="chips">
                  {([1, 7, 30] as const).map((d) => (
                    <button key={d} className={`chip${days === d ? ' on' : ''}`} onClick={() => setDays(d)}>
                      {d === 1 ? '24 hours' : `${d} days`}
                    </button>
                  ))}
                </div>
              </div>
              <div className="field">
                <label>Max size per file</label>
                <div className="chips">
                  {SIZE_CHIPS.map((c) => (
                    <button key={c.bytes} className={`chip${maxBytes === c.bytes ? ' on' : ''}`} onClick={() => setMaxBytes(c.bytes)}>
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="field">
                <label>Note (only you see this)</label>
                <input className="input" placeholder="e.g. for Rohan — wedding footage" value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
              <div className="row mt16" style={{ justifyContent: 'flex-end' }}>
                <button className="btn primary" disabled={creating || !sectionId} onClick={create}>
                  {creating ? 'Creating…' : 'Create link'}
                </button>
              </div>
              <p className="faint small" style={{ marginBottom: 0 }}>
                If the section is deleted later, new uploads still land in the project (visible under “All”).
              </p>
            </>
          ) : (
            <p className="muted small" style={{ marginBottom: 0 }}>
              This project has no media sections yet — create one (Media → ＋ New) and come back to share a link.
            </p>
          )}
        </div>
      )}
    </Modal>
  )
}
