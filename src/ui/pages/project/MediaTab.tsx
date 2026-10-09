import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../../../sync/store'
import { banner, Empty } from '../../components'
import { confirmDialog, confirmIsOpen } from '../../components/ConfirmDialog'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/Toast'
import { Lightbox, type LightboxItem } from '../../components/Lightbox'
import { canWrite } from '../../../auth/session'
import { addMediaSection, moveMediaToSection, removeProjectFile } from '../../../state/actions'
import { startUploadBatch } from '../../../state/uploads'
import { commit, touch, appendActivity } from '../../../sync/writer'
import { describeError, downloadToBrowserProgress } from '../../../drive/preview'
import { renameFile } from '../../../drive/client'
import { UNSORTED, buildItems, filterAndSort } from '../../../util/media'
import { useMediaView } from './mediaView'
import { useMediaMeta, keyName } from './useMediaMeta'
import { SectionTabs } from './SectionTabs'
import { MediaToolbar } from './MediaToolbar'
import { MediaCard } from './MediaCard'
import { UploadDialog } from './UploadDialog'
import { ManageSectionsDialog } from './ManageSectionsDialog'
import { clearSelection, pruneSelection, setSelection, toggleSelected, useMediaSelection } from './mediaSelection'
import { UploadLinksModal } from '../../UploadLinks'

/** The Media tab — grid, sections, selection, uploads, preview. View state
 *  lives in the URL (useMediaView); selection lives in sessionStorage
 *  (mediaSelection); a running batch lives in the global uploads store so
 *  it survives navigating away. */
