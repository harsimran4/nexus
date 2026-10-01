// Universal storage constants — importable from BOTH client and server code
// (no server-only imports here; s3.ts re-exports them for its own callers).

/** The workspace document — the bucket root IS the workspace root. */
export const DOC_KEY = 'master/nexus.json'
/** Zero-byte object ending a folder prefix, marking it as existing. */
export const FOLDER_MARKER = '__folder__'
/** Copy-then-delete target for deletes; OCI console lifecycle expires it
 *  (the S3 API cannot set lifecycle rules on OCI). */
export const TRASH_PREFIX = 'trash/'
