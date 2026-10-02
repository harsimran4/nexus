// Content preview/download helpers. Everything is a same-origin /files/<key>
// fetch — viewers and editors share one path.

import { downloadFile, downloadFileProgress, DriveError } from './client'

/** Trigger a browser download of a stored file. */
export async function downloadToBrowser(fileId: string, filename: string): Promise<void> {
  const blob = await downloadFile(fileId)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Same, but reports transfer progress as a 0–100 percent (null when the
 *  response carries no Content-Length to compute against). */
export async function downloadToBrowserProgress(
  fileId: string,
  filename: string,
  onProgress: (pct: number | null) => void,
): Promise<void> {
  const blob = await downloadFileProgress(fileId, (received, total) =>
    onProgress(total ? Math.min(100, Math.round((received / total) * 100)) : null),
  )
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function describeError(e: unknown): { code: string; message: string; fix: string } {
  if (e instanceof DriveError) {
    switch (e.kind) {
      case 'notFound':
        return {
          code: 'notFound',
          message: 'File not found in storage',
          fix: 'The file may have been deleted, or your login can\'t see it. Editors: sign in again from the login page.',
        }
      case 'auth':
        return { code: 'auth', message: 'Sign-in required', fix: 'Your session expired — sign in again.' }
      case 'rateLimit':
        return { code: 'rateLimit', message: 'Storage is busy', fix: 'Wait a moment and retry — it recovers automatically.' }
      case 'permission':
        return {
          code: 'permission',
          message: 'Access denied',
          fix: 'Your session may lack access to this content — sign in again.',
        }
      case 'network':
        return { code: 'network', message: 'Network error', fix: 'Check your connection and retry.' }
      default:
        return { code: 'api', message: e.message, fix: 'Retry; if it persists, check the browser console.' }
    }
  }
  return { code: 'unknown', message: e instanceof Error ? e.message : String(e), fix: 'Retry; if it persists, check the browser console.' }
}
