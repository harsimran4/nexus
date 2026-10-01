// Shared storage types — used by BOTH the server functions (src/server/*)
// and the client data layer (src/drive/client.ts). FileMeta keeps the exact
// shape the old Google Drive client produced, so the UI and sync layers
// didn't change when storage moved to OCI S3.

export type DriveErrorKind =
  | 'network'
  | 'auth'
  | 'notFound'
  | 'rateLimit'
  | 'conflict'
  | 'permission'
  | 'api'

export interface FileMeta {
  id: string // S3 object key, or a folder prefix ending in '/'
  name: string
  headRevisionId?: string // bare ETag
  md5Checksum?: string // ETag when it's a plain MD5 (single-PUT objects)
  version?: string // bare ETag
  modifiedTime?: string
  mimeType?: string
  trashed?: boolean
  createdTime?: string
  size?: string | number
}

export interface ListResult {
  files: FileMeta[]
  nextPageToken?: string
}

/** Server functions never throw across the RPC boundary — they return a
 *  typed result the client maps onto DriveError kinds. */
export type FnResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: DriveErrorKind; message: string }

export const SYSTEM_PREFIXES = {
  master: 'master/',
  snapshots: 'snapshots/',
  groups: 'groups/',
  scripts: 'scripts/',
} as const
