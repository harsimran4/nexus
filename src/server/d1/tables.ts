// The doc↔D1 mapping — THE single source of truth for P4 stage 1 (shadow).
//
// Everything that turns the workspace doc into D1 rows or D1 rows back into
// the doc lives here, pure and dependency-free (only `import type`): the
// Worker mirror (mirror.ts), the /api/debug/d1 route, AND the CLI importer
// (scripts/import-doc-to-d1.mjs, which imports this file directly — Node ≥22
// strips types natively) all share it, so they cannot drift apart.
//
// Shapes (light, not zod): callers pass either parseDoc() output or a plain
// JSON.parse of the stored doc — identical post-parse, because every writer
// re-serializes through parseDoc before the bytes land in the bucket.
//
// Conventions:
//   - Ops are {sql, args} statements. `put` ops are INSERT OR REPLACE
//     (idempotent — a retried import or mirror converges). Full-column puts:
//     a row always mirrors its entity completely, never partially patched.
//   - OP ORDER IS LOAD-BEARING: D1 enforces foreign keys and runs a batch as
//     one transaction, so deletes are emitted child-first and inserts
//     parent-first (mirrorOps returns [deletes…, inserts…]; wipeOps is
//     reverse-dependency order; docToOps is dependency order).
//   - Soft deletes carry BOTH halves: deleted_at + deleted_by (the doc's
//     `deleted: {at, by}` must round-trip exactly).
//   - Unknown entity fields land in `extra` JSON and are merged back on
//     regen — never silently dropped. (parseDoc strips unknowns today, so
//     extra stays '{}' — this is the guard for the day it doesn't.)
//   - Activity rows carry `h` (canonical-JSON sha256): the ring is
//     append+trim and restores move it backwards, so only content identifies
//     an event. Diff compares activity as a SET of hashes, order-insensitive
//     — concurrent writers can interleave appends; `at` is the UI sort key.
//   - Regen maps rows to doc fields EXPLICITLY (no row spreads) — a renamed
//     column must fail the diff check, not smuggle SQL names into the doc.

export type SqlArg = string | number | null
export type SqlOp = { sql: string; args: SqlArg[] }

// ---------------------------------------------------------------------------
// Light doc shapes (structural — the zod NexusDoc satisfies these)
// ---------------------------------------------------------------------------

export type LightDeleted = { at: string; by: string } | null

export type LightGroup = {
  id: string
  name: string
  description?: string
  folderId?: string | null
  color?: string
  createdAt?: string
  updatedAt?: string
  writerId?: string
  deleted?: LightDeleted
  archivedAt?: string | null
  [k: string]: unknown
}
export type LightProject = {
  id: string
  groupId: string
  name: string
  folderId?: string | null
  status?: string
  labels?: string[]
  fileIds?: string[]
  mediaSections?: { id: string; name: string }[]
  mediaSectionOf?: Record<string, string>
  assigneeAppId?: string | null
  dueAt?: string | null
  notes?: string
  approved?: { at: string; by: string } | null
  createdAt?: string
  updatedAt?: string
  writerId?: string
  deleted?: LightDeleted
  archivedAt?: string | null
  [k: string]: unknown
}
export type LightScript = {
  id: string
  title: string
  storage?: unknown
  projectId?: string | null
  status?: string
  copies?: { fileId: string; label: string; at: string }[]
  createdAt?: string
  updatedAt?: string
  writerId?: string
  deleted?: LightDeleted
  archivedAt?: string | null
  [k: string]: unknown
}
export type LightAppUser = {
  id: string
  name: string
  role: string
  disabled?: boolean
  auth: unknown
  createdAt: string
  createdBy?: string
  sessionEpoch?: number
  updatedAt?: string
  writerId?: string
  [k: string]: unknown
}
export type LightViewer = {
  id: string
  name: string
  tokenHash: string
  createdAt: string
  createdBy?: string
  revokedAt?: string | null
  note?: string
  scope?: string
  updatedAt?: string
  writerId?: string
  [k: string]: unknown
}
export type LightUploadLink = {
  id: string
  tokenHash: string
  projectId: string
  sectionId: string
  maxFileBytes: number
  note?: string
  createdAt: string
  createdBy?: string
  expiresAt: string
  revokedAt?: string | null
  updatedAt?: string
  writerId?: string
  [k: string]: unknown
}
export type LightRef = {
  id: string
  projectId?: string | null
  url: string
  title?: string
  note?: string
  createdAt: string
  updatedAt?: string
  writerId?: string
  deleted?: LightDeleted
  [k: string]: unknown
}
export type LightComment = {
  id: string
  projectId: string
  body: string
  by: string
  createdAt: string
  updatedAt?: string
  writerId?: string
  deleted?: LightDeleted
  [k: string]: unknown
}
export type LightActivity = { at: string; actor: string; verb: string; ref: string; meta?: unknown }
export type LightTombstone = { type: string; id: string; at: string; by: string }
export type LightSnapshot = { fileId: string; rev: number; at: string; by: string; note?: string }

export type LightDoc = {
  schema: number
  rev: number
  writerId?: string
  updatedAt?: string
  ids?: unknown
  users?: { app?: LightAppUser[]; studioSub?: string | null; viewers?: LightViewer[] }
  settings?: unknown
  uploadLinks?: LightUploadLink[]
  refs?: LightRef[]
  comments?: LightComment[]
  groups?: Record<string, LightGroup>
  projects?: Record<string, LightProject>
  scripts?: Record<string, LightScript>
  tombstones?: LightTombstone[]
  activity?: LightActivity[]
  snapshots?: LightSnapshot[]
  [k: string]: unknown
}

// ---------------------------------------------------------------------------
// Canonical JSON + activity identity
// ---------------------------------------------------------------------------

/** JSON.stringify with recursively sorted object keys — the stable form that
 *  makes deep-equality a string compare and feeds the activity hash. Drops
 *  undefined-valued keys, exactly like JSON.stringify does. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']'
  const obj = v as Record<string, unknown>
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}'
}

/** sha256 hex of an activity event's canonical form — its row identity. */
export async function activityHash(a: LightActivity): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(a)))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const sameJson = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b)

// ---------------------------------------------------------------------------
// SQL op builders
// ---------------------------------------------------------------------------

type Row = Record<string, SqlArg>

