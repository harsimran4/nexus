// The Manuscript tab — the script's prose body (markdown), moved verbatim
// from the old two-pane editor. Drafts survive tab switches (in-memory map)
// and tab closes (IndexedDB mirror); the workspace header reads the
// bodySavers registry before a status change so milestone copies never miss
// unsaved edits.

import { useEffect, useRef, useState } from 'react'
import { canWrite, useCanWrite } from '../../../auth/session'
import { readScriptBody, saveScriptBody } from '../../../state/actions'
import { clearScriptDraft, loadScriptDraft, saveScriptDraft } from '../../../sync/drafts'
import { renderMarkdown } from '../../../util/markdown'
import { decodeHlc } from '../../../util/hlc'
import { downloadToBrowser, describeError } from '../../../drive/preview'
import { banner, confirmIsOpen, toast } from '../../components'
import { ScriptDiffModal } from '../ScriptDiffModal'
import type { Script } from '../../../types/schema'

/** HLC stamps render as local wall-clock time. */
const fmt = (stamp: string): string => new Date(decodeHlc(stamp).ms).toLocaleString()

// Unsaved drafts survive switching between tabs/scripts within this session
// (in-memory map, instant) AND tab closes (IndexedDB mirror, written debounced).
const bodyDrafts = new Map<string, string>()

// The workspace header asks this registry to flush unsaved body edits before
// a status change (milestone copies snapshot the DRIVE body — in-editor edits
// must be written first or the copy loses them).
const bodySavers = new Map<string, () => Promise<boolean>>()

/** Flush unsaved manuscript edits for a script. Resolves false when the save
 *  failed (the error is already on screen) — callers must not continue. */
export async function saveScriptBodyDraft(id: string): Promise<boolean> {
  const save = bodySavers.get(id)
  if (!save) return true
  return save()
}

// One download-failure toast at a time — a retry replaces the old receipt
// instead of stacking five sticky errors.
let downloadErrToast: number | null = null

