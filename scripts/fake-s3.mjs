// Minimal S3-compatible server for local/CI e2e — implements exactly the
// operations Nexus's worker (src/server/s3.ts) and the browser's presigned
// part-PUTs use, over the real HTTP contract, so the app's actual
// presign/multipart/parse code runs against something real. NOT a mock of
// the app: it's a stand-in for the bucket.
//
//   node scripts/fake-s3.mjs [port] [rootDir]
//
// Endpoints (bucket is path segment 1):
//   HEAD /b/key              → etag (md5 hex), Content-Length, Last-Modified
//   GET  /b/key              → body (supports Range: bytes=a-b)
//   GET  /b/key?uploadId=…   → ListParts XML
//   GET  /b?list-type=2…     → ListObjectsV2 XML (encoding-type=url respected)
//   GET  /b?uploads[&prefix] → ListMultipartUploads XML
//   PUT  /b/key              → store (etag header); with partNumber+uploadId → part
//                               with x-amz-copy-source → server-side copy
//   POST /b/key?uploads      → InitiateMultipartUpload XML
//   POST /b/key?uploadId=…   → CompleteMultipartUpload XML (quoted etag!)
//   DELETE /b/key?uploadId=… → abort MPU / delete object
// Authorization is accepted and ignored — signatures are out of scope here
// (MinIO can substitute for a stricter mode via OCI_S3_ENDPOINT).
//
// ListObjectsV2 specifics the app relies on: keys URL-encoded (the worker
// sets encoding-type=url and DEcodes with its own safe decoder), ETags
// QUOTED, folder markers are just zero-byte keys.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.argv[2] ?? process.env.FAKE_S3_PORT ?? 9399)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', process.argv[3] ?? '.e2e-bucket')
const BUCKET = process.env.FAKE_S3_BUCKET ?? 'nexus'

fs.mkdirSync(ROOT, { recursive: true })

const md5 = (buf) => createHash('md5').update(buf).digest('hex')
const objPath = (key) => path.join(ROOT, key)
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, PUT, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
}

const mpus = new Map() // uploadId → { key, parts: Map<partNumber, Buffer> }
let mpuSeq = 0

function send(res, status, body, headers = {}) {
  const buf = body === null || body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(body)
  res.writeHead(status, {
    ...CORS,
    ...(buf !== null ? { 'Content-Length': String(buf.length) } : {}),
    ...headers,
  })
  res.end(buf ?? undefined)
}

