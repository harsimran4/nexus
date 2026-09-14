// Google Picker connect — the editor path to write access without sharing the
// studio Google password. The studio shares the Nexus Root folder with the
// editor's Google address (Editor); the editor picks that folder once in the
// picker, and Google grants THIS app per-file access to it for that account.
// The grant persists per (user, app) until the user deauthorizes the app, so
// later sessions read/write the same file ids with no picker.

import { config, missingConfig } from '../config'
import { findWorkspace } from '../drive/bootstrap'
import { readFile } from '../drive/client'
import { storeGet } from '../sync/store'
import { getBearerToken, requestToken } from './tokenClient'

const GAPI_SRC = 'https://apis.google.com/js/api.js'

declare global {
  // eslint-disable-next-line no-var
  var gapi: {
    load: (
      api: string,
      cfg: (() => void) | { callback: () => void; onerror?: () => void; ontimeout?: () => void; timeout?: number },
    ) => void
  }
}

export type ConnectResult = 'connected' | 'wrongFolder' | 'noGrant' | 'cancelled'

// The picker script defines google.picker; the global `google` declaration in
// tokenClient covers accounts only, so view the picker side through a cast.
type PickerResponse = { action: string; docs?: { id: string }[] }
interface PickerBuilder {
  setAppId: (id: string) => PickerBuilder
  setOAuthToken: (token: string) => PickerBuilder
  addView: (view: unknown) => PickerBuilder
  setTitle: (title: string) => PickerBuilder
  setCallback: (cb: (resp: PickerResponse) => void) => PickerBuilder
  build: () => { setVisible: (visible: boolean) => void }
}
interface PickerDocsView {
  setSelectFolderEnabled: (on: boolean) => PickerDocsView
}
interface PickerNamespace {
  ViewId: { FOLDERS: string }
  DocsView: new (viewId?: string) => PickerDocsView
  PickerBuilder: new () => PickerBuilder
}
function pickerNs(): PickerNamespace | null {
  const g = (typeof google === 'undefined' ? {} : google) as unknown as { picker?: PickerNamespace }
  return g.picker ?? null
}

let pickerPromise: Promise<void> | null = null
function loadPicker(): Promise<void> {
  if (pickerPromise) return pickerPromise
  pickerPromise = (async () => {
    if (pickerNs()) return
    // The picker loads through the GApi loader — two steps: the loader script
    // defines `gapi`, then gapi.load('picker') fills in the google.picker
    // namespace. (The old docs.google.com/picker.js shortcut is gone — 404.)
    if (typeof gapi === 'undefined') {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement('script')
        script.src = GAPI_SRC
        script.async = true
        script.onload = () => resolve()
        script.onerror = () => {
          pickerPromise = null // allow a retry on the next click
          reject(new Error('Failed to load the Google API loader (offline, a blocker, or an office firewall?)'))
        }
        document.head.appendChild(script)
      })
    }
    await new Promise<void>((resolve, reject) => {
      gapi.load('picker', {
        callback: () => resolve(),
        onerror: () => {
          pickerPromise = null
          reject(new Error('Failed to load Google Picker'))
        },
        ontimeout: () => {
          pickerPromise = null
          reject(new Error('Loading Google Picker timed out — check the network and retry'))
        },
        timeout: 15_000,
      })
    })
  })()
  return pickerPromise
}

/** Pre-warm the picker at boot so the first Connect click doesn't wait on the
 *  network — silent best-effort, exactly like warmupAuth for GIS. */
export function warmupPicker(): Promise<void> {
  return loadPicker().then(
    () => undefined,
    () => undefined,
  )
}

/** Open the folder picker with the current token. Resolves the picked folder
 *  id, or null on cancel/close. */
function openFolderPicker(token: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const p = pickerNs()
    if (!p) {
      reject(new Error('Google Picker not loaded'))
      return
    }
    let settled = false
    const done = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
    }
    try {
      new p.PickerBuilder()
        .setAppId(config.clientId.split('-')[0]) // picker wants the numeric app id
        .setOAuthToken(token)
        .addView(new p.DocsView(p.ViewId.FOLDERS).setSelectFolderEnabled(true))
        .setTitle('Pick the Nexus Root folder shared with you')
        .setCallback((resp) => {
          if (resp.action === 'picked' && resp.docs?.[0]?.id) done(() => resolve(resp.docs![0].id))
          else if (resp.action === 'cancel') done(() => resolve(null))
          // 'loaded' and others: ignore
        })
        .build()
        .setVisible(true)
    } catch (e) {
      done(() => reject(e instanceof Error ? e : new Error('Picker failed to open')))
    }
  })
}

/**
 * The whole connect flow, to be called from a button click (the gesture lets
 * requestToken open the account chooser). The editor signs in with their OWN
 * Google account, picks the shared Nexus Root folder, and the flow verifies
 * the picked folder really holds THIS workspace's nexus.json before trusting
 * it — a wrong pick can never redirect writes at a stranger's folder.
 */
export async function connectWorkspace(expectedNexusFileId: string): Promise<ConnectResult> {
  if (!expectedNexusFileId) throw new Error('Workspace file id unknown — re-run setup first')
  if (missingConfig().length) throw new Error('Build config incomplete — rebuild with VITE_NEXUS_CLIENT_ID set')
  await requestToken()
  const token = getBearerToken()
  if (!token) return 'cancelled'
  await loadPicker()
  const folderId = await openFolderPicker(token)
  if (!folderId) return 'cancelled'

  // STEP 1 — is the picked folder even this workspace? The folder is
  // link-shared view-only to the whole world, so the public API key answers
  // this WITHOUT any picker grant. This keeps "picked the wrong folder"
  // cleanly separable from "grant hasn't kicked in yet".
  const apiKey = storeGet().doc?.settings.api.keyOverride || config.apiKey
  const ws = await findWorkspace(folderId, { mode: 'key', apiKey }).catch(() => null)
  if (!ws || ws.nexusFileId !== expectedNexusFileId) return 'wrongFolder'

  // STEP 2 — prove the picker grant actually reaches the account's token.
  // The drive.file grant covers the picked folder and its children but can
  // lag a few seconds behind the pick, so retry briefly. Prove it with a
  // DIRECT read of nexus.json by id — no children-listing involved.
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = await readFile(expectedNexusFileId, { mode: 'bearer' }).catch(() => null)
    if (raw !== null) return 'connected'
    await new Promise((r) => setTimeout(r, 1500))
  }
  return 'noGrant'
}