function put(table: string, row: Row): SqlOp {
  const cols = Object.keys(row)
  return {
    sql: `INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    args: cols.map((c) => row[c] ?? null),
  }
}

function delAll(table: string): SqlOp {
  return { sql: `DELETE FROM ${table}`, args: [] }
}

/** Render an op as literal SQL text (CLI importer → `wrangler d1 execute
 *  --file`). Positional `?` replacement — values may safely contain '?'. */
export function renderSql(op: SqlOp): string {
  const parts = op.sql.split('?')
  let out = parts[0]
  for (let i = 0; i < op.args.length; i++) {
    const a = op.args[i]
    const lit = typeof a === 'number' ? String(a) : a === null ? 'NULL' : `'${String(a).replace(/'/g, "''")}'`
    out += lit + parts[i + 1]
  }
  return out + parts.slice(op.args.length + 1).join('?')
}

// ---------------------------------------------------------------------------
// Entity → row mappers (known-field lists define `extra`)
// ---------------------------------------------------------------------------

const GROUP_KNOWN = ['id', 'name', 'description', 'folderId', 'color', 'createdAt', 'updatedAt', 'writerId', 'deleted', 'archivedAt']
const PROJECT_KNOWN = [
  'id', 'groupId', 'name', 'folderId', 'status', 'labels', 'fileIds', 'mediaSections', 'mediaSectionOf',
  'assigneeAppId', 'dueAt', 'notes', 'approved', 'createdAt', 'updatedAt', 'writerId', 'deleted', 'archivedAt',
]
const SCRIPT_KNOWN = ['id', 'title', 'storage', 'projectId', 'status', 'copies', 'createdAt', 'updatedAt', 'writerId', 'deleted', 'archivedAt']
const USER_KNOWN = ['id', 'name', 'role', 'disabled', 'auth', 'createdAt', 'createdBy', 'sessionEpoch', 'updatedAt', 'writerId']
const VIEWER_KNOWN = ['id', 'name', 'tokenHash', 'createdAt', 'createdBy', 'revokedAt', 'note', 'scope', 'updatedAt', 'writerId']
const LINK_KNOWN = ['id', 'tokenHash', 'projectId', 'sectionId', 'maxFileBytes', 'note', 'createdAt', 'createdBy', 'expiresAt', 'revokedAt', 'updatedAt', 'writerId']
const REF_KNOWN = ['id', 'projectId', 'url', 'title', 'note', 'createdAt', 'updatedAt', 'writerId', 'deleted']
const COMMENT_KNOWN = ['id', 'projectId', 'body', 'by', 'createdAt', 'updatedAt', 'writerId', 'deleted']

/** Everything on the entity the columns don't cover → one JSON string. */
function extraOf(e: Record<string, unknown>, known: string[]): string {
  const rest: Record<string, unknown> = {}
  for (const k of Object.keys(e)) if (!known.includes(k) && e[k] !== undefined) rest[k] = e[k]
  return canonicalJson(rest)
}

function extraInto<T>(base: T, extraJson: SqlArg): T {
  if (typeof extraJson !== 'string' || extraJson === '' || extraJson === '{}') return base
  try {
    const parsed = JSON.parse(extraJson)
    if (parsed && typeof parsed === 'object') return { ...parsed, ...base }
  } catch {
    /* a corrupt extra never breaks regen — the diff check reports it */
  }
  return base
}

/** Shared entity stamps (groups/projects/scripts — the zod stampsSchema). */
function stampsOut(e: { createdAt?: string; updatedAt?: string; writerId?: string; deleted?: LightDeleted; archivedAt?: string | null }, now: string): Row {
  return {
    created_at: e.createdAt ?? now,
    updated_at: e.updatedAt ?? now,
    writer_id: e.writerId ?? 'unknown',
    deleted_at: e.deleted?.at ?? null,
    deleted_by: e.deleted?.by ?? null,
    archived_at: e.archivedAt ?? null,
  }
}

function groupRow(g: LightGroup, now: string): Row {
  return {
    id: g.id,
    name: g.name,
    description: g.description ?? '',
    color: g.color ?? '',
    folder_id: g.folderId ?? null,
    ...stampsOut(g, now),
    extra: extraOf(g, GROUP_KNOWN),
  }
}

function projectRow(p: LightProject, now: string): Row {
  return {
    id: p.id,
    group_id: p.groupId,
    name: p.name,
    status: p.status ?? 'pending',
    folder_id: p.folderId ?? null,
    labels: canonicalJson(p.labels ?? []),
    assignee_app_id: p.assigneeAppId ?? null,
    due_at: p.dueAt ?? null,
    notes: p.notes ?? '',
    approved_at: p.approved?.at ?? null,
    approved_by: p.approved?.by ?? null,
    ...stampsOut(p, now),
    extra: extraOf(p, PROJECT_KNOWN),
  }
}

function scriptRow(s: LightScript, now: string): Row {
  return {
    id: s.id,
    title: s.title,
    project_id: s.projectId ?? null,
    status: s.status ?? 'draft',
    storage: canonicalJson(s.storage ?? { type: 'md', fileId: '' }),
    ...stampsOut(s, now),
    extra: extraOf(s, SCRIPT_KNOWN),
  }
}

function userRow(u: LightAppUser, now: string): Row {
  return {
    id: u.id,
    name: u.name,
    role: u.role,
    disabled: u.disabled ? 1 : 0,
    auth: canonicalJson(u.auth),
    session_epoch: u.sessionEpoch ?? null,
    created_at: u.createdAt ?? now,
    created_by: u.createdBy ?? 'bootstrap',
    updated_at: u.updatedAt ?? null,
    writer_id: u.writerId ?? null,
    extra: extraOf(u, USER_KNOWN),
  }
}

function viewerRow(v: LightViewer, now: string): Row {
  return {
    id: v.id,
    name: v.name,
    token_hash: v.tokenHash,
    note: v.note ?? '',
    scope: v.scope ?? '',
    revoked_at: v.revokedAt ?? null,
    created_at: v.createdAt ?? now,
    created_by: v.createdBy ?? 'bootstrap',
    updated_at: v.updatedAt ?? null,
    writer_id: v.writerId ?? null,
    extra: extraOf(v, VIEWER_KNOWN),
  }
}

function linkRow(l: LightUploadLink, now: string): Row {
  return {
    id: l.id,
    token_hash: l.tokenHash,
    project_id: l.projectId,
    section_id: l.sectionId,
    max_file_bytes: l.maxFileBytes,
    note: l.note ?? '',
    created_at: l.createdAt ?? now,
    created_by: l.createdBy ?? '',
    expires_at: l.expiresAt ?? now,
    revoked_at: l.revokedAt ?? null,
    updated_at: l.updatedAt ?? null,
    writer_id: l.writerId ?? null,
    extra: extraOf(l, LINK_KNOWN),
  }
}

