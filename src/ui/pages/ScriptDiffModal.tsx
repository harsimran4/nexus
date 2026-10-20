// Milestone diff — the whole point of freezing a copy at review/final is
// "what changed since?". Side-by-side panes need too much width for real
// scripts; a unified line diff with old/new tinting reads better at every
// size. The copy body loads from the public files route (read path is public
// by design) — writable actions are NOT required to read a diff.

import { useEffect, useState } from 'react'
import { Modal } from '../components'
import { diffLines, diffStats } from '../../util/diff'

export function ScriptDiffModal({ copyLabel, fileId, currentBody, onClose }: {
  copyLabel: string
  fileId: string
  /** The live editor body (unsaved edits included — that's the point). */
  currentBody: string
  onClose: () => void
}): React.JSX.Element {
  const [copyBody, setCopyBody] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await fetch(`/files/${fileId}`)
        if (!res.ok) throw new Error(`Could not load the frozen copy (${res.status})`)
        const text = await res.text()
        if (alive) setCopyBody(text)
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Could not load the frozen copy')
      }
    })()
    return () => {
      alive = false
    }
  }, [fileId])

  const rows = copyBody !== null ? diffLines(copyBody, currentBody) : []
  const stats = diffStats(rows)

  return (
    <Modal title={`Diff — ${copyLabel} vs current`} onClose={onClose} wide>
      {error && <div className="banner error">{error}</div>}
      {!error && copyBody === null && <div className="skeleton" style={{ height: 120 }} />}
      {copyBody !== null && (
        <>
          <p className="faint small" style={{ marginTop: 0 }}>
            Frozen copy vs the editor right now — <span className="diff-stat-new">+{stats.added}</span>{' '}
            <span className="diff-stat-old">−{stats.removed}</span> · {stats.same} unchanged
          </p>
          {rows.length === 0 && <p className="muted small">The copy and the current body are identical.</p>}
          <div className="diff-view mono" role="figure" aria-label={`Diff between the ${copyLabel} copy and the current script body`}>
            {rows.map((r, i) => (
              <div key={i} className={`diff-row diff-${r.kind}`}>
                <span className="diff-sign">{r.kind === 'new' ? '+' : r.kind === 'old' ? '−' : ' '}</span>
                <span className="diff-text">{r.text || ' '}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  )
}
