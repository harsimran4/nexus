// Global upload queue — lives outside React so a batch keeps running (and
// its progress tile stays visible) no matter which page the user wanders
// off to. The Media tab's upload modal and the floating tile both read it;
// one batch runs at a time, app-wide.

import { useSyncExternalStore } from 'react'
import { uploadToProject } from './actions'

export interface UploadEntry {
  name: string
  pct: number
  done?: boolean
  ok?: boolean
  err?: string
}

export interface UploadBatch {
  projectId: string
  files: UploadEntry[]
}

let batch: UploadBatch | null = null
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
  return useSyncExternalStore(subscribeUploads, getUploadBatch)
}

export function uploadsBusy(): boolean {
  return batch !== null && batch.files.some((f) => !f.done)
}

/** Upload a batch sequentially, publishing progress to the store. Refused
 *  while another batch is running; replaces a finished one. */
export function startUploadBatch(projectId: string, files: File[], sectionId: string | null): boolean {
  if (uploadsBusy() || files.length === 0) return false
  if (autoDismissTimer !== null) {
    clearTimeout(autoDismissTimer)
    autoDismissTimer = null
  }
  batch = { projectId, files: files.map((f) => ({ name: f.name, pct: 0 })) }
  emit()
  void (async () => {
    for (let i = 0; i < files.length; i++) {
      const r = await uploadToProject(projectId, files[i], (pct) => {
        if (!batch) return
        batch.files = batch.files.map((u, j) => (j === i ? { ...u, pct } : u))
        emit()
      }, { sectionId })
      if (!batch) return
      batch.files = batch.files.map((u, j) =>
        j === i ? { ...u, pct: 100, done: true, ok: r.ok, err: r.ok ? undefined : r.error } : u,
      )
      emit()
    }
    // All-good batches linger briefly as a receipt, then close themselves.
    // Failures stay until dismissed so they can't scroll by unseen.
    const finished = batch
    if (finished && finished.files.every((f) => f.ok)) {
      autoDismissTimer = setTimeout(() => {
        if (batch === finished) {
          batch = null
          emit()
        }
      }, 4000)
    }
    emit()
  })()
  return true
}

/** Drop a finished batch (and its tile). Refused mid-run. */
export function dismissUploads(): void {
  if (uploadsBusy()) return
  batch = null
  emit()
}