function refRow(r: LightRef, now: string): Row {
  return {
    id: r.id,
    project_id: r.projectId ?? null,
    url: r.url,
    title: r.title ?? '',
    note: r.note ?? '',
    created_at: r.createdAt ?? now,
    updated_at: r.updatedAt ?? null,
    writer_id: r.writerId ?? null,
    deleted_at: r.deleted?.at ?? null,
    deleted_by: r.deleted?.by ?? null,
    extra: extraOf(r, REF_KNOWN),
  }
}

function commentRow(c: LightComment, now: string): Row {
  return {
    id: c.id,
    project_id: c.projectId,
    body: c.body,
    by: c.by ?? 'anonymous',
    created_at: c.createdAt ?? now,
    updated_at: c.updatedAt ?? null,
    writer_id: c.writerId ?? null,
    deleted_at: c.deleted?.at ?? null,
    deleted_by: c.deleted?.by ?? null,
    extra: extraOf(c, COMMENT_KNOWN),
  }
}

function activityRow(a: LightActivity, h: string): Row {
  return { at: a.at, actor: a.actor, verb: a.verb, ref: a.ref, meta: canonicalJson(a.meta ?? {}), h }
}

// ---------------------------------------------------------------------------
// meta rows (doc-level fields with no table of their own)
// ---------------------------------------------------------------------------

const ACTIVITY_REGEN_CAP = 1500 // = ACTIVITY_LOCAL_BUFFER — the doc's own write-path cap

function metaPairs(doc: LightDoc, now: string): { key: string; value: string }[] {
  const pairs = [
    { key: 'schema', value: String(doc.schema ?? 1) },
    { key: 'rev', value: String(doc.rev ?? 0) },
    { key: 'settings', value: canonicalJson(doc.settings ?? {}) },
    { key: 'ids', value: canonicalJson(doc.ids ?? {}) },
    {
      key: 'docStamps',
      value: canonicalJson({ updatedAt: doc.updatedAt ?? now, writerId: doc.writerId ?? 'bootstrap' }),
    },
  ]
  if (doc.users?.studioSub != null) pairs.push({ key: 'studioSub', value: doc.users.studioSub })
  return pairs
}

// ---------------------------------------------------------------------------
// docToOps — full import (the CLI importer + the /api/debug/d1 import op)
// ---------------------------------------------------------------------------

export function docToOps(doc: LightDoc): SqlOp[] {
  const now = new Date().toISOString()
  const ops: SqlOp[] = metaPairs(doc, now).map((p) => put('meta', p))
  for (const g of Object.values(doc.groups ?? {})) ops.push(put('groups', groupRow(g, now)))
  for (const p of Object.values(doc.projects ?? {})) {
    ops.push(put('projects', projectRow(p, now)))
    ;(p.mediaSections ?? []).forEach((s, i) => {
      ops.push(put('media_sections', { project_id: p.id, id: s.id, name: s.name, sort: i }))
    })
    for (const key of p.fileIds ?? []) {
      ops.push(
        put('project_files', {
          project_id: p.id,
          file_key: key,
          section_id: p.mediaSectionOf?.[key] ?? null,
          added_at: p.updatedAt ?? now,
          added_by: p.writerId ?? 'import',
        }),
      )
    }
  }
  for (const s of Object.values(doc.scripts ?? {})) {
    ops.push(put('scripts', scriptRow(s, now)))
    for (const c of s.copies ?? []) {
      ops.push(put('script_copies', { script_id: s.id, file_id: c.fileId, label: c.label, at: c.at }))
    }
  }
  for (const u of doc.users?.app ?? []) ops.push(put('users_app', userRow(u, now)))
  for (const v of doc.users?.viewers ?? []) ops.push(put('viewers', viewerRow(v, now)))
  for (const l of doc.uploadLinks ?? []) ops.push(put('upload_links', linkRow(l, now)))
  for (const r of doc.refs ?? []) ops.push(put('refs', refRow(r, now)))
  for (const c of doc.comments ?? []) ops.push(put('comments', commentRow(c, now)))
  for (const t of doc.tombstones ?? []) ops.push(put('deletions', { type: t.type, id: t.id, at: t.at, by: t.by }))
  for (const m of doc.snapshots ?? []) {
    ops.push(put('snapshots', { file_id: m.fileId, rev: m.rev, at: m.at, by: m.by, note: m.note ?? '' }))
  }
  return ops // activity is NOT here — it's hash-deduped and async: importActivityOps
}

/** Activity for a full import — separate because the identity hash is async. */
export async function importActivityOps(doc: LightDoc): Promise<SqlOp[]> {
  const ops: SqlOp[] = []
  for (const a of doc.activity ?? []) ops.push(put('activity', activityRow(a, await activityHash(a))))
  return ops
}

export const ALL_TABLES = [
  'media_sections', 'project_files', 'script_copies', 'activity', 'deletions', 'snapshots',
  'upload_links', 'refs', 'comments', 'users_app', 'viewers', 'scripts', 'projects', 'groups', 'meta',
] as const

/** Child-first (FK-safe) full wipe — the import route clears before inserting. */
export function wipeOps(): SqlOp[] {
  return ALL_TABLES.map((t) => delAll(t))
}

// ---------------------------------------------------------------------------
// Table specs — the stage-2 wire-op validation registry (apply.ts gates every
// gateway op against these; nothing the client sends names a column or table
// the registry doesn't declare).
// ---------------------------------------------------------------------------

export type EntityTable = 'groups' | 'projects' | 'scripts' | 'users_app' | 'viewers' | 'upload_links' | 'refs' | 'comments'

export type TableSpec = {
  pk: string[]
  cols: string[]
  /** LWW-guarded tables compare `updated_at` (HLC) on conflict; child tables
   *  apply unconditionally (their parent row's stamp gates the transition). */
  lww: boolean
}

