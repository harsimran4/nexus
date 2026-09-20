// Build-time constants. Everything here is PUBLIC by design — it ships inside
// the shared HTML file. The Google OAuth client id is now only used once,
// during the one-time #/init bootstrap (see Init.tsx) — keep it around for
// that, but no editor/viewer flow touches it anymore.

export const config = {
  clientId: import.meta.env.VITE_NEXUS_CLIENT_ID ?? '', // init-only now
  apiKey: import.meta.env.VITE_NEXUS_API_KEY ?? '', // viewer reads only
  workerUrl: import.meta.env.VITE_NEXUS_WORKER_URL ?? '',
  rootFolderId: import.meta.env.VITE_NEXUS_ROOT_FOLDER_ID ?? '',
  nexusFileId: import.meta.env.VITE_NEXUS_FILE_ID ?? '',
  appVersion: __APP_VERSION__,
  maxKnownSchema: 1,
  scopes: ['https://www.googleapis.com/auth/drive.file'],
} as const

export const missingConfig = (): string[] => {
  const missing: string[] = []
  if (!config.apiKey) missing.push('VITE_NEXUS_API_KEY')
  if (!config.workerUrl) missing.push('VITE_NEXUS_WORKER_URL')
  return missing
}
