// Startup + continuous probes. Every Google-side failure gets a named,
// actionable banner — the app never breaks silently. Probes are cheap
// (files.get = 5 quota units) and run on the key path so a broken key
// surfaces immediately.

import { config } from '../config'
import { getMeta, readFile, DriveError, hasBearer, type Credential } from '../drive/client'
import { storeGet, type SyncStatus } from '../sync/store'

export interface HealthIssue {
  level: 'error' | 'warn' | 'info'
  code: string
  message: string
  fix: string
}

export function originCheck(): HealthIssue | null {
  if (location.protocol === 'file:') {
    return {
      level: 'error',
      code: 'origin',
      message: 'Opened as a local file — Google sign-in cannot work from file://',
      fix: 'Open Nexus from its hosted URL (GitHub Pages), or serve it via http://localhost:5173 for development.',
    }
  }
  return null
}

export function missingConfigIssue(): HealthIssue | null {
  const missing = config.clientId && config.apiKey ? [] : ['credentials']
  if (missing.length === 0) return null
  return {
    level: 'error',
    code: 'config',
    message: 'Build config incomplete (client id / API key)',
    fix: 'Copy .env.example to .env.local, fill both values, rebuild. See README "Google Cloud setup".',
  }
}

/** Probe the anonymous key path with the effective key (override wins over baked). */
export async function probeKeyPath(nexusId: string, apiKey: string): Promise<HealthIssue | null> {
  const cred: Credential = { mode: 'key', apiKey }
  try {
    await getMeta(nexusId, cred)
    return null
  } catch (e) {
    if (e instanceof DriveError) {
      if (e.kind === 'notFound')
        return {
          level: 'error',
          code: 'notShared',
          message: 'Workspace not link-shared (or wrong file id)',
          fix: 'In Drive: Nexus Root → Share → "Anyone with the link — Viewer". Then re-run the health check.',
        }
      if (e.kind === 'permission')
        return {
          level: 'error',
          code: 'keyRejected',
          message: 'API key rejected',
          fix: 'Check the key still exists, is restricted to the Drive API, and its HTTP-referrer list includes this site. Admin can paste a fresh key in Admin → Settings (no redeploy needed).',
        }
      if (e.kind === 'rateLimit')
        return { level: 'warn', code: 'quota', message: 'Drive quota exhausted for now', fix: 'Waits automatically; quota resets each minute.' }
    }
    return { level: 'warn', code: 'keyUnknown', message: 'Key path unreachable', fix: 'Viewers cannot read until the key works; editors can still work via their Nexus login.' }
  }
}

/** Detect the "Viewers can't download" toggle — it silently 403s alt=media for viewers. */
export async function probeDownloadRestriction(nexusId: string, apiKey: string): Promise<HealthIssue | null> {
  try {
    await readFile(nexusId, { mode: 'key', apiKey })
    return null
  } catch (e) {
    if (e instanceof DriveError && e.kind === 'downloadRestricted') {
      return {
        level: 'error',
        code: 'downloadRestricted',
        message: 'Drive "Viewers can\'t download" is ON — viewers cannot read content',
        fix: 'In Drive: Nexus Root → Share → turn OFF "Viewers can\'t download" (it silently blocks the app\'s viewer reads).',
      }
    }
    return null // key-path probe already reported its own issue
  }
}

export function consentIssue(): HealthIssue | null {
  if (!hasBearer()) return null
  return null // tokenClient owns expiry; writer surfaces 'reconnect' on 401
}

export function docSizeIssue(): HealthIssue | null {
  const doc = storeGet().doc
  if (!doc) return null
  const bytes = JSON.stringify(doc).length
  const max = doc.settings.sync.maxDocBytes
  if (bytes > max)
    return {
      level: 'warn',
      code: 'docSize',
      message: `Workspace metadata is ${(bytes / 1e6).toFixed(1)} MB — above the ${(max / 1e6).toFixed(1)} MB comfort zone`,
      fix: 'Archive finished projects and prune the activity log (Admin → Maintenance). Large files slow every sync.',
    }
  if (bytes > max / 4)
    return {
      level: 'info',
      code: 'docSizeGrowing',
      message: `Workspace metadata at ${(bytes / 1e3).toFixed(0)} KB and growing`,
      fix: 'Fine for now; archive finished projects to keep syncs fast.',
    }
  return null
}

export async function runHealthChecks(opts: { deep?: boolean } = {}): Promise<HealthIssue[]> {
  const issues: HealthIssue[] = []
  const origin = originCheck()
  if (origin) return [origin]
  const cfg = missingConfigIssue()
  if (cfg) return [cfg]

  const doc = storeGet().doc
  if (doc?.ids.nexusFileId) {
    const key = doc.settings.api.keyOverride ?? config.apiKey
    const keyIssue = await probeKeyPath(doc.ids.nexusFileId, key)
    if (keyIssue) issues.push(keyIssue)
    else if (opts.deep) {
      // Deep probe transfers the file body (detects the "Viewers can't
      // download" toggle) — boot + the Admin button only, never the 30s loop.
      const dl = await probeDownloadRestriction(doc.ids.nexusFileId, key)
      if (dl) issues.push(dl)
    }
  }
  for (const issue of [consentIssue(), docSizeIssue()]) if (issue) issues.push(issue)
  return issues
}

export function statusToIssue(status: SyncStatus, detail: string | null): HealthIssue | null {
  switch (status) {
    case 'reconnect':
      return {
        level: 'error',
        code: 'reconnect',
        message: detail ?? 'Session expired',
        fix: 'Click the Reconnect pill to sign in again — your queued changes are kept.',
      }
    case 'queued':
      return { level: 'warn', code: 'queued', message: detail ?? 'Changes waiting to sync', fix: 'Automatic retry; use Retry now in the top bar to force it.' }
    case 'readOnly':
      return { level: 'warn', code: 'readOnly', message: detail ?? 'Read-only mode', fix: 'Update the deployed app to the latest version.' }
    case 'blocked':
      return { level: 'error', code: 'blocked', message: detail ?? 'Writes blocked', fix: 'Follow the recovery steps shown.' }
    case 'corrupt':
      return {
        level: 'error',
        code: 'corrupt',
        message: detail ?? 'Workspace file unreadable',
        fix: 'The bad copy was quarantined. Use Admin → Maintenance → Restore from snapshot.',
      }
    default:
      return null
  }
}