export const TABLE_SPECS: Record<EntityTable | 'media_sections' | 'project_files' | 'script_copies' | 'deletions' | 'snapshots', TableSpec> = {
  groups: {
    pk: ['id'],
    lww: true,
    cols: ['id', 'name', 'description', 'color', 'folder_id', 'created_at', 'updated_at', 'writer_id', 'deleted_at', 'deleted_by', 'archived_at', 'extra'],
  },
  projects: {
    pk: ['id'],
    lww: true,
    cols: ['id', 'group_id', 'name', 'status', 'folder_id', 'labels', 'assignee_app_id', 'due_at', 'notes', 'approved_at', 'approved_by', 'created_at', 'updated_at', 'writer_id', 'deleted_at', 'deleted_by', 'archived_at', 'extra'],
  },
  scripts: {
    pk: ['id'],
    lww: true,
    cols: ['id', 'title', 'project_id', 'status', 'storage', 'created_at', 'updated_at', 'writer_id', 'deleted_at', 'deleted_by', 'archived_at', 'extra'],
  },
  users_app: {
    pk: ['id'],
    lww: true,
    cols: ['id', 'name', 'role', 'disabled', 'auth', 'session_epoch', 'created_at', 'created_by', 'updated_at', 'writer_id', 'extra'],
  },
  viewers: {
    pk: ['id'],
    lww: true,
    cols: ['id', 'name', 'token_hash', 'note', 'scope', 'revoked_at', 'created_at', 'created_by', 'updated_at', 'writer_id', 'extra'],
  },
  upload_links: {
    pk: ['id'],
    lww: true,
    cols: ['id', 'token_hash', 'project_id', 'section_id', 'max_file_bytes', 'note', 'created_at', 'created_by', 'expires_at', 'revoked_at', 'updated_at', 'writer_id', 'extra'],
  },
  refs: {
    pk: ['id'],
    lww: true,
    cols: ['id', 'project_id', 'url', 'title', 'note', 'created_at', 'updated_at', 'writer_id', 'deleted_at', 'deleted_by', 'extra'],
  },
  comments: {
    pk: ['id'],
    lww: true,
    cols: ['id', 'project_id', 'body', 'by', 'created_at', 'updated_at', 'writer_id', 'deleted_at', 'deleted_by', 'extra'],
  },
  media_sections: { pk: ['project_id', 'id'], lww: false, cols: ['project_id', 'id', 'name', 'sort'] },
  project_files: { pk: ['project_id', 'file_key'], lww: false, cols: ['project_id', 'file_key', 'section_id', 'added_at', 'added_by'] },
  script_copies: { pk: ['script_id', 'file_id'], lww: false, cols: ['script_id', 'file_id', 'label', 'at'] },
  deletions: { pk: ['type', 'id'], lww: false, cols: ['type', 'id', 'at', 'by'] },
  snapshots: { pk: ['file_id'], lww: false, cols: ['file_id', 'rev', 'at', 'by', 'note'] },
}

/** meta keys the gateway may write. rev/schema/docStamps are server-authoritative. */
export const GATEWAY_META_KEYS = ['settings', 'ids', 'studioSub'] as const

export const GATEWAY_MAX_OPS = 500

// ---------------------------------------------------------------------------
// wireDiff — the ONE doc→transition diff. Emits the wire vocabulary shared by
// the stage-1 shadow mirror and the stage-2 client gateway (apply.compileOps
// turns wire ops into SQL — one compiler, no drift). `prev` null is a caller
// concern (full import lives in docToOps).
//
// ORDER IS LOAD-BEARING end-to-end: deletes are emitted child-first, puts
// parent-first, and compileOps preserves that order — the whole batch runs as
// one D1 transaction under FK constraints.
// ---------------------------------------------------------------------------

export type EntityTableName = keyof typeof TABLE_SPECS

export type WireOp =
  | { t: 'put'; table: EntityTableName; row: Row }
  | { t: 'del'; table: EntityTableName; pk: SqlArg[]; at?: string; strong?: boolean }
  | { t: 'meta'; key: string; value: string }
  | { t: 'meta-del'; key: string }
  | { t: 'activity'; events: LightActivity[] }
  | { t: 'activity-del'; hashes: string[] }
  | { t: 'tombstone'; tombstone: LightTombstone }

function idMap<T extends { id: string }>(list?: T[]): Record<string, T> {
  const out: Record<string, T> = {}
  for (const e of list ?? []) out[e.id] = e
  return out
}

const wPut = (table: EntityTableName, row: Row): WireOp => ({ t: 'put', table, row })
const wDel = (table: EntityTableName, pk: SqlArg[], strong = true): WireOp => ({ t: 'del', table, pk, strong })

/** `gateway: true` scopes the diff to what a CLIENT may send: rev/schema/
 *  docStamps are server-authoritative (bookkeepingOps owns them) and the
 *  poller's merge moves the local rev, so a gateway diff containing rev ops
 *  would be rejected forever. The mirror (doc = truth) diffs everything. */
