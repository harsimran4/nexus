// Content preview/download helpers. Key-first (works for viewers and doubles
// as a continuous key-path probe), bearer fallback (editors keep working when
// the key is broken).

import { downloadFile, DriveError, hasBearer, type Credential } from './client'

/** Trigger a browser download of a Drive file (respects key/bearer path). */
export async function downloadToBrowser(fileId: string, filename: string, cred?: Credential): Promise<void> {
  const effective: Credential = cred ?? { mode: hasBearer() ? 'auto' : 'key' }
  const blob = await downloadFile(fileId, effective)
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
      case 'downloadRestricted':
        return {
          code: 'downloadRestricted',
          message: 'Drive blocked this download',
          fix: 'The folder has "Viewers can\'t download" enabled — anyone with share access can turn it off in Drive (Sharing settings).',
        }
      case 'notFound':
        return {
          code: 'notFound',
          message: 'File not visible to your account',
          fix: 'The file may not be link-shared, or your login can\'t see it. Editors: sign in again from the login page.',
        }
      case 'auth':
        return { code: 'auth', message: 'Sign-in required', fix: 'Your session expired — sign in again. (Viewers: ask an admin to check the API key.)' }
      case 'rateLimit':
        return { code: 'rateLimit', message: 'Drive is busy', fix: 'Wait a moment and retry — quota recovers automatically.' }
      case 'permission':
        return {
          code: 'permission',
          message: 'Access denied by Drive',
          fix: 'Check the folder is shared "Anyone with the link — Viewer" and the API key restrictions allow this site.',
        }
      case 'network':
        return { code: 'network', message: 'Network error', fix: 'Check your connection and retry.' }
      default:
        return { code: 'api', message: e.message, fix: 'Retry; if it persists, check the browser console.' }
    }
  }
  return { code: 'unknown', message: e instanceof Error ? e.message : String(e), fix: 'Retry; if it persists, check the browser console.' }
}
