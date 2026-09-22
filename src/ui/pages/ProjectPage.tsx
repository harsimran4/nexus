import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../../sync/store'
import { Empty, Modal, StatusBadge, banner, useDebouncedCommit, PageQuote } from '../components'
import { canWrite } from '../../auth/session'
import {
  addMediaSection,
  moveMediaToSection,
  readScriptBody,
  removeMediaSection,
  removeProjectFile,
  renameMediaSection,
  setProjectStatus,
  updateProject,
  updateScript,
  uploadToProject,
} from '../../state/actions'
import { describeError, downloadToBrowserProgress } from '../../drive/preview'
import { getMeta, listChildren, renameFile, thumbnailUrl, webViewLink, type FileMeta } from '../../drive/client'
import {
  KIND_GLYPH,
  KIND_LABEL,
  UNSORTED,
  buildItems,
  filterAndSort,
  formatBytes,
  fileSizeBytes,
  kindFromMime,
  totalSize,
  type MediaKind,
  type MediaSort,
} from '../../util/media'
import { navigate } from '../../App'
import { touch } from '../../sync/writer'

type Tab = 'media' | 'scripts' | 'settings'

const TABS: { id: Tab; label: string }[] = [
  { id: 'media', label: 'Media' },
  { id: 'scripts', label: 'Scripts' },
  { id: 'settings', label: 'Settings' },
]