export async function wireDiff(prev: LightDoc, next: LightDoc, now = new Date().toISOString(), opts: { gateway?: boolean } = {}): Promise<WireOp[]> {
  const dels: WireOp[] = []
  const puts: WireOp[] = []

  // --- meta: per-key canonical compare ---------------------------------
  const writable = opts.gateway ? new Set<string>(GATEWAY_META_KEYS as readonly string[]) : null
  const prevPairs = metaPairs(prev, now).filter((p) => !writable || writable.has(p.key))
  const nextPairs = metaPairs(next, now).filter((p) => !writable || writable.has(p.key))
  const prevMeta = new Map(prevPairs.map((p) => [p.key, p.value]))
  for (const p of nextPairs) {
    if (prevMeta.get(p.key) !== p.value) puts.push({ t: 'meta', key: p.key, value: p.value })
  }
  if (!opts.gateway && prev.users?.studioSub != null && next.users?.studioSub == null) dels.push({ t: 'meta-del', key: 'studioSub' })

  // --- record-shaped entities: per-id whole-entity canonical diff -------
  const prevGroups = prev.groups ?? {}
  const nextGroups = next.groups ?? {}
  const prevProjects = prev.projects ?? {}
  const nextProjects = next.projects ?? {}
  const prevScripts = prev.scripts ?? {}
  const nextScripts = next.scripts ?? {}

  // DELETED projects: clear children BEFORE the parent row (FK order) —
  for (const id of Object.keys(prevProjects).filter((id) => !nextProjects[id])) {
    dels.push(wDel('media_sections', [id]), wDel('project_files', [id]), wDel('comments', [id]), wDel('projects', [id]))
  }
  // DELETED scripts: copies first, same reason.
  for (const id of Object.keys(prevScripts).filter((id) => !nextScripts[id])) {
    dels.push(wDel('script_copies', [id]), wDel('scripts', [id]))
  }
  // DELETED groups: projects must go first IF they went too (handled above);
  // a group whose projects STILL exist can't be hard-deleted — SQLite aborts
  // the batch, the writer logs it loudly, the diff check surfaces it.
  for (const id of Object.keys(prevGroups).filter((id) => !nextGroups[id])) dels.push(wDel('groups', [id]))

  // CHANGED/NEW entities: whole-entity compare, full-row put. (Deletes were
  // handled above, child-aware; parents-before-children put order matters —
  // groups before projects before their children.)
  const recordDiff = <T>(before: Record<string, T>, after: Record<string, T>, rowOf: (e: T) => Row, table: EntityTableName): void => {
    for (const id of Object.keys(after)) {
      const b = before[id]
      const a = after[id]
      if (b !== undefined && sameJson(b, a)) continue
      puts.push(wPut(table, rowOf(a)))
    }
  }
  recordDiff(prevGroups, nextGroups, (g) => groupRow(g, now), 'groups')
  recordDiff(prevProjects, nextProjects, (p) => projectRow(p, now), 'projects')
  recordDiff(prevScripts, nextScripts, (s) => scriptRow(s, now), 'scripts')

  // project children for CHANGED projects — sections rewrite (tiny); files
  // diff by KEY (can be hundreds — never rewrite what didn't move).
  for (const id of Object.keys(nextProjects)) {
    const pb = prevProjects[id]
    const pa = nextProjects[id]
    if (!pb) continue // new project — recordDiff pushed the row; files pushed below
    if (sameJson(pb, pa)) continue // unchanged project — children can't have moved
    // media_sections: whole rewrite ONLY when they moved (sort column = array
    // index) — a rename or status flip must not churn child rows.
    if (!sameJson(pb.mediaSections ?? [], pa.mediaSections ?? [])) {
      dels.push(wDel('media_sections', [id]))
      ;(pa.mediaSections ?? []).forEach((s, i) => {
        puts.push(wPut('media_sections', { project_id: id, id: s.id, name: s.name, sort: i }))
      })
    }
    // files: set + section-map diff. NOTE these dels reference the project
    // row that still exists in this transition, so FK order is unaffected.
    const bKeys = pb.fileIds ?? []
    const aKeys = pa.fileIds ?? []
    const bSections = pb.mediaSectionOf ?? {}
    const aSections = pa.mediaSectionOf ?? {}
    const aKeySet = new Set(aKeys)
    for (const key of bKeys) if (!aKeySet.has(key)) dels.push(wDel('project_files', [id, key]))
    for (const key of aKeys) {
      const section = aSections[key] ?? null
      if (!bKeys.includes(key) || (bSections[key] ?? null) !== section) {
        puts.push(wPut('project_files', { project_id: id, file_key: key, section_id: section, added_at: pa.updatedAt ?? now, added_by: pa.writerId ?? 'mirror' }))
      }
    }
  }
  for (const id of Object.keys(nextScripts)) {
    const pb = prevScripts[id]
    const pa = nextScripts[id]
    if (!pb || sameJson(pb, pa)) continue
    if (sameJson(pb.copies ?? [], pa.copies ?? [])) continue // copies didn't move
    dels.push(wDel('script_copies', [id]))
    for (const c of pa.copies ?? []) {
      puts.push(wPut('script_copies', { script_id: id, file_id: c.fileId, label: c.label, at: c.at }))
    }
  }

  // NEW projects: their file rows (recordDiff covered the project row only).
  for (const id of Object.keys(nextProjects)) {
    if (prevProjects[id]) continue
    const pa = nextProjects[id]
    ;(pa.mediaSections ?? []).forEach((s, i) => {
      puts.push(wPut('media_sections', { project_id: id, id: s.id, name: s.name, sort: i }))
    })
    for (const key of pa.fileIds ?? []) {
      puts.push(wPut('project_files', { project_id: id, file_key: key, section_id: pa.mediaSectionOf?.[key] ?? null, added_at: pa.updatedAt ?? now, added_by: pa.writerId ?? 'mirror' }))
    }
  }

  // flat id-keyed collections.
  const flatDiff = <T extends { id: string }>(table: EntityTableName, before: Record<string, T>, after: Record<string, T>, rowOf: (e: T) => Row): void => {
    for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const b = before[id]
      const a = after[id]
      if (a === undefined) {
        dels.push(wDel(table, [id]))
        continue
      }
      if (b !== undefined && sameJson(b, a)) continue
      puts.push(wPut(table, rowOf(a)))
    }
  }
  flatDiff('users_app', idMap(prev.users?.app), idMap(next.users?.app), (u) => userRow(u, now))
  flatDiff('viewers', idMap(prev.users?.viewers), idMap(next.users?.viewers), (v) => viewerRow(v, now))
  flatDiff('upload_links', idMap(prev.uploadLinks), idMap(next.uploadLinks), (l) => linkRow(l, now))
  flatDiff('refs', idMap(prev.refs), idMap(next.refs), (r) => refRow(r, now))
  flatDiff('comments', idMap(prev.comments), idMap(next.comments), (c) => commentRow(c, now))

  // tombstones — keyed (type,id).
  const tombKey = (t: LightTombstone): string => `${t.type}\n${t.id}`
  const prevTomb = new Map((prev.tombstones ?? []).map((t) => [tombKey(t), t]))
  const nextTomb = new Map((next.tombstones ?? []).map((t) => [tombKey(t), t]))
  for (const [, t] of nextTomb) {
    const b = prevTomb.get(tombKey(t))
    if (!b || !sameJson(b, t)) puts.push({ t: 'tombstone', tombstone: t })
  }
  for (const [k, t] of prevTomb) if (!nextTomb.has(k)) dels.push(wDel('deletions', [t.type, t.id]))

  // snapshots — keyed fileId.
  const prevSnap = new Map((prev.snapshots ?? []).map((m) => [m.fileId, m]))
  const nextSnap = new Map((next.snapshots ?? []).map((m) => [m.fileId, m]))
  for (const [k, m] of nextSnap) {
    const b = prevSnap.get(k)
    if (!b || !sameJson(b, m)) puts.push(wPut('snapshots', { file_id: m.fileId, rev: m.rev, at: m.at, by: m.by, note: m.note ?? '' }))
  }
  for (const [k] of prevSnap) if (!nextSnap.has(k)) dels.push(wDel('snapshots', [k]))

  // activity — hash SET diff, order-insensitive (concurrent writers may
  // interleave appends; restores move the ring backwards; content is identity).
  const prevByHash = new Set<string>()
  for (const a of prev.activity ?? []) prevByHash.add(await activityHash(a))
  const nextSeen = new Set<string>()
  const newEvents: LightActivity[] = []
  for (const a of next.activity ?? []) {
    const h = await activityHash(a)
    nextSeen.add(h)
    if (!prevByHash.has(h)) newEvents.push(a)
  }
  if (newEvents.length) puts.push({ t: 'activity', events: newEvents })
  const removedHashes = [...prevByHash].filter((h) => !nextSeen.has(h))
  if (removedHashes.length) dels.push({ t: 'activity-del', hashes: removedHashes })

  return [...dels, ...puts]
}

