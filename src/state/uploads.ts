// Global upload queue — lives outside React so a batch keeps running (and
// its progress tile stays visible) no matter which page the user wanders
// off to. The Media tab's upload modal and the floating tile both read it;
// one batch runs at a time, app-wide.

import { useSyncExternalStore } from 'react'
import { uploadToProject } from './actions'

export interface UploadEntry {
  name: string
  pct: number
  /** The pool worker has picked this file up (bytes moving or finishing). */
  started?: boolean
  done?: boolean
  ok?: boolean
  err?: string
  /** Media section this file targets — a retry re-uploads into it. Not rendered. */
  sectionId?: string | null
}

export interface UploadBatch {
  projectId: string
  files: UploadEntry[]
}

let batch: UploadBatch | null = null
// Retained index-aligned with batch.files: UploadEntry keeps only the name,
// so retry needs the module side to hold the actual File objects.
let batchFiles: File[] = []
// One controller per run (a batch start, or a single retry). cancelUploadBatch
// aborts it; retry replaces it with a fresh one.
let abortCtl: AbortController | null = null
let autoDismissTimer: ReturnType<typeof setTimeout> | null = null
const subs = new Set<() => void>()

function emit(): void {
  for (const fn of subs) fn()
}

export function subscribeUploads(fn: () => void): () => void {
  subs.add(fn)
  return () => {
    subs.delete(fn)
  }
}

export function getUploadBatch(): UploadBatch | null {
  return batch
}

export function useUploadBatch(): UploadBatch | null {
  // getServerSnapshot is required for the build-time prerender (module-level
  // singleton — the server always sees the same value the client starts with).
  return useSyncExternalStore(subscribeUploads, getUploadBatch, getUploadBatch)
}

export function uploadsBusy(): boolean {
  return batch !== null && batch.files.some((f) => !f.done)
}

/** Clear the batch and everything retained alongside it. */
function closeBatch(): void {
  batch = null
  batchFiles = []
  abortCtl = null
  emit()
}

/** Files uploaded concurrently within one batch. Bytes go browser-direct to
 *  OCI (no Drive-era throttle to pace around); 3 keeps per-file progress
 *  readable, stays under the browser's ~6-connections-per-host budget, and
 *  bounds contention on the server-side doc link each completion performs. */
export const UPLOAD_CONCURRENCY = 3

/** Upload a batch (up to UPLOAD_CONCURRENCY files at once), publishing
 *  progress to the store. Refused while another batch is running; replaces a
 *  finished one. */
export function startUploadBatch(projectId: string, files: File[], sectionId: string | null): boolean {
  if (uploadsBusy() || files.length === 0) return false
  if (autoDismissTimer !== null) {
    clearTimeout(autoDismissTimer)
    autoDismissTimer = null
  }
  batch = { projectId, files: files.map((f) => ({ name: f.name, pct: 0, sectionId })) }
  batchFiles = [...files]
  const ctl = new AbortController()
  abortCtl = ctl
  emit()
  void (async () => {
    let next = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        // A cancel stops the queue here, before the next index is taken —
        // queued entries keep their slots for cancelUploadBatch to close out.
        if (ctl.signal.aborted || !batch) return
        const i = next++
        if (i >= files.length) return
        batch = { ...batch, files: batch.files.map((u, j) => (j === i ? { ...u, started: true } : u)) }
        emit()
        const r = await uploadToProject(projectId, files[i], (pct) => {
          if (!batch) return
          // New object identity on every tick — useSyncExternalStore compares
          // snapshots by reference, so in-place mutation would never re-render.
          batch = { ...batch, files: batch.files.map((u, j) => (j === i ? { ...u, pct } : u)) }
          emit()
        }, { sectionId, signal: ctl.signal })
        if (!batch) return
        batch = {
          ...batch,
          files: batch.files.map((u, j) =>
            j === i ? { ...u, pct: 100, done: true, ok: r.ok, err: r.ok ? undefined : r.error } : u,
          ),
        }
        emit()
      }
    }
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, worker))
    // All-good batches linger briefly as a receipt, then close themselves.
    // Failures (and cancels) stay until dismissed so they can't scroll by unseen.
    const finished = batch
    if (finished && finished.files.every((f) => f.ok)) {
      autoDismissTimer = setTimeout(() => {
        if (batch === finished) closeBatch()
      }, 4000)
    }
    emit()
  })()
  return true
}

