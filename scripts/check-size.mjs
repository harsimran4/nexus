// Worker size gate — the free plan's 3MB gzip limit is a HARD deploy failure,
// and the bundle only ever grows. Fails the build when the gzipped server
// bundle crosses 2.5MB (headroom below the 3MB wall).
//   node scripts/check-size.mjs

import fs from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

const LIMIT = 2.5 * 1024 * 1024
const DIR = 'dist/server'

if (!fs.existsSync(DIR)) {
  console.error('check-size: dist/server missing — run the build first')
  process.exit(1)
}

let total = 0
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else {
      total += gzipSync(fs.readFileSync(p)).length
    }
  }
}
walk(DIR)

const mb = (n) => (n / 1024 / 1024).toFixed(2)
console.log(`worker size: ${mb(total)} MB gzip (limit ${mb(LIMIT)} MB)`)
if (total > LIMIT) {
  console.error('check-size: FAILED — the worker bundle is over budget')
  process.exit(1)
}
