// Core read implementations shared by server functions (fns.ts) and the
// public server routes (viewer/anonymous reads). Server-only — always
// dynamically imported.

import type { FileMeta, ListResult } from '../types/storage'
import { FOLDER_MARKER, TRASH_PREFIX } from './keys'

async function mimeHelpers() {
  return import('./mime')
}

function folderMeta(prefix: string): FileMeta {
  const base = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
  return {
    id: prefix,
    name: base.split('/').pop() ?? prefix,
    mimeType: 'application/vnd.google-apps.folder',
  }
}

function isMarker(key: string, size: number): boolean {
  return size === 0 && key.endsWith('/' + FOLDER_MARKER)
}

export async function metaCore(key: string): Promise<FileMeta> {
  const s3 = await import('./s3')
  if (key.endsWith('/')) {
    const h = await s3.head(key + FOLDER_MARKER)
    if (!h) throw Object.assign(new Error('Folder not found'), { status: 404 })
    return folderMeta(key)
  }
  const h = await s3.head(key)
  if (!h) throw Object.assign(new Error('File not found'), { status: 404 })
  const { mimeFromKey, nameFromKey } = await mimeHelpers()
  const etag = h.etag
  return {
    id: key,
    name: nameFromKey(key),
    mimeType: mimeFromKey(key),
    size: h.size,
    modifiedTime: h.lastModified ?? undefined,
    createdTime: h.lastModified ?? undefined,
    headRevisionId: etag,
    version: etag,
    md5Checksum: /^[0-9a-f]{32}$/.test(etag) ? etag : undefined,
  }
}

export async function listCore(parent: string, pageSize: number, pageToken?: string): Promise<ListResult> {
  const s3 = await import('./s3')
  const { nameFromKey, mimeFromKey } = await mimeHelpers()
  const page = await s3.list({
    prefix: parent || undefined,
    delimiter: true,
    maxKeys: pageSize,
    token: pageToken ?? null,
  })
  const files: FileMeta[] = []
  for (const prefix of page.commonPrefixes) {
    if (prefix === parent) continue
    if (prefix === TRASH_PREFIX) continue // deny quietly — don't reveal trash exists
    files.push(folderMeta(prefix))
  }
  for (const entry of page.contents) {
    if (isMarker(entry.key, entry.size)) continue
    files.push({
      id: entry.key,
      name: nameFromKey(entry.key),
      mimeType: mimeFromKey(entry.key),
      size: entry.size,
      modifiedTime: entry.lastModified || undefined,
      createdTime: entry.lastModified || undefined,
      headRevisionId: entry.etag,
      version: entry.etag,
      md5Checksum: /^[0-9a-f]{32}$/.test(entry.etag) ? entry.etag : undefined,
    })
  }
  return { files, nextPageToken: page.nextToken ?? undefined }
}