// ---------------------------------------------------------------------------
// rowsToDoc — regenerate the doc from fetched rows (regen.ts does the reads).
// Field-by-field on purpose: a schema drift (renamed/missing column) yields a
// DIFF divergence, never a silently-restructured doc.
// ---------------------------------------------------------------------------

type RowMap = Record<string, SqlArg>

export type AllRows = {
  meta: RowMap[]
  groups: RowMap[]
  projects: RowMap[]
  media_sections: RowMap[]
  project_files: RowMap[]
  scripts: RowMap[]
  script_copies: RowMap[]
  users_app: RowMap[]
  viewers: RowMap[]
  upload_links: RowMap[]
  refs: RowMap[]
  comments: RowMap[]
  activity: RowMap[]
  deletions: RowMap[]
  snapshots: RowMap[]
}

function parseJson(v: SqlArg): unknown {
  if (typeof v !== 'string') return null
  try {
    return JSON.parse(v)
  } catch {
    return null
  }
}

const optStr = (v: SqlArg): string | undefined => (v != null ? String(v) : undefined)
const reqStr = (v: SqlArg, fallback = ''): string => (v != null ? String(v) : fallback)
const optNum = (v: SqlArg): number | undefined => (v != null ? Number(v) : undefined)

export function rowsToDoc(rows: AllRows): LightDoc {
  const meta: Record<string, string> = {}
  for (const r of rows.meta) meta[reqStr(r.key)] = reqStr(r.value)
  const now = new Date().toISOString()

  const stamps = meta.docStamps !== undefined ? (parseJson(meta.docStamps) as { updatedAt?: string; writerId?: string } | null) : null
  const doc: LightDoc = {
    schema: Number(meta.schema ?? 1),
    rev: Number(meta.rev ?? 0),
    writerId: stamps?.writerId ?? 'bootstrap',
    updatedAt: stamps?.updatedAt ?? now,
    ids: meta.ids !== undefined ? parseJson(meta.ids) : {},
    settings: meta.settings !== undefined ? parseJson(meta.settings) : {},
    users: {
      studioSub: meta.studioSub ?? null,
      app: [],
      viewers: [],
    },
    uploadLinks: [],
    refs: [],
    comments: [],
    groups: {},
    projects: {},
    scripts: {},
    tombstones: [],
    activity: [],
    snapshots: [],
  }

  // child collections, pre-indexed
  const sectionsByProject = new Map<string, { id: string; name: string; sort: number }[]>()
  for (const r of rows.media_sections) {
    const pid = reqStr(r.project_id)
    const list = sectionsByProject.get(pid) ?? []
    list.push({ id: reqStr(r.id), name: reqStr(r.name), sort: Number(r.sort ?? 0) })
    sectionsByProject.set(pid, list)
  }
  const filesByProject = new Map<string, { key: string; section: string | null; addedAt: string }[]>()
  for (const r of rows.project_files) {
    const pid = reqStr(r.project_id)
    const list = filesByProject.get(pid) ?? []
    list.push({ key: reqStr(r.file_key), section: r.section_id != null ? reqStr(r.section_id) : null, addedAt: reqStr(r.added_at, '') })
    filesByProject.set(pid, list)
  }
  const copiesByScript = new Map<string, { fileId: string; label: string; at: string }[]>()
  for (const r of rows.script_copies) {
    const sid = reqStr(r.script_id)
    const list = copiesByScript.get(sid) ?? []
    list.push({ fileId: reqStr(r.file_id), label: reqStr(r.label), at: reqStr(r.at) })
    copiesByScript.set(sid, list)
  }

  for (const r of rows.groups) {
    const id = reqStr(r.id)
    doc.groups![id] = extraInto(
      {
        id,
        name: reqStr(r.name),
        description: reqStr(r.description),
        color: reqStr(r.color),
        folderId: r.folder_id != null ? reqStr(r.folder_id) : null,
        createdAt: reqStr(r.created_at, now),
        updatedAt: reqStr(r.updated_at, now),
        writerId: reqStr(r.writer_id, 'unknown'),
        deleted: r.deleted_at != null ? { at: reqStr(r.deleted_at), by: reqStr(r.deleted_by) } : null,
        archivedAt: r.archived_at != null ? reqStr(r.archived_at) : null,
      },
      r.extra,
    )
  }

  for (const r of rows.projects) {
    const id = reqStr(r.id)
    const sections = (sectionsByProject.get(id) ?? []).sort((a, b) => a.sort - b.sort).map(({ id: sid, name }) => ({ id: sid, name }))
    const files = (filesByProject.get(id) ?? []).sort((a, b) => (a.addedAt < b.addedAt ? -1 : a.addedAt > b.addedAt ? 1 : a.key < b.key ? -1 : 1))
    const mediaSectionOf: Record<string, string> = {}
    for (const f of files) if (f.section) mediaSectionOf[f.key] = f.section
    doc.projects![id] = extraInto(
      {
        id,
        groupId: reqStr(r.group_id),
        name: reqStr(r.name),
        status: reqStr(r.status, 'pending'),
        folderId: r.folder_id != null ? reqStr(r.folder_id) : null,
        labels: (parseJson(r.labels) as string[] | null) ?? [],
        fileIds: files.map((f) => f.key),
        mediaSections: sections,
        mediaSectionOf,
        assigneeAppId: r.assignee_app_id != null ? reqStr(r.assignee_app_id) : null,
        dueAt: r.due_at != null ? reqStr(r.due_at) : null,
        notes: reqStr(r.notes),
        approved: r.approved_at != null ? { at: reqStr(r.approved_at), by: reqStr(r.approved_by) } : null,
        createdAt: reqStr(r.created_at, now),
        updatedAt: reqStr(r.updated_at, now),
        writerId: reqStr(r.writer_id, 'unknown'),
        deleted: r.deleted_at != null ? { at: reqStr(r.deleted_at), by: reqStr(r.deleted_by) } : null,
        archivedAt: r.archived_at != null ? reqStr(r.archived_at) : null,
      },
      r.extra,
    )
  }

  for (const r of rows.scripts) {
    const id = reqStr(r.id)
    doc.scripts![id] = extraInto(
      {
        id,
        title: reqStr(r.title),
        projectId: r.project_id != null ? reqStr(r.project_id) : null,
        status: reqStr(r.status, 'draft'),
        storage: parseJson(r.storage) ?? { type: 'md', fileId: '' },
        copies: (copiesByScript.get(id) ?? []).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)),
        createdAt: reqStr(r.created_at, now),
        updatedAt: reqStr(r.updated_at, now),
        writerId: reqStr(r.writer_id, 'unknown'),
        deleted: r.deleted_at != null ? { at: reqStr(r.deleted_at), by: reqStr(r.deleted_by) } : null,
        archivedAt: r.archived_at != null ? reqStr(r.archived_at) : null,
      },
      r.extra,
    )
  }

  doc.users!.app = rows.users_app
    .sort((a, b) => (reqStr(a.created_at) < reqStr(b.created_at) ? -1 : reqStr(a.created_at) > reqStr(b.created_at) ? 1 : reqStr(a.id) < reqStr(b.id) ? -1 : 1))
    .map((r) =>
      extraInto(
        {
          id: reqStr(r.id),
          name: reqStr(r.name),
          role: reqStr(r.role),
          disabled: Number(r.disabled ?? 0) !== 0,
          auth: parseJson(r.auth),
          sessionEpoch: optNum(r.session_epoch),
          createdAt: reqStr(r.created_at, now),
          createdBy: reqStr(r.created_by, 'bootstrap'),
          updatedAt: optStr(r.updated_at),
          writerId: optStr(r.writer_id),
        },
        r.extra,
      ),
    )

  doc.users!.viewers = rows.viewers
    .sort((a, b) => (reqStr(a.created_at) < reqStr(b.created_at) ? -1 : reqStr(a.created_at) > reqStr(b.created_at) ? 1 : reqStr(a.id) < reqStr(b.id) ? -1 : 1))
    .map((r) =>
      extraInto(
        {
          id: reqStr(r.id),
          name: reqStr(r.name),
          tokenHash: reqStr(r.token_hash),
          createdAt: reqStr(r.created_at, now),
          createdBy: reqStr(r.created_by, 'bootstrap'),
          revokedAt: r.revoked_at != null ? reqStr(r.revoked_at) : null,
          note: reqStr(r.note),
          scope: reqStr(r.scope),
          updatedAt: optStr(r.updated_at),
          writerId: optStr(r.writer_id),
        },
        r.extra,
      ),
    )

  doc.uploadLinks = rows.upload_links
    .sort((a, b) => (reqStr(a.created_at) < reqStr(b.created_at) ? -1 : reqStr(a.created_at) > reqStr(b.created_at) ? 1 : reqStr(a.id) < reqStr(b.id) ? -1 : 1))
    .map((r) =>
      extraInto(
        {
          id: reqStr(r.id),
          tokenHash: reqStr(r.token_hash),
          projectId: reqStr(r.project_id),
          sectionId: reqStr(r.section_id),
          maxFileBytes: Number(r.max_file_bytes ?? 0),
          note: reqStr(r.note),
          createdAt: reqStr(r.created_at, now),
          createdBy: reqStr(r.created_by),
          expiresAt: reqStr(r.expires_at, now),
          revokedAt: r.revoked_at != null ? reqStr(r.revoked_at) : null,
          updatedAt: optStr(r.updated_at),
          writerId: optStr(r.writer_id),
        },
        r.extra,
      ),
    )

  doc.refs = rows.refs
    .sort((a, b) => (reqStr(a.created_at) < reqStr(b.created_at) ? -1 : reqStr(a.created_at) > reqStr(b.created_at) ? 1 : reqStr(a.id) < reqStr(b.id) ? -1 : 1))
    .map((r) =>
      extraInto(
        {
          id: reqStr(r.id),
          projectId: r.project_id != null ? reqStr(r.project_id) : null,
          url: reqStr(r.url),
          title: reqStr(r.title),
          note: reqStr(r.note),
          createdAt: reqStr(r.created_at, now),
          updatedAt: optStr(r.updated_at),
          writerId: optStr(r.writer_id),
          deleted: r.deleted_at != null ? { at: reqStr(r.deleted_at), by: reqStr(r.deleted_by) } : null,
        },
        r.extra,
      ),
    )

  doc.comments = rows.comments
    .sort((a, b) => (reqStr(a.created_at) < reqStr(b.created_at) ? -1 : reqStr(a.created_at) > reqStr(b.created_at) ? 1 : reqStr(a.id) < reqStr(b.id) ? -1 : 1))
    .map((r) =>
      extraInto(
        {
          id: reqStr(r.id),
          projectId: reqStr(r.project_id),
          body: reqStr(r.body),
          by: reqStr(r.by, 'anonymous'),
          createdAt: reqStr(r.created_at, now),
          updatedAt: optStr(r.updated_at),
          writerId: optStr(r.writer_id),
          deleted: r.deleted_at != null ? { at: reqStr(r.deleted_at), by: reqStr(r.deleted_by) } : null,
        },
        r.extra,
      ),
    )

  doc.tombstones = rows.deletions
    .sort((a, b) => (reqStr(a.at) < reqStr(b.at) ? -1 : reqStr(a.at) > reqStr(b.at) ? 1 : reqStr(a.id) < reqStr(b.id) ? -1 : 1))
    .map((r) => ({ type: reqStr(r.type), id: reqStr(r.id), at: reqStr(r.at), by: reqStr(r.by) }))

  // newest-first LIMIT happens in the read (regen.ts); rows arrive capped.
  doc.activity = rows.activity
    .map((r) => ({ seq: Number(r.seq ?? 0), ev: { at: reqStr(r.at), actor: reqStr(r.actor), verb: reqStr(r.verb), ref: reqStr(r.ref), meta: parseJson(r.meta) ?? {} } }))
    .sort((a, b) => b.seq - a.seq)
    .slice(0, ACTIVITY_REGEN_CAP)
    .map((x) => x.ev)
    .reverse()

  doc.snapshots = rows.snapshots
    .sort((a, b) => (reqStr(a.at) < reqStr(b.at) ? -1 : reqStr(a.at) > reqStr(b.at) ? 1 : reqStr(a.file_id) < reqStr(b.file_id) ? -1 : 1))
    .map((r) => ({ fileId: reqStr(r.file_id), rev: Number(r.rev ?? 0), at: reqStr(r.at), by: reqStr(r.by), note: reqStr(r.note) }))

  return doc
}