/** Abort the running batch. In-flight uploads reject with the marked error
 *  and close their own entries ('Upload cancelled'); never-started ones are
 *  closed out here immediately. After this uploadsBusy() is false, so the
 *  batch can be dismissed or replaced. */
export function cancelUploadBatch(): void {
  if (!batch || !uploadsBusy()) return
  const ctl = abortCtl
  abortCtl = null
  ctl?.abort()
  batch = {
    ...batch,
    files: batch.files.map((u) =>
      u.done || u.started ? u : { ...u, pct: 100, done: true, ok: false, err: 'Cancelled' },
    ),
  }
  emit()
}

/** Re-run one failed entry with its retained File and original section.
 *  Refused unless the whole batch is idle (finish or cancel first) and the
 *  target is a finished failure — returns false when refused. */
export function retryUploadEntry(index: number): boolean {
  if (!batch || uploadsBusy()) return false
  const entry = batch.files[index]
  const file = batchFiles[index]
  if (!entry || !entry.done || entry.ok !== false || !file) return false
  if (autoDismissTimer !== null) {
    clearTimeout(autoDismissTimer)
    autoDismissTimer = null
  }
  const ctl = new AbortController()
  abortCtl = ctl
  const projectId = batch.projectId
  const sectionId = entry.sectionId ?? null
  batch = {
    ...batch,
    files: batch.files.map((u, j) =>
      j === index ? { ...u, pct: 0, started: true, done: false, ok: undefined, err: undefined } : u,
    ),
  }
  emit()
  void (async () => {
    const r = await uploadToProject(projectId, file, (pct) => {
      if (!batch) return
      batch = { ...batch, files: batch.files.map((u, j) => (j === index ? { ...u, pct } : u)) }
      emit()
    }, { sectionId, signal: ctl.signal })
    if (!batch) return
    batch = {
      ...batch,
      files: batch.files.map((u, j) =>
        j === index ? { ...u, pct: 100, done: true, ok: r.ok, err: r.ok ? undefined : r.error } : u,
      ),
    }
    emit()
    // A retry that clears the last failure earns the receipt timer too.
    const finished = batch
    if (finished && finished.files.every((f) => f.ok)) {
      autoDismissTimer = setTimeout(() => {
        if (batch === finished) closeBatch()
      }, 4000)
    }
    emit()
  })()
  return true
}

/** Wait until the current run drains — retryUploadEntry refuses while
 *  anything is in flight, so a multi-entry retry walks one run at a time. */
function drained(): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (!uploadsBusy()) {
        unsubscribe()
        resolve()
      }
    }
    const unsubscribe = subscribeUploads(check)
    check()
  })
}

/** Retry every failed entry, one run at a time. Stops walking if the user
 *  cancels mid-way (the entry that was in flight comes back 'Upload
 *  cancelled' — honour that instead of resuming the next one) or if the
 *  batch changes underneath. Returns how many retries were started. */
export async function retryFailedUploads(): Promise<number> {
  const failed = batch ? batch.files.flatMap((f, i) => (f.done && f.ok === false ? [i] : [])) : []
  let started = 0
  for (const i of failed) {
    if (!batch || !retryUploadEntry(i)) return started
    started++
    await drained()
    // The user cancelled this run — don't quietly start the next file.
    if (batch && /cancel/i.test(batch.files[i]?.err ?? '')) return started
  }
  return started
}

/** Drop a finished batch (and its tile). Refused mid-run. */
export function dismissUploads(): void {
  if (uploadsBusy()) return
  closeBatch()
}
