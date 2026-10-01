// OCI Object Storage via the S3-compatible API (aws4fetch). All requests are
// signed per-call with the Customer Secret Key pair from the Worker env.
//
// Behaviors verified against the real endpoint (2026-10-01 probes):
//   - UNSIGNED-PAYLOAD bodies are accepted (bodies are never hashed — cheap
//     on the Workers free-plan CPU budget).
//   - Multipart CompleteMultipartUpload requires an `<?xml?>` declaration and
//     quoted ETags.
//   - If-Match is silently IGNORED (no server-side CAS) — optimistic
//     concurrency is ETag-compare in our own code (see fns.ts docPut).
//   - ListObjectsV2 needs encoding-type=url so odd filenames survive.
//   - PutBucketLifecycleConfiguration is NOT supported on the S3 endpoint.

import { AwsClient } from 'aws4fetch'
import { env } from 'cloudflare:workers'
import * as xml from './xml'
import { encodeKeyPath } from './mime'
import { DOC_KEY, FOLDER_MARKER, TRASH_PREFIX } from './keys'

export { DOC_KEY, FOLDER_MARKER, TRASH_PREFIX }

export interface HeadInfo {
  etag: string
  size: number
  contentType: string | null
  lastModified: string | null
}

export class S3Error extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message || code || `S3 ${status}`)
    this.name = 'S3Error'
    this.status = status
    this.code = code
  }
}

// ETags arrive quoted ("…"); everything downstream wants the bare hex.
export function bareEtag(etag: string | null | undefined): string {
  return (etag ?? '').replace(/^"|"$/g, '')
}

function client(): AwsClient {
  return new AwsClient({
    accessKeyId: env.OCI_S3_ACCESS_KEY_ID,
    secretAccessKey: env.OCI_S3_SECRET_ACCESS_KEY,
    service: 's3',
    region: env.OCI_S3_REGION,
    retries: 2,
  })
}

function base(): string {
  return env.OCI_S3_ENDPOINT.replace(/\/+$/, '') + '/' + env.OCI_S3_BUCKET
}

function objectUrl(key: string, query?: string): string {
  let url = `${base()}/${encodeKeyPath(key)}`
  if (query) url += '?' + query
  return url
}

interface ReqOpts {
  query?: string
  headers?: Record<string, string>
  body?: string | ArrayBuffer | null
  /** Return the raw Response even on non-2xx (for streaming/Range). */
  raw?: boolean
}