// ---------------------------------------------------------------------------
// diffDocs — the shadow gate's instrument: actual doc vs regenerated doc
// ---------------------------------------------------------------------------

export type Divergence = { path: string; doc: string; d1: string }
export type DiffReport = { clean: boolean; divergences: Divergence[]; compared: Record<string, number> }

const CAP = 20

function diverge(out: Divergence[], path: string, a: unknown, b: unknown): void {
  if (out.length >= CAP) return
  out.push({ path, doc: canonicalJson(a).slice(0, 400), d1: canonicalJson(b).slice(0, 400) })
}

/** Async full compare — activity hashing needs await, so the whole report is
 *  async. Entity records compare per-id (order-free); fileIds compare as a
 *  SET + section map (row order is approximated by added_at); sections,
 *  copies, tombstones, snapshots compare keyed/ordered; activity compares as
 *  hash SETS. */
export async function diffDocs(actual: LightDoc, regen: LightDoc): Promise<DiffReport> {
  const out: Divergence[] = []
  const compared: Record<string, number> = {}
  const scalar = (path: string, a: unknown, b: unknown): void => {
    compared[path] = (compared[path] ?? 0) + 1
    if (!sameJson(a, b)) diverge(out, path, a, b)
  }
  const keyed = (path: string, a: unknown, b: unknown): void => {
    const am = a as Record<string, unknown> | undefined
    const bm = b as Record<string, unknown> | undefined
    const ao = am ?? {}
    const bo = bm ?? {}
    compared[path] = Object.keys(ao).length
    for (const id of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
      if (!sameJson(ao[id] ?? null, bo[id] ?? null)) diverge(out, `${path}.${id}`, ao[id] ?? null, bo[id] ?? null)
    }
  }

  scalar('schema', actual.schema, regen.schema)
  scalar('rev', actual.rev, regen.rev)
  scalar('writerId', actual.writerId, regen.writerId)
  scalar('updatedAt', actual.updatedAt, regen.updatedAt)
  scalar('settings', actual.settings, regen.settings)
  scalar('ids', actual.ids, regen.ids)
  scalar('users.studioSub', actual.users?.studioSub ?? null, regen.users?.studioSub ?? null)
  keyed('groups', actual.groups, regen.groups)
  keyed('projects', actual.projects, regen.projects)
  keyed('scripts', actual.scripts, regen.scripts)
  keyed('users.app', idMap(actual.users?.app), idMap(regen.users?.app))
  keyed('users.viewers', idMap(actual.users?.viewers), idMap(regen.users?.viewers))
  keyed('uploadLinks', idMap(actual.uploadLinks), idMap(regen.uploadLinks))
  keyed('refs', idMap(actual.refs), idMap(regen.refs))
  keyed('comments', idMap(actual.comments), idMap(regen.comments))

  // project children + script copies (parents already compared above; skip
  // one-sided ids here — the record diff reported those).
  for (const id of Object.keys(actual.projects ?? {})) {
    const pa = actual.projects?.[id]
    const pb = regen.projects?.[id]
    if (!pa || !pb) continue
    const sa = pa.mediaSections ?? []
    const sb = pb.mediaSections ?? []
    compared['mediaSections'] = (compared['mediaSections'] ?? 0) + sa.length
    if (!sameJson(sa, sb)) diverge(out, `projects.${id}.mediaSections`, sa, sb)
    const fa = new Set(pa.fileIds ?? [])
    const fb = new Set(pb.fileIds ?? [])
    compared['fileIds'] = (compared['fileIds'] ?? 0) + fa.size
    for (const k of fa) if (!fb.has(k)) diverge(out, `projects.${id}.fileIds`, k, null)
    for (const k of fb) if (!fa.has(k)) diverge(out, `projects.${id}.fileIds`, null, k)
    if (!sameJson(pa.mediaSectionOf ?? {}, pb.mediaSectionOf ?? {})) {
      diverge(out, `projects.${id}.mediaSectionOf`, pa.mediaSectionOf ?? {}, pb.mediaSectionOf ?? {})
    }
  }
  for (const id of Object.keys(actual.scripts ?? {})) {
    const sa = actual.scripts?.[id]
    const sb = regen.scripts?.[id]
    if (!sa || !sb) continue
    compared['scriptCopies'] = (compared['scriptCopies'] ?? 0) + (sa.copies ?? []).length
    if (!sameJson(sa.copies ?? [], sb.copies ?? [])) diverge(out, `scripts.${id}.copies`, sa.copies ?? [], sb.copies ?? [])
  }

  const ta = new Map((actual.tombstones ?? []).map((t) => [`${t.type}:${t.id}`, t]))
  const tb = new Map((regen.tombstones ?? []).map((t) => [`${t.type}:${t.id}`, t]))
  compared['tombstones'] = ta.size
  for (const [k, t] of ta) if (!sameJson(t, tb.get(k) ?? null)) diverge(out, `tombstones.${k}`, t, tb.get(k) ?? null)
  for (const [k, t] of tb) if (!ta.has(k)) diverge(out, `tombstones.${k}`, null, t)

  const snapA = new Map((actual.snapshots ?? []).map((m) => [m.fileId, m]))
  const snapB = new Map((regen.snapshots ?? []).map((m) => [m.fileId, m]))
  compared['snapshots'] = snapA.size
  for (const [k, m] of snapA) if (!sameJson(m, snapB.get(k) ?? null)) diverge(out, `snapshots.${k}`, m, snapB.get(k) ?? null)
  for (const [k, m] of snapB) if (!snapA.has(k)) diverge(out, `snapshots.${k}`, null, m)

  // activity as hash sets.
  const ha = new Set<string>()
  for (const a of actual.activity ?? []) ha.add(await activityHash(a))
  const hb = new Set<string>()
  for (const a of regen.activity ?? []) hb.add(await activityHash(a))
  compared['activity'] = ha.size
  const docOnly: string[] = []
  const d1Only: string[] = []
  for (const h of ha) if (!hb.has(h)) docOnly.push(h)
  for (const h of hb) if (!ha.has(h)) d1Only.push(h)
  if (out.length < CAP && (docOnly.length || d1Only.length)) {
    out.push({ path: 'activity', doc: `${docOnly.length} events not in D1`, d1: `${d1Only.length} events not in doc` })
  }

  return { clean: out.length === 0, divergences: out, compared }
}
