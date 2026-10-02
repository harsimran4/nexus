// Startup + continuous probes. Every storage-side failure gets a named,
// actionable banner — the app never breaks silently. Probes are cheap (one
// public meta read) and run on the same path viewers use, so a broken public
// route surfaces immediately.

import { getMeta, DriveError } from '../drive/client'
import { DOC_KEY } from '../server/keys'
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
      message: 'Opened as a local file — the app needs its server for storage access',
      fix: 'Open Nexus from its hosted URL, or run it via `npm run dev` for development.',
    }
  }
  return null
}

/** Probe the public read path with the workspace doc's key — the exact path
 *  anonymous visitors and viewers depend on. */
export async function probePublicRead(nexusId: string): Promise<HealthIssue | null> {
  try {
    await getMeta(nexusId)
    return null
  } catch (e) {
    if (e instanceof DriveError) {
      if (e.kind === 'notFound')
        return {
          level: 'error',
          code: 'workspaceMissing',
          message: 'Workspace file not found in storage',
          fix: 'The bucket has no master/nexus.json — run /init (or the migration script) to create it.',
        }
      if (e.kind === 'rateLimit')
        return { level: 'warn', code: 'quota', message: 'Storage is throttling requests for now', fix: 'Waits automatically; try again in a minute.' }
    }
    return { level: 'warn', code: 'publicReadUnknown', message: 'Public read path unreachable', fix: 'Viewers cannot read until it works; editors can still work via their Nexus login.' }
  }
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

  const doc = storeGet().doc
  if (doc?.ids.nexusFileId) {
    const readIssue = await probePublicRead(doc.ids.nexusFileId)
    if (readIssue) issues.push(readIssue)
    else if (opts.deep) {
      // Deep probe transfers the doc body — boot + the Admin button only,
      // never the 30s loop.
      try {
        await getMeta(DOC_KEY)
      } catch (e) {
        const issue = e instanceof DriveError ? { kind: e.kind as string } : { kind: 'unknown' }
        issues.push({
          level: 'warn',
          code: 'docRead',
          message: 'Workspace doc read failed (' + issue.kind + ')',
          fix: 'Retry from Admin → Diagnostics; if it persists, check the Worker logs.',
        })
      }
    }
  }
  for (const issue of [docSizeIssue()]) if (issue) issues.push(issue)
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
