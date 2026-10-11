// Standalone guest upload page — /upload/<token>. Mobile-first and
// self-contained: it shows ONLY the project + section names, the expiry and
// the per-file size cap, and uploads through the presigned direct path with
// the raw link token as its credential. No app shell, no workspace doc, no
// session — this page never touches the sync kernel.
//
// Each file is linked into the doc SERVER-SIDE at its own completion, so a
// guest may close the tab the moment a tile reads done — nothing pending
// lives in the browser. What this page adds on top: coarse progress beacons
// (the owner watches a live pill in the app) and an end-of-batch verify+repair
// pass (one request per ≤64 keys re-linking anything a late write race
// dropped) before the final "All done".

import { useEffect, useRef, useState } from 'react'
import { uploadFile } from '../../drive/client'
import { UPLOAD_CONCURRENCY } from '../../state/uploads'
import { UploadRoster } from '../components/UploadRoster'

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
  /** Storage key of a completed upload — the verify pass re-links by key. */
  key?: string
  err?: string
}

type Verify = 'idle' | 'checking' | 'ok' | 'unverified'

const fmtBytes = (n: number): string =>
  n >= 1024 * 1024 * 1024 ? `${Math.round(n / (1024 * 1024 * 1024))} GB` : `${Math.round(n / (1024 * 1024))} MB`

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function UploadLinkPage({ token }: { token: string }): React.JSX.Element {
  const [state, setState] = useState<'loading' | 'ready' | 'dead'>('loading')
  const [info, setInfo] = useState<LinkInfo | null>(null)
  const [roster, setRoster] = useState<Entry[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [verify, setVerify] = useState<Verify>('idle')
  const [repaired, setRepaired] = useState(0)
  const filesRef = useRef<File[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  // Beacons read counters from a ref — setState inside uploadOne already
  // re-renders the roster; the beacon must not depend on React timing.
  const countsRef = useRef({ total: 0, done: 0, failed: 0 })
  const lastBeaconAt = useRef(0)

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

  /** Coarse progress for the owner's live pill — fire-and-forget, throttled;
   *  a dropped beacon must never affect the upload. */
  const beacon = (state?: 'complete' | 'failed'): void => {
    const now = Date.now()
    if (!state && now - lastBeaconAt.current < 4000) return
    lastBeaconAt.current = now
    void fetch('/api/upload/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ ...countsRef.current, state: state ?? 'active' }),
    }).catch(() => {})
  }

  /** One quiescent read-modify-write per ≤64 keys AFTER the batch drains —
   *  re-links anything a late write race dropped, no-op when all present.
   *  Returns the number of keys the server actually had to re-add. */
  const verifyKeys = async (keys: string[]): Promise<number> => {
    let addedSum = 0
    for (let i = 0; i < keys.length; i += 64) {
      const res = await fetch('/api/upload/link-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ keys: keys.slice(i, i + 64) }),
      })
      if (!res.ok) throw new Error(`verify failed (${res.status})`)
      addedSum += ((await res.json()) as { added?: number }).added ?? 0
    }
    return addedSum
  }

  const verifyAll = async (): Promise<void> => {
    const keys = (roster ?? []).filter((e) => e.ok && e.key).map((e) => e.key as string)
    if (keys.length === 0) {
      setVerify('idle')
      return
    }
    setVerify('checking')
    for (let pass = 0; ; pass++) {
      try {
        const added = await verifyKeys(keys)
        setRepaired((r) => r + added)
        setVerify('ok')
        beacon('complete')
        return
      } catch {
        if (pass >= 1) {
          setVerify('unverified')
          beacon('complete')
          return
        }
        await sleep(1500)
      }
    }
  }

  const uploadOne = async (i: number, file: File): Promise<void> => {
    if (!info) return
    patch(i, { started: true })
    if (file.size > info.maxFileBytes) {
      countsRef.current.failed += 1
      beacon()
      patch(i, { done: true, ok: false, err: `over this link's ${fmtBytes(info.maxFileBytes)} limit` })
      return
    }
    try {
      const meta = await uploadFile(info.folderId, file, (pct) => patch(i, { pct }), { authToken: token })
      countsRef.current.done += 1
      beacon()
      patch(i, { pct: 100, done: true, ok: true, key: meta.id })
    } catch (e) {
      countsRef.current.failed += 1
      beacon()
      patch(i, { done: true, ok: false, err: e instanceof Error ? e.message : 'Upload failed' })
    }
  }

  const startUploads = (files: File[]): void => {
    if (!info || busy || files.length === 0) return
    setBusy(true)
    filesRef.current = files
    countsRef.current = { total: files.length, done: 0, failed: 0 }
    setVerify('idle')
    setRepaired(0)
    setRoster(files.map((f) => ({ name: f.name, pct: 0, started: false, done: false })))
    let next = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++
        if (i >= files.length) return
        await uploadOne(i, files[i])
      }
    }
    void Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, worker)).then(() => verifyAll().finally(() => setBusy(false)))
  }

  const retry = (i: number): void => {
    if (busy || !roster?.[i]) return
    if (roster[i].ok === false) countsRef.current.failed = Math.max(0, countsRef.current.failed - 1)
    setBusy(true)
    setVerify('idle')
    setRoster((rs) => (rs ? rs.map((e, j) => (j === i ? { ...e, done: false, ok: undefined, key: undefined, err: undefined, pct: 0 } : e)) : rs))
    void uploadOne(i, filesRef.current[i]).then(() => verifyAll().finally(() => setBusy(false)))
  }

  const recheck = (): void => {
    if (busy) return
    setBusy(true)
    void verifyAll().finally(() => setBusy(false))
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

  const allDone = roster !== null && roster.every((r) => r.done) && !busy
  const okCount = roster?.filter((r) => r.done && r.ok).length ?? 0
  const failCount = roster?.filter((r) => r.done && !r.ok).length ?? 0
  const verifying = verify === 'checking'

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
              {failCount === 0 ? (
                <>✓ All done<span className="muted small"> — thank you!</span></>
              ) : (
                <><b>{okCount}</b> uploaded · <b>{failCount}</b> failed — see the list below</>
              )}
            </p>
            {repaired > 0 && (
              <p className="muted small" style={{ margin: '2px 0' }}>
                {repaired === 1 ? 'One file' : `${repaired} files`} needed a final touch-up on our side — all confirmed saved now.
              </p>
            )}
            {verify === 'unverified' && (
              <p className="small" style={{ margin: '2px 0', color: 'var(--warn, #b45309)' }}>
                Uploaded — but we couldn't run the final check. Your files are safe; the sender can confirm them in a moment.
                <button className="btn ghost small" style={{ marginLeft: 8 }} onClick={recheck} disabled={busy}>
                  Check again
                </button>
              </p>
            )}
            {failCount > 0 && (
              <div style={{ marginTop: 10 }}>
                <UploadRoster entries={roster} onRetry={retry} maxHeight={240} />
              </div>
            )}
            <button className="btn primary" onClick={() => { setRoster(null); filesRef.current = [] }} style={{ marginTop: 8 }}>
              Upload more
            </button>
          </div>
        ) : roster ? (
          <div style={{ marginTop: 14 }}>
            {verifying && <p className="muted small" style={{ margin: '0 0 8px' }}>Making sure everything landed…</p>}
            <UploadRoster entries={roster} onRetry={retry} maxHeight={240} />
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
            onDragLeave={(e) => {
              e.preventDefault()
              setDragOver(false)
            }}
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
