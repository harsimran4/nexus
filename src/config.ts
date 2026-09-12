// Build-time constants. Everything here is PUBLIC by design — it ships inside
// the shared HTML file. Each credential must be restricted in Google Cloud
// Console (see .env.example). The ONLY place these exist.

export const config = {
  clientId: import.meta.env.VITE_NEXUS_CLIENT_ID ?? '',
  apiKey: import.meta.env.VITE_NEXUS_API_KEY ?? '',
  rootFolderId: import.meta.env.VITE_NEXUS_ROOT_FOLDER_ID ?? '',
  nexusFileId: import.meta.env.VITE_NEXUS_FILE_ID ?? '',
  appVersion: '0.1.0',
  maxKnownSchema: 1,
  scopes: ['https://www.googleapis.com/auth/drive.file'],
} as const

export const missingConfig = (): string[] => {
  const missing: string[] = []
  if (!config.clientId) missing.push('VITE_NEXUS_CLIENT_ID')
  if (!config.apiKey) missing.push('VITE_NEXUS_API_KEY')
  return missing
}