async function request(method: string, key: string, opts: ReqOpts = {}): Promise<Response> {
  const headers: Record<string, string> = { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', ...(opts.headers ?? {}) }
  let res: Response
  try {
    res = await client().fetch(objectUrl(key, opts.query), { method, headers, body: opts.body ?? null })
  } catch (e) {
    throw new S3Error(0, 'NetworkError', e instanceof Error ? e.message : 'network error')
  }
  if (res.ok || opts.raw) return res
  const text = await res.text().catch(() => '')
  const parsed = xml.parseError(text)
  throw new S3Error(res.status, parsed.code, parsed.message)
}

// ---------------------------------------------------------------------------
// Object ops
// ---------------------------------------------------------------------------

export async function head(key: string): Promise<HeadInfo | null> {
  try {
    const res = await request('HEAD', key)
    return {
      etag: bareEtag(res.headers.get('etag')),
      size: Number(res.headers.get('content-length') ?? '0'),
      contentType: res.headers.get('content-type'),
      lastModified: res.headers.get('last-modified'),
    }
  } catch (e) {
    if (e instanceof S3Error && e.status === 404) return null
    throw e
  }
}

/** Raw GET — caller streams (Range passthrough included). Never throws for
 *  HTTP status; inspect res.status yourself. */
export async function getRaw(key: string, range?: string | null): Promise<Response> {
  return request('GET', key, { headers: range ? { Range: range } : undefined, raw: true })
}

export async function getText(key: string): Promise<string> {
  const res = await request('GET', key)
  return res.text()
}

export interface PutMeta {
  etag: string
}
export async function put(
  key: string,
  body: string | ArrayBuffer | null,
  opts: { contentType?: string; meta?: Record<string, string> } = {},
): Promise<PutMeta> {
  const headers: Record<string, string> = {}
  if (opts.contentType) headers['Content-Type'] = opts.contentType
  for (const [k, v] of Object.entries(opts.meta ?? {})) headers[`x-amz-meta-${k}`] = v
  const res = await request('PUT', key, { headers, body })
  return { etag: bareEtag(res.headers.get('etag')) }
}

export async function del(key: string): Promise<void> {
  await request('DELETE', key)
}

/** Server-side copy. `metaDirective` REPLACE + fresh meta rewrites metadata
 *  on a same-key copy (rename); defaults to COPY (snapshots/copies). */
export async function copy(
  srcKey: string,
  dstKey: string,
  opts: { contentType?: string; meta?: Record<string, string> } = {},
): Promise<PutMeta> {
  const headers: Record<string, string> = {
    'x-amz-copy-source': `${env.OCI_S3_BUCKET}/${encodeKeyPath(srcKey)}`,
  }
  if (opts.contentType || opts.meta) {
    headers['x-amz-metadata-directive'] = 'REPLACE'
    if (opts.contentType) headers['Content-Type'] = opts.contentType
    for (const [k, v] of Object.entries(opts.meta ?? {})) headers[`x-amz-meta-${k}`] = v
  }
  const res = await request('PUT', dstKey, { headers, body: null })
  return { etag: bareEtag(xml.parseCopyEtag(await res.text())) }
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export interface ListPage {
  contents: xml.ListEntry[]
  commonPrefixes: string[]
  isTruncated: boolean
  nextToken: string | null
}

export async function list(opts: {
  prefix?: string
  delimiter?: boolean
  maxKeys?: number
  token?: string | null
}): Promise<ListPage> {
  const params = new URLSearchParams({ 'list-type': '2', 'encoding-type': 'url' })
  if (opts.prefix) params.set('prefix', opts.prefix)
  if (opts.delimiter) params.set('delimiter', '/')
  if (opts.maxKeys) params.set('max-keys', String(opts.maxKeys))
  if (opts.token) params.set('continuation-token', opts.token)
  const res = await request('GET', '', { query: params.toString().replace(/\+/g, '%20') })
  return xml.parseListV2(await res.text())
}

// ---------------------------------------------------------------------------
// Multipart
// ---------------------------------------------------------------------------

export async function createMpu(key: string, contentType: string): Promise<string> {
  const res = await request('POST', key, {
    query: 'uploads',
    headers: { 'Content-Type': contentType },
    body: null,
  })
  return xml.parseUploadId(await res.text())
}

export async function uploadPart(
  key: string,
  uploadId: string,
  partNumber: number,
  body: ArrayBuffer,
): Promise<string> {
  const res = await request('PUT', key, {
    query: `partNumber=${partNumber}&uploadId=${encodeURIComponent(uploadId)}`,
    body,
  })
  return bareEtag(res.headers.get('etag'))
}

export async function listParts(key: string, uploadId: string): Promise<xml.PartEntry[]> {
  const res = await request('GET', key, { query: `uploadId=${encodeURIComponent(uploadId)}` })
  return xml.parseParts(await res.text())
}

export async function completeMpu(
  key: string,
  uploadId: string,
  parts: { partNumber: number; etag: string }[],
): Promise<PutMeta> {
  // OCI needs the XML declaration AND quoted etags (probed 2026-10-01).
  const body =
    '<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload>' +
    parts.map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>&quot;${p.etag}&quot;</ETag></Part>`).join('') +
    '</CompleteMultipartUpload>'
  const res = await request('POST', key, {
    query: `uploadId=${encodeURIComponent(uploadId)}`,
    headers: { 'Content-Type': 'application/xml' },
    body,
  })
  return { etag: bareEtag(xml.parseCompleteEtag(await res.text())) }
}

export async function abortMpu(key: string, uploadId: string): Promise<void> {
  await request('DELETE', key, { query: `uploadId=${encodeURIComponent(uploadId)}` })
}

export async function listUploads(prefix?: string): Promise<{ key: string; uploadId: string }[]> {
  const params = new URLSearchParams('uploads')
  if (prefix) params.set('prefix', prefix)
  const res = await request('GET', '', { query: params.toString() })
  const text = await res.text()
  const out: { key: string; uploadId: string }[] = []
  for (const m of text.matchAll(/<Upload>([\s\S]*?)<\/Upload>/g)) {
    const key = xml.tagValue(m[1], 'Key')
    const id = xml.tagValue(m[1], 'UploadId')
    if (key && id) out.push({ key, uploadId: id })
  }
  return out
}

export async function bucketExists(): Promise<boolean> {
  try {
    await request('HEAD', '')
    return true
  } catch (e) {
    if (e instanceof S3Error && e.status === 404) return false
    throw e
  }
}