export function ProjectPage({ projectId }: { projectId: string }): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const [tab, setTab] = useState<Tab>('media')
  const project = doc?.projects[projectId]

  if (!doc || !project || project.deleted !== null) {
    return (
      <Empty icon="▦">
        This project doesn't exist or was deleted. <a href="#/dash">Back to board</a>
      </Empty>
    )
  }

  const group = doc.groups[project.groupId]

  return (
    <div>
      <div className="content-header">
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 8 }}>
            <a href="#/dash" className="faint small">← board</a>
            {group && <a href={`#/group/${group.id}`} className="faint small">{group.name} /</a>}
          </div>
          <NameEditor projectId={projectId} name={project.name} />
          <div className="row wrap" style={{ marginTop: 6 }}>
            <select
              className="input"
              style={{ maxWidth: 170, padding: '4px 9px', fontSize: 13 }}
              value={project.status}
              disabled={!canWrite()}
              onChange={(e) => setProjectStatus(projectId, e.target.value)}
            >
              {doc.settings.pipeline.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <StatusBadge doc={doc} status={project.status} />
          </div>
        </div>
        <div className="row">
          {TABS.map((t) => (
            <button key={t.id} className={`chip ${tab === t.id ? 'on' : ''}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <PageQuote topic="project" />

      {tab === 'media' && <MediaTab projectId={projectId} />}
      {tab === 'scripts' && <ScriptsTab projectId={projectId} />}
      {tab === 'settings' && <SettingsTab projectId={projectId} />}
    </div>
  )
}

/** Inline-editable project name — renames the Drive subfolder to match. The
 *  name sits in a manila folder tab: a project IS a folder on Drive. */
function NameEditor({ projectId, name }: { projectId: string; name: string }): React.JSX.Element {
  const writable = canWrite()
  return (
    <div className="project-tab">
      <input
        className="input"
        style={{ fontSize: 20, fontWeight: 650, background: 'none', border: 'none', padding: '2px 0', maxWidth: 620 }}
        defaultValue={name}
        disabled={!writable}
        onBlur={(e) => {
          const v = e.target.value.trim()
          if (!v || v === name) {
            e.target.value = name
            return
          }
          updateProject(projectId, { name: v })
          void (async () => {
            const { storeGet } = await import('../../sync/store')
            const folderId = storeGet().doc?.projects[projectId]?.folderId
            if (folderId) await renameFile(folderId, v, { mode: 'bearer' }).catch(() => {})
          })()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Media tab
// ---------------------------------------------------------------------------

function MediaTab({ projectId }: { projectId: string }): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [meta, setMeta] = useState<Record<string, FileMeta>>({})
  // media view state: section (all / unsorted / section id), kind filter, sort, search
  const [section, setSection] = useState<string>('all')
  const [kind, setKind] = useState<MediaKind | 'all'>('all')
  const [sort, setSort] = useState<MediaSort>('added-desc')
  const [search, setSearch] = useState('')
  // selection + bulk
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkLabel, setBulkLabel] = useState<string | null>(null)
  const [downloading, setDownloading] = useState<Record<string, number | null>>({})
  // section CRUD drafts
  const [newSectionName, setNewSectionName] = useState<string | null>(null)
  const [renamingSection, setRenamingSection] = useState<string | null>(null)
  const [sectionName, setSectionName] = useState('')
  // file rename (per card)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  // upload
  const [uploadSection, setUploadSection] = useState('')
  const [uploadQueue, setUploadQueue] = useState<{ name: string; pct: number }[] | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const writable = canWrite()

  const project = doc?.projects[projectId]
  if (!doc || !project) return <></>

  const fileKey = project.fileIds.join(',')
  const folderId = project.folderId
  const sectionOf = project.mediaSectionOf

  // One files.list per visit replaces the old N× getMeta calls; per-file
  // getMeta fills only ids the listing missed (file moved manually on Drive,
  // or no folder linked yet). Wholesale list merge also refreshes sizes.
  useEffect(() => {
    let alive = true
    const ids = fileKey ? fileKey.split(',') : []
    const fetchOne = (f: string) =>
      getMeta(f, { mode: 'auto' })
        .then((m) => {
          if (alive) setMeta((prev) => ({ ...prev, [f]: m }))
        })
        .catch(() => {
          if (alive) setMeta((prev) => ({ ...prev, [f]: { id: f, name: f } }))
        })
    const run = async () => {
      if (folderId) {
        try {
          const files: FileMeta[] = []
          let pageToken: string | undefined
          for (let page = 0; page < 10 && (page === 0 || pageToken); page++) {
            const res = await listChildren(folderId, { mode: 'auto' }, { pageToken })
            files.push(...res.files)
            pageToken = res.nextPageToken
          }
          if (!alive) return
          const byId = new Map(files.map((f) => [f.id, f]))
          setMeta((prev) => {
            const next = { ...prev }
            for (const f of ids) {
              const m = byId.get(f)
              if (m) next[f] = m
            }
            return next
          })
          for (const f of ids) if (!byId.has(f)) void fetchOne(f)
          return
        } catch {
          // listing failed (e.g. key path can't see the folder) — per-file below
        }
      }
      for (const f of ids) void fetchOne(f)
    }
    void run()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKey, folderId])

  const items = useMemo(() => buildItems(project.fileIds, meta), [fileKey, meta])

  // A deleted section id falls back to All (e.g. a peer removed it mid-view).
  const activeSection =
    section === 'all' || section === UNSORTED || project.mediaSections.some((s) => s.id === section)
      ? section
      : 'all'

  const shown = useMemo(
    () => filterAndSort(items, { search, kind, section: activeSection, sectionOf, sort }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, search, kind, activeSection, sectionOf, sort],
  )
  const totals = totalSize(shown)

  const countFor = (sec: string) =>
    items.filter((it) =>
      sec === 'all' ? true : sec === UNSORTED ? !sectionOf[it.fileId] : sectionOf[it.fileId] === sec,
    ).length

  const sectionNameOf = (id: string | undefined) =>
    id ? project.mediaSections.find((s) => s.id === id)?.name ?? UNSORTED : UNSORTED

  // Drop selection entries whose files are gone (bulk delete / peer delete).
  useEffect(() => {
    const ids = new Set(project.fileIds)
    setSelected((prev) => {
      const pruned = new Set([...prev].filter((f) => ids.has(f)))
      return pruned.size === prev.size ? prev : pruned
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKey])

  // Uploads default into the section you're looking at.
  useEffect(() => {
    if (activeSection !== 'all' && activeSection !== UNSORTED) setUploadSection(activeSection)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSection])

  const toggleSel = (f: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(f)) next.delete(f)
      else next.add(f)
      return next
    })
  const allShownSelected = shown.length > 0 && shown.every((it) => selected.has(it.fileId))

  const flash = (msg: string) => setNote(msg)

  const runBulk = async (fn: () => Promise<void>) => {
    if (bulkBusy) return
    setBulkBusy(true)
    setError(null)
    setNote(null)
    setBulkLabel(null)
    try {
      await fn()
    } catch (e) {
      setError(describeError(e).message)
    } finally {
      setBulkBusy(false)
      setBulkLabel(null)
    }
  }

  /** One file download with a live progress bar on its card. Percent may be
   *  null (no Content-Length) — the bar then runs indeterminate. */
  const runDownload = async (fileId: string, name: string) => {
    setDownloading((prev) => ({ ...prev, [fileId]: 0 }))
    try {
      await downloadToBrowserProgress(fileId, name, (pct) =>
        setDownloading((prev) => (prev[fileId] === pct ? prev : { ...prev, [fileId]: pct })),
      )
    } catch (err) {
      setError(describeError(err).message)
    } finally {
      setDownloading((prev) => {
        if (!(fileId in prev)) return prev
        const next = { ...prev }
        delete next[fileId]
        return next
      })
    }
  }

  const bulkDelete = () => {
    const ids = [...selected]
    if (ids.length === 0) return
    if (!confirm(`Delete ${ids.length} file${ids.length === 1 ? '' : 's'}? They move to Drive trash (recoverable for 30 days).`)) return
    void runBulk(async () => {
      const failed: string[] = []
      for (let i = 0; i < ids.length; i++) {
        setBulkLabel(`Deleting ${i + 1}/${ids.length}…`)
        const r = await removeProjectFile(projectId, ids[i], { trashInDrive: true })
        if (!r.ok) failed.push(`${meta[ids[i]]?.name ?? ids[i]}: ${r.error}`)
      }
      setSelected(new Set())
      if (failed.length) setError(`Some files could not be deleted — ${failed.join(' · ')}`)
      else flash(`${ids.length} file${ids.length === 1 ? '' : 's'} moved to Drive trash.`)
    })
  }

  const bulkDownload = () => {
    const ids = [...selected]
    if (ids.length === 0) return
    void runBulk(async () => {
      let i = 0
      for (const f of ids) {
        setBulkLabel(`Downloading ${i + 1}/${ids.length}…`)
        await downloadToBrowserProgress(f, meta[f]?.name ?? f, (pct) =>
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
      flash(`Downloaded ${i} file${i === 1 ? '' : 's'}.`)
    })
  }

  const bulkMove = (target: string) => {
    const ids = [...selected]
    if (ids.length === 0 || !target) return
    const to = target === UNSORTED ? null : target
    const label = to === null ? 'Unsorted' : sectionNameOf(to)
    void runBulk(async () => {
      moveMediaToSection(projectId, ids, to)
      setSelected(new Set())
      flash(`Moved ${ids.length} file${ids.length === 1 ? '' : 's'} to ${label}.`)
    })
  }

  const createSection = () => {
    const v = (newSectionName ?? '').trim()
    setNewSectionName(null)
    if (!v) return
    try {
      addMediaSection(projectId, v)
    } catch (e) {
      setError(describeError(e).message)
    }
  }

  const doRenameSection = () => {
    const id = renamingSection
    setRenamingSection(null)
    if (!id) return
    try {
      renameMediaSection(projectId, id, sectionName)
    } catch (e) {
      setError(describeError(e).message)
    }
  }

  const deleteSection = (id: string) => {
    const s = project.mediaSections.find((x) => x.id === id)
    if (!s) return
    const n = countFor(id)
    if (!confirm(`Delete section "${s.name}"? Its ${n} file${n === 1 ? '' : 's'} move to Unsorted.`)) return
    try {
      removeMediaSection(projectId, id)
      if (section === id) setSection('all')
    } catch (e) {
      setError(describeError(e).message)
    }
  }

  const doRename = async (fileId: string) => {
    const v = renameValue.trim()
    setRenamingId(null)
    if (!v) return
    try {
      await renameFile(fileId, v, { mode: 'bearer' })
      setMeta((prev) => ({ ...prev, [fileId]: { ...prev[fileId], id: fileId, name: v } }))
    } catch (e) {
      setError(describeError(e).message)
    }
  }

  const startUploads = async (files: File[]) => {
    if (files.length === 0) return
    setError(null)
    setNote(null)
    const target = uploadSection || null
    // Entries stay in place (indices must not shift); a finished file just
    // sits at pct 100 until the whole batch is done.
    setUploadQueue(files.map((f) => ({ name: f.name, pct: 0 })))
    const failed: string[] = []
    let okCount = 0
    for (let i = 0; i < files.length; i++) {
      const r = await uploadToProject(
        projectId,
        files[i],
        (pct) => setUploadQueue((q) => (q ? q.map((u, j) => (j === i ? { ...u, pct } : u)) : q)),
        { sectionId: target },
      )
      if (r.ok) okCount++
      else failed.push(`${files[i].name}: ${r.error}`)
      setUploadQueue((q) => (q ? q.map((u, j) => (j === i ? { ...u, pct: 100 } : u)) : q))
    }
    setUploadQueue(null)
    if (failed.length) setError(`Some uploads failed — ${failed.join(' · ')}`)
    else if (files.length > 1) flash(`Uploaded ${okCount} file${okCount === 1 ? '' : 's'}.`)
  }

  const uploadTotal = uploadQueue?.length ?? 0
  const uploadDone = uploadQueue ? uploadQueue.filter((u) => u.pct >= 100).length : 0
  const uploadCurrent = uploadQueue?.find((u) => u.pct < 100)

  return (
    <div>
      {error && banner('error', 'Media problem', error)}
      {note && banner('info', note)}

      {project.fileIds.length === 0 ? (
        <Empty icon="🖼">No media yet — upload below.</Empty>
      ) : (
        <>
          {/* Sections row */}
          <div className="row wrap" style={{ gap: 6, alignItems: 'center', marginBottom: 10 }}>
            <div className="chips">
              <button className={`chip ${activeSection === 'all' ? 'on' : ''}`} onClick={() => setSection('all')}>
                All ({countFor('all')})
              </button>
              <button className={`chip ${activeSection === UNSORTED ? 'on' : ''}`} onClick={() => setSection(UNSORTED)}>
                Unsorted ({countFor(UNSORTED)})
              </button>
              {project.mediaSections.map((s) => (
                <button
                  key={s.id}
                  className={`chip ${activeSection === s.id ? 'on' : ''}`}
                  onClick={() => setSection(s.id)}
                >
                  {s.name} ({countFor(s.id)})
                </button>
              ))}
            </div>
            {writable && activeSection !== 'all' && activeSection !== UNSORTED && (
              <span className="row" style={{ gap: 4 }}>
                <button
                  className="btn small ghost"
                  title="Rename section"
                  onClick={() => {
                    setSectionName(project.mediaSections.find((s) => s.id === activeSection)?.name ?? '')
                    setRenamingSection(activeSection)
                  }}
                >
                  ✎
                </button>
                <button className="btn small ghost" title="Delete section" onClick={() => deleteSection(activeSection)}>
                  ✕
                </button>
              </span>
            )}
            {writable &&
              (newSectionName === null ? (
                <button className="chip" title="New section" onClick={() => setNewSectionName('')}>
                  ＋ section
                </button>
              ) : (
                <input
                  className="input"
                  style={{ width: 150, padding: '2px 9px', fontSize: 13 }}
                  placeholder="Section name…"
                  value={newSectionName}
                  autoFocus
                  onChange={(e) => setNewSectionName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') createSection()
                    if (e.key === 'Escape') setNewSectionName(null)
                  }}
                  onBlur={createSection}
                />
              ))}
          </div>

          {/* Filter / sort bar */}
          <div className="card mb8" style={{ padding: '10px 12px' }}>
            <div className="row wrap" style={{ gap: 8 }}>
              <input
                className="input"
                style={{ maxWidth: 220, padding: '4px 9px', fontSize: 13 }}
                placeholder="Search by name…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <div className="chips">
                {(['all', 'image', 'video', 'audio', 'other'] as const).map((k) => (
                  <button key={k} className={`chip ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>
                    {k === 'all' ? 'All types' : `${KIND_GLYPH[k]} ${KIND_LABEL[k]}`}
                  </button>
                ))}
              </div>
              <select
                className="input"
                style={{ maxWidth: 190, padding: '4px 9px', fontSize: 13 }}
                value={sort}
                onChange={(e) => setSort(e.target.value as MediaSort)}
              >
                <option value="added-desc">Newest first</option>
                <option value="added-asc">Oldest first</option>
                <option value="name-asc">Name A→Z</option>
                <option value="name-desc">Name Z→A</option>
                <option value="size-desc">Size: large → small</option>
                <option value="size-asc">Size: small → large</option>
              </select>
            </div>
            <div className="muted small" style={{ marginTop: 6 }}>
              {shown.length} of {project.fileIds.length} file{project.fileIds.length === 1 ? '' : 's'} ·{' '}
              {formatBytes(totals.known)}
              {totals.unknownCount > 0 ? ` + ${totals.unknownCount} unknown` : ''}
            </div>
          </div>

          {/* Bulk bar */}
          {selected.size > 0 && (
            <div className="card mb8" style={{ padding: '10px 12px', borderColor: 'var(--accent)' }}>
              <div className="row wrap" style={{ gap: 8 }}>
                <b>{selected.size} selected</b>
                <button
                  className="btn small"
                  disabled={bulkBusy}
                  onClick={() =>
                    setSelected(allShownSelected ? new Set() : new Set(shown.map((it) => it.fileId)))
                  }
                >
                  {allShownSelected ? 'Unselect shown' : 'Select shown'}
                </button>
                <button className="btn small ghost" disabled={bulkBusy} onClick={() => setSelected(new Set())}>
                  Clear
                </button>
                {writable && (
                  <select className="input" style={{ maxWidth: 180, padding: '4px 9px', fontSize: 13 }} value="" disabled={bulkBusy} onChange={(e) => bulkMove(e.target.value)}>
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
              </div>
            </div>
          )}

          {shown.length === 0 ? (
            <Empty icon="🔍">No files match this filter.</Empty>
          ) : (
            <div className="media-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 14 }}>
              {shown.map((it) => {
                const f = it.fileId
                const info = meta[f]
                const fileKind = kindFromMime(info?.mimeType)
                const displayName = renamingId === f ? renameValue : info?.name ?? f
                const isSel = selected.has(f)
                const dlPct = downloading[f]
                return (
                  <div key={f} className={`photo-frame${isSel ? ' sel' : ''}`}>
                    <input
                      type="checkbox"
                      className="media-check"
                      checked={isSel}
                      onChange={() => toggleSel(f)}
                      aria-label={`Select ${displayName}`}
                      title="Select"
                    />
                    <div
                      style={{
                        aspectRatio: '16/9',
                        background: 'var(--bg)',
                        borderRadius: 8,
                        overflow: 'hidden',
                        display: 'grid',
                        placeItems: 'center',
                        marginBottom: 8,
                        position: 'relative',
                      }}
                    >
                      <img
                        src={thumbnailUrl(f, 400)}
                        alt={displayName}
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
                      />
                      {fileKind !== 'image' && (
                        <span className="media-kind-badge">
                          {KIND_GLYPH[fileKind]} {KIND_LABEL[fileKind]}
                        </span>
                      )}
                    </div>
                    {dlPct !== undefined && (
                      <div className={`progress dl-progress${dlPct === null ? ' indeterminate' : ''}`}>
                        <div style={{ width: `${dlPct ?? 0}%` }} />
                      </div>
                    )}
                    {renamingId === f ? (
                      <input
                        className="input"
                        value={renameValue}
                        autoFocus
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void doRename(f)
                          if (e.key === 'Escape') setRenamingId(null)
                        }}
                        onBlur={() => void doRename(f)}
                      />
                    ) : (
                      <div className="small" style={{ fontWeight: 570, wordBreak: 'break-word' }} title={displayName}>
                        {displayName}
                      </div>
                    )}
                    <div className="media-meta">
                      {formatBytes(fileSizeBytes(info?.size))}
                      {activeSection === 'all' && sectionOf[f] ? ` · ${sectionNameOf(sectionOf[f])}` : ''}
                    </div>
                    <div className="row wrap mt8">
                      <a className="btn small" href={webViewLink(f)} target="_blank" rel="noreferrer">Open</a>
                      <button
                        className="btn small"
                        disabled={dlPct !== undefined}
                        onClick={() => void runDownload(f, info?.name ?? displayName)}
                      >
                        {dlPct !== undefined ? 'Downloading…' : 'Download'}
                      </button>
                      {writable && renamingId !== f && (
                        <button
                          className="btn small ghost"
                          onClick={() => {
                            setRenameValue(info?.name ?? f)
                            setRenamingId(f)
                          }}
                        >
                          Rename
                        </button>
                      )}
                      {writable && (
                        <button
                          className="btn small danger"
                          onClick={async () => {
                            if (!confirm(`Delete "${displayName}"? It moves to Drive trash (recoverable for 30 days).`)) return
                            const r = await removeProjectFile(projectId, f, { trashInDrive: true })
                            if (!r.ok) setError(r.error)
                          }}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}

      {writable && (
        <div className="mt16">
          {project.fileIds.length > 0 || project.mediaSections.length > 0 ? (
            <div className="row wrap" style={{ gap: 8, marginBottom: 8 }}>
              <span className="muted small">Upload to</span>
              <select
                className="input"
                style={{ maxWidth: 200, padding: '4px 9px', fontSize: 13 }}
                value={uploadSection}
                onChange={(e) => setUploadSection(e.target.value)}
              >
                <option value="">Unsorted</option>
                {project.mediaSections.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          ) : null}
          <div
            className={`dropzone${dragOver ? ' drag' : ''}`}
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              void startUploads(Array.from(e.dataTransfer.files))
            }}
          >
            {uploadQueue ? (
              <div>
                <div className="small muted">
                  {uploadDone}/{uploadTotal} uploaded · {uploadCurrent ? uploadCurrent.name : 'finishing…'}
                </div>
                <div className="progress"><div style={{ width: `${uploadCurrent?.pct ?? 100}%` }} /></div>
              </div>
            ) : (
              'Drop media here or click to upload → this project\'s folder on Drive'
            )}
          </div>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void startUploads(Array.from(e.target.files ?? []))
              e.target.value = ''
            }}
          />
        </div>
      )}

      {renamingSection && (
        <Modal title="Rename section" onClose={() => setRenamingSection(null)}>
          <div className="field">
            <label>Section name</label>
            <input
              className="input"
              value={sectionName}
              autoFocus
              onChange={(e) => setSectionName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') doRenameSection()
              }}
            />
          </div>
          <div className="row">
            <button className="btn" onClick={doRenameSection}>Rename</button>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Scripts tab — read scripts in place, link/unlink
// ---------------------------------------------------------------------------

function ScriptsTab({ projectId }: { projectId: string }): React.JSX.Element {
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
              <a className="btn small" href="#/scripts">Edit on Scripts page</a>
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

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

function SettingsTab({ projectId }: { projectId: string }): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const writable = canWrite()
  const [labelInput, setLabelInput] = useState('')
  const commitNotesDebounced = useDebouncedCommit(800)
  const project = doc?.projects[projectId]
  const [notesDraft, setNotesDraft] = useState(project?.notes ?? '')
  const notesDirty = useRef(false)

  useEffect(() => {
    if (!notesDirty.current && project && project.notes !== notesDraft) setNotesDraft(project.notes)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.notes])

  if (!doc || !project) return <></>

  const commitNotes = (value: string) => {
    commitNotesDebounced((d) => {
      const p = d.projects[projectId]
      if (!p) return
      p.notes = value
      touch('projects', p)
    })
  }

  return (
    <div>
      <div className="field">
        <label>Assignee</label>
        <select
          className="input"
          style={{ maxWidth: 260 }}
          value={project.assigneeAppId ?? ''}
          disabled={!writable}
          onChange={(e) => updateProject(projectId, { assigneeAppId: e.target.value || null })}
        >
          <option value="">Unassigned</option>
          {doc.users.app.filter((u) => !u.disabled).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </div>

      <div className="field">
        <label>Due date</label>
        <input
          className="input"
          style={{ maxWidth: 200 }}
          type="date"
          value={project.dueAt ? project.dueAt.slice(0, 10) : ''}
          disabled={!writable}
          onChange={(e) => updateProject(projectId, { dueAt: e.target.value || null })}
        />
      </div>

      <div className="field">
        <label>Group (moves the folder + files)</label>
        <select
          className="input"
          style={{ maxWidth: 260 }}
          value={project.groupId}
          disabled={!writable}
          onChange={(e) => {
            const next = e.target.value
            if (next === project.groupId) return
            if (confirm('Move this project (and its files) to the selected group?')) {
              updateProject(projectId, { groupId: next })
            }
          }}
        >
          {Object.values(doc.groups)
            .filter((g) => g.deleted === null)
            .map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </div>

      <div className="field">
        <label>Labels</label>
        <div className="chips">
          {[...new Set([...doc.settings.labels, ...project.labels])].map((l) => {
            const on = project.labels.includes(l)
            return (
              <button
                key={l}
                className={`chip ${on ? 'on' : ''}`}
                disabled={!writable}
                onClick={() =>
                  updateProject(projectId, { labels: on ? project.labels.filter((x) => x !== l) : [...project.labels, l] })
                }
              >
                {l}
              </button>
            )
          })}
          {writable && (
            <input
              className="input"
              style={{ width: 130, padding: '2px 9px', fontSize: 12 }}
              placeholder="+ new label"
              value={labelInput}
              onChange={(e) => setLabelInput(e.target.value)}
              onKeyDown={(e) => {
                const v = labelInput.trim()
                if (e.key === 'Enter' && v) {
                  updateProject(projectId, { labels: [...new Set([...project.labels, v])] })
                  setLabelInput('')
                }
              }}
            />
          )}
        </div>
      </div>

      <div className="field">
        <label>Notes</label>
        <textarea
          className="input legal-pad"
          value={notesDraft}
          disabled={!writable}
          onChange={(e) => {
            setNotesDraft(e.target.value)
            notesDirty.current = true
            commitNotes(e.target.value)
          }}
          onBlur={() => {
            notesDirty.current = false
          }}
          placeholder="Context, links, feedback…"
        />
      </div>

      {writable && (
        <div className="card" style={{ borderColor: 'rgba(255,107,122,.35)' }}>
          <h3>Danger zone</h3>
          <p className="muted small">
            Deletes this project and moves its Drive folder (with all files) to Drive trash — recoverable for 30 days.
          </p>
          <button
            className="btn danger"
            onClick={async () => {
              const fileList = project.fileIds.length
                ? `It has ${project.fileIds.length} file${project.fileIds.length === 1 ? '' : 's'}.`
                : 'It has no files.'
              if (confirm(`Delete project "${project.name}"?\n\n${fileList}\n\nYou can restore it from the Archive.`)) {
                const { deleteProjectCascade } = await import('../../state/actions')
                await deleteProjectCascade(projectId)
                navigate('dash')
              }
            }}
          >
            Delete project
          </button>
        </div>
      )}
    </div>
  )
}
