import { useEffect, useState } from 'react'
import { useStore } from '../../../sync/store'
import { Empty } from '../../components'
import { canWrite } from '../../../auth/session'
import { readScriptBody, updateScript } from '../../../state/actions'

/** Scripts assigned to this project — read in place, link/unlink. */
export function ScriptsTab({ projectId }: { projectId: string }): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const writable = canWrite()
  const [openScript, setOpenScript] = useState<string | null>(null)
  const [bodies, setBodies] = useState<Record<string, string | null>>({})

  const project = doc?.projects[projectId]
  if (!doc || !project) return <></>

  const scripts = Object.values(doc.scripts).filter((s) => s.deleted === null && s.projectId === projectId)
  const unlinked = Object.values(doc.scripts).filter((s) => s.deleted === null && s.projectId === null)
  const scriptKey = scripts.map((s) => s.id).join(',')

  useEffect(() => {
    let alive = true
    for (const s of scripts) {
      if (bodies[s.id] !== undefined) continue
      void readScriptBody(s.id).then((text) => {
        if (alive) setBodies((prev) => ({ ...prev, [s.id]: text ?? '' }))
      })
    }
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scriptKey])

  return (
    <div>
      {scripts.length === 0 && <Empty icon="✎">No scripts assigned to this project.</Empty>}
      {scripts.map((s) => (
        <div key={s.id} className="card mb8">
          <div className="spread">
            <div className="row">
              <span style={{ fontWeight: 600 }}>{s.title}</span>
              <span className={`badge ${s.status === 'final' ? 'done' : s.status === 'review' ? 'doing' : ''}`}>{s.status}</span>
            </div>
            <div className="row">
              <a className="btn small" href="/scripts">Edit on Scripts page</a>
              {writable && (
                <button className="btn small ghost" onClick={() => updateScript(s.id, { projectId: null })}>Unlink</button>
              )}
              <button className="btn small" onClick={() => setOpenScript(openScript === s.id ? null : s.id)}>
                {openScript === s.id ? 'Hide' : 'Read'}
              </button>
            </div>
          </div>
          {openScript === s.id && (
            <pre className="manuscript mt8" style={{ fontFamily: 'var(--mono)', fontSize: 13, whiteSpace: 'pre-wrap', padding: '12px 14px', borderRadius: 6, border: '1px solid var(--border)', maxHeight: 420, overflowY: 'auto', margin: 0 }}>
              {bodies[s.id] ?? 'Loading…'}
            </pre>
          )}
        </div>
      ))}

      {writable && unlinked.length > 0 && (
        <div className="card">
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Link an existing script to this project</label>
            <select
              className="input"
              value=""
              onChange={(e) => {
                if (e.target.value) updateScript(e.target.value, { projectId })
              }}
            >
              <option value="">Pick a script…</option>
              {unlinked.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
            </select>
          </div>
        </div>
      )}
    </div>
  )
}
