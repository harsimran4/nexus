// Prefixed, time-ordered ids (uuid v7 shaped): readable + sortable.

const HEX = '0123456789abcdef'

function randomHex(n: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(n / 2)))
  let out = ''
  for (let i = 0; i < n; i++) out += HEX[(bytes[i >> 1] >> (i % 2 === 0 ? 4 : 0)) & 0xf]
  return out
}

/** Time-sortable unique id: <prefix>_<unix-ms hex>_<random>. */
export function uid(prefix: string): string {
  const ms = Date.now()
  return `${prefix}_${ms.toString(16)}${randomHex(10)}`
}

export const newProjectId = () => uid('prj')
export const newGroupId = () => uid('grp')
export const newScriptId = () => uid('scr')
export const newUserId = () => uid('usr')
export const newViewerId = () => uid('vw')

export function newDeviceId(): string {
  const existing = localStorage.getItem('nexus.deviceId')
  if (existing) return existing
  const id = uid('d')
  localStorage.setItem('nexus.deviceId', id)
  return id
}

/** Tab-unique suffix so two tabs of the same user are two writers. */
let tabId: string | null = null
export function getTabId(): string {
  if (!tabId) tabId = uid('t')
  return tabId
}