export function ManuscriptTab({ script }: { script: Script }): React.JSX.Element {
  const [body, setBody] = useState(() => bodyDrafts.get(script.id) ?? '')
  const [loaded, setLoaded] = useState(false)
  const [dirty, setDirty] = useState(() => bodyDrafts.has(script.id))
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [preview, setPreview] = useState(false)
  const [diffCopy, setDiffCopy] = useState<{ label: string; fileId: string } | null>(null)
  const draftSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const id = script.id

  // Body loads from its Drive file — unless an unsaved draft exists (in-memory
  // first, then the IndexedDB mirror from a previous session).
  useEffect(() => {
    let alive = true
    const mem = bodyDrafts.get(id)
    if (mem !== undefined) {
      setBody(mem)
      setLoaded(true)
      return () => {
        alive = false
      }
    }
    void (async () => {
      const stored = await loadScriptDraft(id)
      if (!alive) return
      if (stored !== null) {
        setBody(stored)
        setDirty(true)
        setLoaded(true)
        return
      }
      const text = await readScriptBody(id)
      if (alive) {
        setBody(text ?? '')
        setLoaded(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [id])

  /** Persists the body when dirty. Resolves false when the save failed (the
   *  error is already on screen) — callers must not continue past a failure. */
  const save = async (): Promise<boolean> => {
    if (saveState === 'saving') return false
    if (!dirty) return true // nothing unsaved — the Drive copy is current
    if (!canWrite()) return false
    setSaveState('saving')
    setSaveError(null)
    try {
      const r = await saveScriptBody(id, body)
      if (r.ok) {
        bodyDrafts.delete(id)
        void clearScriptDraft(id)
        setDirty(false)
        setSaveState('saved')
        return true
      }
      setSaveError(r.error)
      setSaveState('error')
      return false
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : 'Save failed')
      setSaveState('error')
      return false
    }
  }

  // Register with the workspace header; drop on unmount/tab switch.
  useEffect(() => {
    bodySavers.set(id, save)
    return () => {
      bodySavers.delete(id)
    }
  })

  // Ctrl+S / Cmd+S saves from anywhere on the page — but stands down while
  // a confirm dialog is up (same convention as Modal / MediaTab's Escape).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (confirmIsOpen()) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const writable = useCanWrite()

  const onBodyChange = (value: string) => {
    setBody(value)
    bodyDrafts.set(id, value)
    setDirty(true)
    if (saveState === 'saved') setSaveState('idle')
    if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current)
    draftSaveTimer.current = setTimeout(() => void saveScriptDraft(id, value), 500)
  }

  return (
    <div className="card">
      {script.storage.type === 'drive-doc' ? (
        <div className="field">
          <label>Body — stored as a Drive doc</label>
          <div className="row wrap">
            <span className="mono small muted" style={{ wordBreak: 'break-all' }}>
              {script.storage.fileId}
            </span>
          </div>
          <span className="faint small">Edit the text in Drive; Nexus keeps the link. The Brief, Story and Shots tabs still live here.</span>
        </div>
      ) : (
        <div className="field">
          <div className="spread">
            <label style={{ marginBottom: 0 }}>
              Body{' '}
              {dirty && saveState !== 'saving' ? '· unsaved changes' : saveState === 'saving' ? '· saving…' : saveState === 'saved' ? '· saved ✓' : saveState === 'error' ? '· save failed — press Save again' : ''}
            </label>
            <div className="row" style={{ gap: 6 }}>
              <button className={`chip ${preview ? '' : 'on'}`} aria-pressed={!preview} onClick={() => setPreview(false)} title="Edit the markdown">
                Edit
              </button>
              <button className={`chip ${preview ? 'on' : ''}`} aria-pressed={preview} onClick={() => setPreview(true)} title="Rendered preview">
                Preview
              </button>
              {writable && (
                <button className="btn primary small" disabled={!dirty || saveState === 'saving'} onClick={() => void save()}>
                  {saveState === 'saving' ? 'Saving…' : 'Save body'}
                </button>
              )}
            </div>
          </div>
          {preview ? (
            <div
              className="input md-preview"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }}
            />
          ) : (
            <textarea
              className="input"
              rows={14}
              value={loaded ? body : ''}
              placeholder={loaded ? 'Write the script…' : 'Loading…'}
              disabled={!writable || !loaded}
              onChange={(e) => onBodyChange(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') e.preventDefault()
              }}
            />
          )}
          <span className="faint small">
            Press Save (or Ctrl+S) to write your text to the script's markdown file — milestone copies at Review/Final give you restore points.
          </span>
          {saveState === 'error' && saveError && banner('error', 'Could not save the script', saveError)}
        </div>
      )}

      <div className="field">
        <label>Milestone copies ({script.copies.length})</label>
        {script.copies.length === 0 && (
          <span className="faint small">
            None yet — a snapshot copy is saved to Drive when the status moves to review or final.
          </span>
        )}
        {script.copies.map((c) => (
          <div key={`${c.fileId}-${c.at}`} className="script-copy small">
            <span className="row">
              <span className={`badge ${c.label === 'final' ? 'done' : 'doing'}`}>{c.label}</span>
              <button className="btn ghost small" onClick={() => setDiffCopy({ label: c.label, fileId: c.fileId })}>
                Diff vs current
              </button>
              <button
                className="btn ghost small"
                onClick={() =>
                  void downloadToBrowser(c.fileId, `${script.title || 'script'}-${c.label}.md`).catch((e) => {
                    if (downloadErrToast !== null) toast.dismiss(downloadErrToast)
                    const d = describeError(e)
                    downloadErrToast = toast.error(d.message, d.fix)
                  })
                }
              >
                Download copy
              </button>
            </span>
            <span className="faint">{fmt(c.at)}</span>
          </div>
        ))}
      </div>

      {diffCopy && (
        <ScriptDiffModal
          copyLabel={diffCopy.label}
          fileId={diffCopy.fileId}
          currentBody={body}
          onClose={() => setDiffCopy(null)}
        />
      )}
    </div>
  )
}
