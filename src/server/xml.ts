// Minimal S3 XML extraction. workerd has no DOMParser, and the shapes we
// need are flat and regular, so regex/substring extraction is enough.
// Lists are requested with encoding-type=url, so keys/prefixes come back
// percent-encoded and are decoded here.

function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))
  return m ? m[1] : null
}

/** First `<Name>…</Name>` text value in an XML fragment. */
export function tagValue(xml: string, name: string): string | null {
  return tag(xml, name)
}

function decodeSafe(v: string): string {
  // OCI's ListObjectsV2 (encoding-type=url) FORM-encodes spaces as '+'; a
  // literal '+' arrives as %2B. Undo the form-encoding first, then percent-
  // decode — otherwise every space-named key comes back mangled.
  try {
    return decodeURIComponent(v.replace(/\+/g, '%20'))
  } catch {
    return v
  }
}

/** XML etag values arrive quoted (<ETag>"hex"</ETag>) — strip here so every
 *  consumer sees the bare hex exactly like response-header etags do. */
function bareEtag(v: string): string {
  return v.replace(/^"|"$/g, '')
}

export interface ListEntry {
  key: string
  lastModified: string
  etag: string
  size: number
}

export interface ListResult {
  contents: ListEntry[]
  commonPrefixes: string[]
  isTruncated: boolean
  nextToken: string | null
}

/** ListObjectsV2 response — caller must have used encoding-type=url. */
export function parseListV2(xml: string): ListResult {
  const contents: ListEntry[] = []
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = m[1]
    const key = tag(block, 'Key')
    if (!key) continue
    contents.push({
      key: decodeSafe(key),
      lastModified: tag(block, 'LastModified') ?? '',
      etag: bareEtag(tag(block, 'ETag') ?? ''),
      size: Number(tag(block, 'Size') ?? '0'),
    })
  }
  const commonPrefixes: string[] = []
  for (const m of xml.matchAll(/<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g)) {
    const p = tag(m[1], 'Prefix')
    if (p) commonPrefixes.push(decodeSafe(p))
  }
  return {
    contents,
    commonPrefixes,
    isTruncated: tag(xml, 'IsTruncated') === 'true',
    nextToken: tag(xml, 'NextContinuationToken'),
  }
}

/** S3 error body — {code, message}; empty when the body isn't XML. */
export function parseError(xml: string): { code: string; message: string } {
  return {
    code: tag(xml, 'Code') ?? '',
    message: tag(xml, 'Message') ?? '',
  }
}

/** InitiateMultipartUploadResult → UploadId. */
export function parseUploadId(xml: string): string {
  return tag(xml, 'UploadId') ?? ''
}

/** CopyObjectResult → the new object's ETag. */
export function parseCopyEtag(xml: string): string {
  return bareEtag(tag(xml, 'ETag') ?? '')
}

/** CompleteMultipartUploadResult → the finished object's ETag. */
export function parseCompleteEtag(xml: string): string {
  return bareEtag(tag(xml, 'ETag') ?? '')
}

export interface PartEntry {
  partNumber: number
  etag: string
  size: number
}

/** ListParts response → uploaded parts (ascending part number). */
export function parseParts(xml: string): PartEntry[] {
  const parts: PartEntry[] = []
  for (const m of xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)) {
    const block = m[1]
    const n = tag(block, 'PartNumber')
    if (!n) continue
    parts.push({
      partNumber: Number(n),
      etag: bareEtag(tag(block, 'ETag') ?? ''),
      size: Number(tag(block, 'Size') ?? '0'),
    })
  }
  return parts.sort((a, b) => a.partNumber - b.partNumber)
}