function sendXml(res, status, xmlBody, headers = {}) {
  send(res, status, xmlBody ? `<?xml version="1.0" encoding="UTF-8"?>\n${xmlBody}` : '', {
    'Content-Type': 'application/xml',
    ...headers,
  })
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function listKeys() {
  const keys = []
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(p, r)
      else keys.push({ key: r, size: e.size, mtime: e.mtime.toISOString(), etag: md5(fs.readFileSync(p)) })
    }
  }
  walk(ROOT, '')
  return keys.sort((a, b) => (a.key < b.key ? -1 : 1))
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
    if (req.method === 'OPTIONS') return send(res, 204, null)

    const rawPath = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    const slash = rawPath.indexOf('/')
    const bucket = slash === -1 ? rawPath : rawPath.slice(0, slash)
    const key = slash === -1 ? '' : rawPath.slice(slash + 1)
    if (bucket !== BUCKET) return sendXml(res, 404, `<Error><Code>NoSuchBucket</Code></Error>`)

    const q = url.searchParams
    const file = key ? objPath(key) : null

    // ---- multipart init -------------------------------------------------
    if (req.method === 'POST' && q.has('uploads')) {
      const id = `mpu-${++mpuSeq}-${Date.now().toString(36)}`
      mpus.set(id, { key, parts: new Map() })
      return sendXml(res, 200, `<InitiateMultipartUploadResult><Bucket>${BUCKET}</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`)
    }

    // ---- multipart complete ---------------------------------------------
    if (req.method === 'POST' && q.has('uploadId')) {
      const id = q.get('uploadId')
      const mpu = mpus.get(id)
      if (!mpu || mpu.key !== key) return sendXml(res, 404, `<Error><Code>NoSuchUpload</Code></Error>`)
      await readBody(req)
      const numbers = [...mpu.parts.keys()].sort((a, b) => a - b)
      const buf = Buffer.concat(numbers.map((n) => mpu.parts.get(n)))
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, buf)
      mpus.delete(id)
      return sendXml(res, 200, `<CompleteMultipartUploadResult><Location>/${BUCKET}/${key}</Location><Bucket>${BUCKET}</Bucket><Key>${key}</Key><ETag>&quot;${md5(buf)}&quot;</ETag></CompleteMultipartUploadResult>`)
    }

    // ---- list parts -------------------------------------------------------
    if (req.method === 'GET' && q.has('uploadId')) {
      const id = q.get('uploadId')
      const mpu = mpus.get(id)
      if (!mpu || mpu.key !== key) return sendXml(res, 404, `<Error><Code>NoSuchUpload</Code></Error>`)
      const parts = [...mpu.parts.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([n, buf]) => `<Part><PartNumber>${n}</PartNumber><ETag>&quot;${md5(buf)}&quot;</ETag><Size>${buf.length}</Size></Part>`)
        .join('')
      return sendXml(res, 200, `<ListPartsResult><Bucket>${BUCKET}</Bucket><Key>${key}</Key><IsTruncated>false</IsTruncated>${parts}</ListPartsResult>`)
    }

    // ---- list multipart uploads -------------------------------------------
    if (req.method === 'GET' && q.has('uploads')) {
      const prefix = q.get('prefix') ?? ''
      const rows = [...mpus.entries()]
        .filter(([, m]) => m.key.startsWith(prefix))
        .map(([id, m]) => `<Upload><Key>${m.key}</Key><UploadId>${id}</UploadId></Upload>`)
        .join('')
      return sendXml(res, 200, `<ListMultipartUploadsResult><Bucket>${BUCKET}</Bucket><IsTruncated>false</IsTruncated>${rows}</ListMultipartUploadsResult>`)
    }

    // ---- ListObjectsV2 ------------------------------------------------------
    if (req.method === 'GET' && (q.has('list-type') || key === '')) {
      const prefix = q.get('prefix') ?? ''
      const delim = q.has('delimiter')
      const marker = q.get('continuation-token') ?? q.get('marker') ?? ''
      let keys = listKeys().filter((k) => k.key.startsWith(prefix) && k.key > marker)
      const truncated = keys.length > 1000
      keys = keys.slice(0, 1000)
      const contents = keys
        .map((k) => `<Contents><Key>${encodeURIComponent(k.key)}</Key><LastModified>${k.mtime}</LastModified><ETag>&quot;${k.etag}&quot;</ETag><Size>${k.size}</Size><StorageClass>STANDARD</StorageClass></Contents>`)
        .join('')
      let prefixes = ''
      if (delim) {
        const seen = new Set()
        for (const k of listKeys().filter((k) => k.key.startsWith(prefix) && k.key > marker)) {
          const rest = k.key.slice(prefix.length)
          const d = rest.indexOf('/')
          if (d !== -1) {
            const p = prefix + rest.slice(0, d + 1)
            if (!seen.has(p)) {
              seen.add(p)
              prefixes += `<CommonPrefixes><Prefix>${encodeURIComponent(p)}</Prefix></CommonPrefixes>`
            }
          }
        }
      }
      return sendXml(res, 200, `<ListBucketResult><Name>${BUCKET}</Name><Prefix>${prefix}</Prefix><KeyCount>${keys.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>tok-${keys[keys.length - 1].key}</NextContinuationToken>` : ''}${contents}${prefixes}</ListBucketResult>`)
    }

    // ---- HEAD ---------------------------------------------------------------
    if (req.method === 'HEAD') {
      if (!fs.existsSync(file)) return send(res, 404, null)
      const buf = fs.readFileSync(file)
      return send(res, 200, null, { ETag: `"${md5(buf)}"`, 'Content-Length': String(buf.length), 'Last-Modified': fs.statSync(file).mtime.toUTCString() })
    }

    // ---- GET (with simple Range) ---------------------------------------------
    if (req.method === 'GET') {
      if (!fs.existsSync(file)) return sendXml(res, 404, `<Error><Code>NoSuchKey</Code></Error>`)
      const buf = fs.readFileSync(file)
      const range = req.headers.range
      if (range) {
        const m = range.match(/bytes=(\d*)-(\d*)/)
        const start = m?.[1] ? Number(m[1]) : 0
        const end = m?.[2] ? Number(m[2]) : buf.length - 1
        const slice = buf.subarray(start, end + 1)
        return send(res, 206, slice, { 'Content-Range': `bytes ${start}-${end}/${buf.length}`, ETag: `"${md5(buf)}"` })
      }
      return send(res, 200, buf, { ETag: `"${md5(buf)}"`, 'Last-Modified': fs.statSync(file).mtime.toUTCString() })
    }

    // ---- PUT (object / part / copy) --------------------------------------------
    if (req.method === 'PUT') {
      const body = await readBody(req)
      const copySource = req.headers['x-amz-copy-source']
      if (copySource) {
        const src = decodeURIComponent(String(copySource)).replace(/^\/+/, '').split('/').slice(1).join('/')
        const srcBuf = fs.readFileSync(objPath(src))
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, srcBuf)
        return sendXml(res, 200, `<CopyObjectResult><ETag>&quot;${md5(srcBuf)}&quot;</ETag><LastModified>${new Date().toISOString()}</LastModified></CopyObjectResult>`)
      }
      if (q.has('uploadId')) {
        const id = q.get('uploadId')
        const mpu = mpus.get(id)
        if (!mpu || mpu.key !== key) return sendXml(res, 404, `<Error><Code>NoSuchUpload</Code></Error>`)
        mpu.parts.set(Number(q.get('partNumber')), body)
        return send(res, 200, null, { ETag: `"${md5(body)}"` })
      }
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, body)
      return send(res, 200, null, { ETag: `"${md5(body)}"` })
    }

    // ---- DELETE (object / abort MPU) -------------------------------------------
    if (req.method === 'DELETE') {
      if (q.has('uploadId')) {
        mpus.delete(q.get('uploadId'))
        return send(res, 204, null)
      }
      try {
        fs.rmSync(file, { force: true })
      } catch {
        /* absent is fine */
      }
      return send(res, 204, null)
    }

    return sendXml(res, 405, `<Error><Code>MethodNotAllowed</Code></Error>`)
  } catch (e) {
    return sendXml(res, 500, `<Error><Code>InternalError</Code><Message>${e?.message ?? 'unknown'}</Message></Error>`)
  }
})

server.listen(PORT, () => console.log(`fake-s3: bucket "${BUCKET}" on http://127.0.0.1:${PORT} (root: ${ROOT})`))
