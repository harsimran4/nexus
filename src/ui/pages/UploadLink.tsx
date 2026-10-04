// Standalone guest upload page — opened from a share link (/upload/<token>).
// Mobile-first and self-contained: it shows ONLY the project + section names,
// the expiry and the per-file size cap, and uploads through the presigned
// direct path with the raw link token as its credential. No app shell, no
// workspace doc, no session — this page never touches the sync kernel.

import { useEffect, useRef, useState } from 'react'
import { uploadFile } from '../../drive/client'
import { UPLOAD_CONCURRENCY } from '../../state/uploads'

interface LinkInfo {
  projectName: string
  sectionName: string | null // null = the linked section was deleted; files land under "All"
  expiresAt: string
  maxFileBytes: number
  folderId: string
}

interface Entry {
  name: string
  pct: number
  started: boolean
  done: boolean
  ok?: boolean
  err?: string
}

const fmtBytes = (n: number): string =>
  n >= 1024 * 1024 * 1024 ? `${Math.round(n / (1024 * 1024 * 1024))} GB` : `${Math.round(n / (1024 * 1024))} MB`

export function UploadLinkPage({ token }: { token: string }): React.JSX.Element {
  const [state, setState] = useState<'loading' | 'ready' | 'dead'>('loading')
  const [info, setInfo] = useState<LinkInfo | null>(null)
  const [roster, setRoster] = useState<Entry[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const filesRef = useRef<File[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await fetch('/api/upload/link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        })
        if (!alive) return
        if (!res.ok) {
          setState('dead')
          return
        }
        setInfo((await res.json()) as LinkInfo)
        setState('ready')
      } catch {
        if (alive) setState('dead')
      }
    })()
    return () => {
      alive = false
    }
  }, [token])

  const patch = (i: number, u: Partial<Entry>): void => {
    setRoster((rs) => (rs ? rs.map((e, j) => (j === i ? { ...e, ...u } : e)) : rs))
  }

  const uploadOne = async (i: number, file: File): Promise<void> => {
    if (!info) return
    patch(i, { started: true })
    if (file.size > info.maxFileBytes) {
      patch(i, { done: true, ok: false, err: `over this link's ${fmtBytes(info.maxFileBytes)} limit` })
      return
    }
    try {
      await uploadFile(info.folderId, file, (pct) => patch(i, { pct }), { authToken: token })
      patch(i, { pct: 100, done: true, ok: true })
    } catch (e) {
      patch(i, { done: true, ok: false, err: e instanceof Error ? e.message : 'Upload failed' })
    }
  }

  const startUploads = (files: File[]): void => {
    if (!info || busy || files.length === 0) return
    setBusy(true)
    filesRef.current = files
    setRoster(files.map((f) => ({ name: f.name, pct: 0, started: false, done: false })))
    let next = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++
        if (i >= files.length) return
        await uploadOne(i, files[i])
      }
    }
    void Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, worker)).then(() => setBusy(false))
  }

  const retry = (i: number): void => {
    if (busy || !roster?.[i]) return
    setBusy(true)
    setRoster((rs) => (rs ? rs.map((e, j) => (j === i ? { ...e, done: false, ok: undefined, err: undefined, pct: 0 } : e)) : rs))
    void uploadOne(i, filesRef.current[i]).then(() => setBusy(false))
  }

  if (state === 'loading') {
    return (
      <div className="center-screen">
        <div className="center-card card" style={{ textAlign: 'center' }}>
          <p className="muted">Checking link…</p>
        </div>
      </div>
    )
  }

  if (state === 'dead' || !info) {
    return (
      <div className="center-screen">
        <div className="center-card card" style={{ textAlign: 'center' }}>
          <p style={{ fontSize: 28, margin: 0 }}>🔗</p>
          <h2 style={{ margin: '8px 0 4px' }}>This upload link is not valid or has expired</h2>
          <p className="muted small">Ask the sender for a fresh link if you still need to upload.</p>
        </div>
      </div>
    )
  }

  const allDone = roster !== null && roster.every((r) => r.done)
  const okCount = roster?.filter((r) => r.done && r.ok).length ?? 0
  const failCount = roster?.filter((r) => r.done && !r.ok).length ?? 0

  return (
    <div className="center-screen">
      <div className="center-card card" style={{ width: 'min(92vw, 560px)' }}>
        <div className="eyebrow">Nexus — upload link</div>
        <h1 style={{ margin: '2px 0 4px', fontSize: 24 }}>{info.projectName}</h1>
        <div className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
          <span className="chip on">{info.sectionName ?? 'All files'}</span>
          <span className="faint small">up to {fmtBytes(info.maxFileBytes)} per file · expires {new Date(info.expiresAt).toLocaleString()}</span>
        </div>

        {allDone ? (
          <div style={{ marginTop: 16 }}>
            <p style={{ margin: '4px 0' }}>
              {failCount === 0 ? '✓ All done' : `${okCount} uploaded · ${failCount} failed`}
              <span className="muted small"> — thank you!</span>
            </p>
            <button className="btn primary" onClick={() => { setRoster(null); filesRef.current = [] }}>
              Upload more
            </button>
          </div>
        ) : roster ? (
          <div style={{ marginTop: 14 }}>
            <div style={{ maxHeight: 240, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {roster.map((r, i) => (
                <div key={i}>
                  <div className="spread small">
                    <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: r.done && !r.ok ? 'var(--red)' : undefined }} title={r.err ?? r.name}>
                      {r.done ? (r.ok ? '✓ ' : '✗ ') : !r.started ? '· ' : ''}
                      {r.name}
                    </span>
                    <span className="muted">{r.done ? (r.ok ? 'done' : 'failed') : r.started ? `${r.pct}%` : 'queued'}</span>
                  </div>
                  {r.started && !r.done && <div className="progress" style={{ marginTop: 3 }}><div style={{ width: `${r.pct}%` }} /></div>}
                  {r.done && !r.ok && (
                    <button className="btn small ghost" style={{ marginTop: 2 }} onClick={() => retry(i)}>
                      Retry
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div
            className={`dropzone${dragOver ? ' drag' : ''}`}
            style={{ marginTop: 14, padding: '28px 16px', textAlign: 'center' }}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              startUploads(Array.from(e.dataTransfer.files))
            }}
          >
            <div style={{ fontSize: 15 }}>Tap to choose files</div>
            <div className="faint" style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', fontSize: 12.5, marginTop: 4 }}>
              or drop them here — they upload straight to {info.sectionName ?? 'the project'} in the background
            </div>
          </div>
        )}

        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            startUploads(Array.from(e.target.files ?? []))
            e.target.value = ''
          }}
        />
      </div>
    </div>
  )
}
