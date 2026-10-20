// P4 shadow-stage importer: master/nexus.json → D1.
//
//   npx wrangler d1 execute nexus --local --file migrations/0001-schema.sql -y   (once)
//   node scripts/import-doc-to-d1.mjs master/nexus.json
//
// The doc comes from a local JSON file (download via Admin → Maintenance →
// "Download nexus.json backup"). Row/SQL generation is SHARED with the
// Worker's mirror — this script imports src/server/d1/tables.ts directly
// (Node ≥22 strips types natively), so importer and mirror cannot drift.
//
// Every run is a full reconcile: child-first WIPE, then INSERT OR REPLACE of
// the whole doc — re-running after drift repairs D1 (the route's diff is the
// checker). D1 access rides `wrangler d1 execute` in statement batches —
// dependency-free, only needed once per mirror cycle.
// Add D1_REMOTE=1 to target the deployed database (after `wrangler d1 create`).

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import { docToOps, importActivityOps, renderSql, wipeOps } from '../src/server/d1/tables.ts'

const DOC_FILE = process.argv[2] ?? 'master/nexus.json'
const DB = process.env.D1_DB ?? 'nexus'
const REMOTE = process.env.D1_REMOTE === '1' ? '--remote' : '--local'
const CHUNK = 40 // statements per wrangler execute call

if (!fs.existsSync(DOC_FILE)) {
  console.error(`importer: ${DOC_FILE} not found — download the doc first (Admin → Maintenance)`)
  process.exit(1)
}

const doc = JSON.parse(fs.readFileSync(DOC_FILE, 'utf8'))
const ops = [...wipeOps(), ...docToOps(doc), ...(await importActivityOps(doc))]

let done = 0
for (let i = 0; i < ops.length; i += CHUNK) {
  const sql = ops.slice(i, i + CHUNK).map(renderSql).join(';\n')
  fs.writeFileSync('.d1-batch.sql', sql)
  execSync(`npx wrangler d1 execute ${DB} ${REMOTE} --file .d1-batch.sql -y`, { stdio: i === 0 ? 'inherit' : 'ignore' })
  done += Math.min(CHUNK, ops.length - i)
  console.log(`importer: ${done}/${ops.length} statements`)
}
fs.rmSync('.d1-batch.sql', { force: true })
console.log(`importer: done — ${ops.length} statements into ${DB} (${REMOTE}). Now check: the app's GET /api/debug/d1?op=diff (or run it locally)`)