export function MediaTab({ projectId }: { projectId: string }): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const { view, setView } = useMediaView()
  const [error, setError] = useState<{ message: string; fix?: string } | null>(null)
  // selection + bulk
  const [selectMode, setSelectMode] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkLabel, setBulkLabel] = useState<string | null>(null)
  const [downloading, setDownloading] = useState<Record<string, number | null>>({})
  // file rename (per card — the draft lives in MediaCard's input)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  // dialogs
  const [uploadOpen, setUploadOpen] = useState(false)
  const [uploadSection, setUploadSection] = useState('')
  const [manageOpen, setManageOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  // Range-select anchor as a FILE ID, not an index — an index into a previous
  // filter's `shown` order silently selects the wrong files after a refilter.
  const lastTouched = useRef<string | null>(null)
  const writable = canWrite()

  const project = doc?.projects[projectId]
  const meta = useMediaMeta(project?.fileIds ?? [], project?.folderId)

  if (!doc || !project) return <></>

  const sectionOf = project.mediaSectionOf
  const fileKey = project.fileIds.join(',')
  const items = useMemo(
    () => buildItems(project.fileIds, meta),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fileKey, meta],
  )

  // A deleted section id falls back to All (e.g. a peer removed it mid-view).
  const activeSection =
    view.section === 'all' || view.section === UNSORTED || project.mediaSections.some((s) => s.id === view.section)
      ? view.section
      : 'all'

  const shown = useMemo(
    () => filterAndSort(items, { search: view.q, kind: view.kind, section: activeSection, sectionOf, sort: view.sort }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, view.q, view.kind, activeSection, sectionOf, view.sort],
  )

  const selected = useMediaSelection(projectId)

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: project.fileIds.length, [UNSORTED]: 0 }
    for (const s of project.mediaSections) c[s.id] = 0
    for (const it of items) {
      const sec = sectionOf[it.fileId]
      if (sec === undefined) c[UNSORTED]++
      else c[sec] = (c[sec] ?? 0) + 1
    }
    return c
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, sectionOf, project.mediaSections])

  const sectionNameOf = (id: string | undefined) =>
    id ? project.mediaSections.find((s) => s.id === id)?.name ?? UNSORTED : UNSORTED

  // Drop selection entries whose files are gone (bulk delete / peer delete).
  useEffect(() => {
    pruneSelection(projectId, new Set(project.fileIds))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.fileIds.join(',')])

  // Uploads default into the section you're looking at (Unsorted elsewhere).
  useEffect(() => {
    setUploadSection(activeSection !== 'all' && activeSection !== UNSORTED ? activeSection : '')
  }, [activeSection])

  const uploadTarget = project.mediaSections.some((s) => s.id === uploadSection) ? uploadSection : ''
  const uploadTargetLabel = uploadTarget ? sectionNameOf(uploadTarget) : 'Unsorted'

  // Escape peels layers in order: rename → select mode. Modals and the
  // lightbox handle their own Escape; those states are excluded here (as is
  // an open confirm dialog — it must swallow the key alone).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (manageOpen || uploadOpen || shareOpen || view.file || confirmIsOpen()) return
      if (renamingId !== null) {
        setRenamingId(null)
        return
      }
      if (selectMode) {
        setSelectMode(false)
        clearSelection(projectId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectMode, manageOpen, shareOpen, renamingId, view.file, projectId])

  // ---- receipts / errors ------------------------------------------------

  const reportError = (e: unknown) => {
    const d = describeError(e)
    setError({ message: d.message, fix: d.fix })
  }

  // ---- page-level drop + paste (editors, no dialogs open) ----------------

  const dropTarget = activeSection !== 'all' && activeSection !== UNSORTED ? activeSection : null

  useEffect(() => {
    if (!writable) return
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
    const blocked = () => uploadOpen || manageOpen || shareOpen || view.file !== undefined
    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      dragDepth.current++
      if (!blocked()) setDragging(true)
    }
    const onDragOver = (e: DragEvent) => {
      // ALWAYS preventDefault file drags — even over an open dialog. Without
      // it the drop event never fires and the browser NAVIGATES the tab to
      // the dropped local file, discarding the app.
      if (hasFiles(e)) e.preventDefault()
    }
    const onDragLeave = () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragging(false)
    }
    const onDrop = (e: DragEvent) => {
      dragDepth.current = 0
      setDragging(false)
      if (!hasFiles(e)) return
      e.preventDefault()
      if (blocked()) return // the dialog's own dropzone handles it
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (files.length === 0) return
      if (!startUploadBatch(projectId, files, dropTarget)) {
        toast.error('An upload is already running', 'Wait for it to finish or cancel it first.')
      }
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [writable, uploadOpen, manageOpen, shareOpen, view.file, projectId, dropTarget])

  useEffect(() => {
    if (!writable) return
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const files = Array.from(e.clipboardData?.files ?? [])
      if (files.length === 0) return
      e.preventDefault()
      if (!startUploadBatch(projectId, files, dropTarget)) {
        toast.error('An upload is already running', 'Wait for it to finish or cancel it first.')
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [writable, projectId, dropTarget])

  // ---- per-file actions ---------------------------------------------------

  const runDownload = async (fileId: string, name: string) => {
    setDownloading((prev) => ({ ...prev, [fileId]: 0 }))
    try {
      await downloadToBrowserProgress(fileId, name, (pct) =>
        setDownloading((prev) => (prev[fileId] === pct ? prev : { ...prev, [fileId]: pct })),
      )
    } catch (err) {
      const d = describeError(err)
      toast.error(d.message, d.fix)
    } finally {
      setDownloading((prev) => {
        if (!(fileId in prev)) return prev
        const next = { ...prev }
        delete next[fileId]
        return next
      })
    }
  }

  const deleteOne = async (fileId: string) => {
    const name = meta[fileId]?.name ?? keyName(fileId)
    const ok = await confirmDialog({
      title: `Delete “${name}”?`,
      body: (
        <div className="confirm-body">
          <div className="confirm-what">It moves to hidden storage trash.</div>
          An admin with storage access can restore it — the app can't.
        </div>
      ),
      confirmLabel: 'Delete file',
      tone: 'danger',
    })
    if (!ok) return
    const r = await removeProjectFile(projectId, fileId, { trashInDrive: true })
    if (r.ok) toast.success(`“${name}” moved to storage trash`)
    else toast.error(r.error)
  }

  const doRename = async (fileId: string, raw: string) => {
    const v = raw.trim()
    setRenamingId(null)
    if (!v) return
    try {
      // The KEY changes (copy+delete under the hood) — rewrite the doc's
      // references to the new key in the same commit. The preview can't
      // follow a key change, so close it first.
      if (view.file === fileId) setView({ file: undefined })
      const next = await renameFile(fileId, v)
      commit((doc) => {
        const p = doc.projects[projectId]
        if (!p) return
        p.fileIds = p.fileIds.map((f) => (f === fileId ? next.id : f))
        const section = p.mediaSectionOf[fileId]
        if (section !== undefined) {
          p.mediaSectionOf[next.id] = section
          delete p.mediaSectionOf[fileId]
        }
        touch('projects', p)
        appendActivity(doc, 'project.file.rename', projectId, { fileId: next.id, name: v })
      })
      toast.success(`Renamed to “${v}”`)
    } catch (e) {
      reportError(e)
    }
  }

  const startRename = (fileId: string) => {
    setRenamingId(fileId)
  }

  // ---- selection & bulk ----------------------------------------------------

  const shownIds = shown.map((it) => it.fileId)
  const allShownSelected = shown.length > 0 && shownIds.every((id) => selected.has(id))
  const toggleSel = (id: string) => toggleSelected(projectId, id)

  const touchAnchor = (fileId: string) => {
    lastTouched.current = fileId
  }

  const rangeSelect = (fileId: string) => {
    const to = shownIds.indexOf(fileId)
    if (to === -1) return
    // Anchor re-resolved by ID in the CURRENT order — a stale anchor from a
    // previous filter just means "start here".
    const fromId = lastTouched.current
    const from = fromId ? shownIds.indexOf(fromId) : -1
    const a = from === -1 ? to : Math.min(from, to)
    const b = from === -1 ? to : Math.max(from, to)
    setSelection(projectId, [...selected, ...shownIds.slice(a, b + 1)])
    lastTouched.current = fileId
    if (!selectMode) setSelectMode(true)
  }

  const runBulk = async (fn: () => Promise<void>) => {
    if (bulkBusy) return
    setBulkBusy(true)
    setError(null)
    setBulkLabel(null)
    try {
      await fn()
    } catch (e) {
      reportError(e)
    } finally {
      setBulkBusy(false)
      setBulkLabel(null)
    }
  }

  const bulkDelete = () => {
    const ids = [...selected]
    if (ids.length === 0) return
    void runBulk(async () => {
      const ok = await confirmDialog({
        title: `Delete ${ids.length} file${ids.length === 1 ? '' : 's'}?`,
        body: (
          <div className="confirm-body">
            <div className="confirm-what">They move to hidden storage trash.</div>
            An admin with storage access can restore them — the app can't.
          </div>
        ),
        confirmLabel: `Delete ${ids.length} file${ids.length === 1 ? '' : 's'}`,
        tone: 'danger',
      })
      if (!ok) return
      const failed: string[] = []
      for (let i = 0; i < ids.length; i++) {
        setBulkLabel(`Deleting ${i + 1}/${ids.length}…`)
        const r = await removeProjectFile(projectId, ids[i], { trashInDrive: true })
        if (!r.ok) failed.push(`${meta[ids[i]]?.name ?? keyName(ids[i])}: ${r.error}`)
      }
      clearSelection(projectId)
      if (failed.length) toast.error('Some files could not be deleted', failed.join(' · '))
      else toast.success(`${ids.length} file${ids.length === 1 ? '' : 's'} moved to storage trash`)
    })
  }

  const bulkDownload = () => {
    const ids = [...selected]
    if (ids.length === 0) return
    void runBulk(async () => {
      let i = 0
      for (const f of ids) {
        setBulkLabel(`Downloading ${i + 1}/${ids.length}…`)
        await downloadToBrowserProgress(f, meta[f]?.name ?? keyName(f), (pct) =>
          setDownloading((prev) => (prev[f] === pct ? prev : { ...prev, [f]: pct })),
        )
        setDownloading((prev) => {
          if (!(f in prev)) return prev
          const next = { ...prev }
          delete next[f]
          return next
        })
        i++
        if (i < ids.length) await new Promise((r) => setTimeout(r, 300))
      }
      toast.success(`Downloaded ${i} file${i === 1 ? '' : 's'}.`)
    })
  }

  const bulkMove = (target: string) => {
    const ids = [...selected]
    if (ids.length === 0 || !target) return
    const to = target === UNSORTED ? null : target
    const label = to === null ? 'Unsorted' : sectionNameOf(to)
    void runBulk(async () => {
      moveMediaToSection(projectId, ids, to)
      clearSelection(projectId)
      toast.success(`Moved ${ids.length} file${ids.length === 1 ? '' : 's'} to ${label}.`)
    })
  }

  const createSection = (name: string) => {
    try {
      addMediaSection(projectId, name)
      toast.success(`Section “${name}” created`)
    } catch (e) {
      reportError(e)
    }
  }

  // ---- lightbox -------------------------------------------------------------

  const lbIdx = view.file ? shown.findIndex((i) => i.fileId === view.file) : -1
  const lbItems: LightboxItem[] =
    lbIdx >= 0
      ? shown.map((i) => ({ fileId: i.fileId, name: i.name, mime: i.mime }))
      : view.file
        ? [{ fileId: view.file, name: meta[view.file]?.name ?? keyName(view.file), mime: meta[view.file]?.mimeType }]
        : []

  return (
    <div style={selectMode && selected.size > 0 ? { paddingBottom: 72 } : undefined}>
      {error && banner('error', 'Media problem', error.fix ? `${error.message} — ${error.fix}` : error.message)}

      <SectionTabs
        sections={project.mediaSections}
        counts={counts}
        active={activeSection}
        writable={writable}
        onSelect={(id) => setView({ section: id })}
        onCreate={createSection}
        onManage={() => setManageOpen(true)}
      />

      <MediaToolbar
        view={view}
        setView={setView}
        items={items}
        shownCount={shown.length}
        totalCount={project.fileIds.length}
        selectMode={selectMode}
        writable={writable}
        onUpload={() => setUploadOpen(true)}
        onShare={() => setShareOpen(true)}
        onToggleSelect={() => {
          if (selectMode) {
            setSelectMode(false)
            clearSelection(projectId)
          } else {
            setSelectMode(true)
          }
        }}
      />

      {/* Grid */}
      {project.fileIds.length === 0 ? (
        <Empty icon="🖼">No media yet — use Upload above, or drop files anywhere on this page.</Empty>
      ) : shown.length === 0 ? (
        <Empty icon="🔍">No files match this filter.</Empty>
      ) : (
        <div className="media-grid">
          {shown.map((it) => (
            <MediaCard
              key={it.fileId}
              item={it}
              sectionName={sectionNameOf(sectionOf[it.fileId])}
              showSection={activeSection === 'all' && sectionOf[it.fileId] !== undefined}
              selected={selected.has(it.fileId)}
              selectMode={selectMode}
              renaming={renamingId === it.fileId}
              downloadPct={downloading[it.fileId]}
              writable={writable}
              onPreview={() => {
                touchAnchor(it.fileId)
                setView({ file: it.fileId })
              }}
              onToggleSelect={() => {
                toggleSel(it.fileId)
                touchAnchor(it.fileId)
                if (!selectMode) setSelectMode(true)
              }}
              onRangeSelect={() => rangeSelect(it.fileId)}
              onDownload={() => void runDownload(it.fileId, it.name)}
              onRenameStart={() => startRename(it.fileId)}
              onRenameCommit={(v) => void doRename(it.fileId, v)}
              onRenameCancel={() => setRenamingId(null)}
              onMove={() => {
                if (!selectMode) setSelectMode(true)
                toggleSel(it.fileId)
                toast.info('Pick a section in the tray below to move this file.')
              }}
              onDelete={() => void deleteOne(it.fileId)}
            />
          ))}
        </div>
      )}

      {/* Floating selection tray — a taped note pinned to the desk */}
      {selectMode && selected.size > 0 && (
        <div className="media-tray">
          <b aria-live="polite">{selected.size} selected</b>
          <button
            className="btn small"
            disabled={bulkBusy}
            onClick={() => setSelection(projectId, allShownSelected ? [] : shownIds)}
          >
            {allShownSelected ? 'Unselect shown' : 'Select shown'}
          </button>
          {selected.size === 1 && (
            <button className="btn small" title="Preview this file" onClick={() => setView({ file: [...selected][0] })}>
              <Icon name="eye" size={13} /> Preview
            </button>
          )}
          {writable && (
            <select
              className="input"
              style={{ maxWidth: 180, padding: '4px 9px', fontSize: 13 }}
              value=""
              disabled={bulkBusy}
              onChange={(e) => bulkMove(e.target.value)}
              aria-label="Move selected files to section"
            >
              <option value="">Move to…</option>
              <option value={UNSORTED}>Unsorted</option>
              {project.mediaSections.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          )}
          <button className="btn small" disabled={bulkBusy} onClick={bulkDownload}>
            Download
          </button>
          {writable && (
            <button className="btn small danger" disabled={bulkBusy} onClick={bulkDelete}>
              Delete
            </button>
          )}
          {bulkBusy && <span className="muted small">{bulkLabel ?? 'Working…'}</span>}
          <button
            className="btn small ghost"
            disabled={bulkBusy}
            onClick={() => {
              setSelectMode(false)
              clearSelection(projectId)
            }}
          >
            Done
          </button>
        </div>
      )}

      {/* Drop veil — the whole page is the dropzone */}
      {dragging && (
        <div className="drop-veil">
          <div className="drop-veil-card">
            <Icon name="upload" size={26} />
            <div className="drop-veil-title">Drop to add to {uploadTargetLabel}</div>
            <div className="drop-veil-sub">files upload straight to storage — keep working while they run</div>
          </div>
        </div>
      )}

      {/* Dialogs + preview */}
      {uploadOpen && (
        <UploadDialog
          projectId={projectId}
          sections={project.mediaSections}
          target={uploadTarget}
          onTargetChange={setUploadSection}
          onClose={() => setUploadOpen(false)}
        />
      )}
      {shareOpen && <UploadLinksModal projectId={projectId} onClose={() => setShareOpen(false)} />}
      {manageOpen && (
        <ManageSectionsDialog
          projectId={projectId}
          sections={project.mediaSections}
          counts={counts}
          activeSection={activeSection}
          onSectionRemoved={() => setView({ section: 'all' })}
          onClose={() => setManageOpen(false)}
        />
      )}
      {lbItems.length > 0 && view.file && (
        <Lightbox
          items={lbItems}
          index={Math.max(0, lbIdx)}
          onClose={() => setView({ file: undefined })}
          onNavigate={lbIdx >= 0 && shown.length > 1 ? (next) => setView({ file: shown[next].fileId }) : undefined}
          actions={
            writable
              ? (item) => (
                  <>
                    <button
                      className="media-lb-btn"
                      title="Rename"
                      aria-label={`Rename ${item.name}`}
                      onClick={() => {
                        setView({ file: undefined })
                        startRename(item.fileId)
                      }}
                    >
                      <Icon name="pencil" size={15} />
                    </button>
                    <button
                      className="media-lb-btn media-lb-danger"
                      title="Delete"
                      aria-label={`Delete ${item.name}`}
                      onClick={() => {
                        setView({ file: undefined })
                        void deleteOne(item.fileId)
                      }}
                    >
                      <Icon name="trash" size={15} />
                    </button>
                  </>
                )
              : undefined
          }
        />
      )}
    </div>
  )
}
