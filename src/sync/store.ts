// Central zustand store: the doc, the sync status machine, and the session.
// Status machine: booting → ok | needsInit | corrupt | blocked
//   ok → saving → ok          (normal write cycle)
//   ok → queued               (rate-limited / offline; auto-recovers)
//   ok → reconnect            (token dead; user must click)
//   ok → readOnly             (remote schema newer than this app)
//   any → corrupt             (remote unparseable; quarantine + restore)

import { create } from 'zustand'
import type { NexusDoc } from '../types/schema'

export type SyncStatus =
  | 'booting'
  | 'ok'
  | 'saving'
  | 'queued'
  | 'reconnect'
  | 'readOnly'
  | 'blocked'
  | 'needsInit'
  | 'corrupt'

export interface BaseTokens {
  headRevisionId?: string
  md5Checksum?: string
  version?: string
}

export interface SessionInfo {
  appUserId: string
  name: string
  role: 'admin' | 'editor' | 'viewer'
}

interface NexusState {
  doc: NexusDoc | null
  base: BaseTokens
  status: SyncStatus
  statusDetail: string | null
  bootError: string | null
  pendingCount: number
  lastSyncAt: string | null
  lastReadViaKey: boolean
  activeProjectId: string | null
  session: SessionInfo | null

  setDoc: (doc: NexusDoc) => void
  setBase: (t: BaseTokens) => void
  setStatus: (s: SyncStatus, detail?: string | null) => void
  setBootError: (msg: string | null) => void
  setPending: (n: number) => void
  markSynced: () => void
  setLastReadViaKey: (v: boolean) => void
  setActiveProject: (id: string | null) => void
}

export const useStore = create<NexusState>((set) => ({
  doc: null,
  base: {},
  status: 'booting',
  statusDetail: null,
  bootError: null,
  pendingCount: 0,
  lastSyncAt: null,
  lastReadViaKey: false,
  activeProjectId: null,
  session: null,

  setDoc: (doc) => set({ doc }),
  setBase: (t) => set({ base: t }),
  setStatus: (status, statusDetail = null) => set({ status, statusDetail }),
  setBootError: (bootError) => set({ bootError }),
  setPending: (pendingCount) => set({ pendingCount }),
  markSynced: () => set({ lastSyncAt: new Date().toISOString() }),
  setLastReadViaKey: (lastReadViaKey) => set({ lastReadViaKey }),
  setActiveProject: (activeProjectId) => set({ activeProjectId }),
}))

/** Non-hook accessor for modules outside React (sync kernel, health). */
export const storeGet = () => useStore.getState()
