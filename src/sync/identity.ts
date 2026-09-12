// Writer identity: appUserId | deviceId | tabId — per-person, per-device,
// per-tab attribution for LWW tie-breaks and the activity log. Own module so
// bootstrap/session/writer can share it without an import cycle.

import { newDeviceId, getTabId } from '../util/id'

export const sessionRef: { getSession: (() => { appUserId: string } | null) | null } = { getSession: null }

export function writerId(): string {
  const session = sessionRef.getSession?.()
  return `${session?.appUserId ?? 'anonymous'}|${newDeviceId()}|${getTabId()}`
}

export function sessionActor(): string {
  return sessionRef.getSession?.()?.appUserId ?? 'anonymous'
}
