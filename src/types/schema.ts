import { z } from 'zod'

// ---------------------------------------------------------------------------
// nexus.json v1 — the entire "database". One object, written whole to Drive.
// Unknown/newer fields are preserved verbatim on merge (see sync/merge.ts) so
// a stale deployed app can never destroy data written by a newer one.
// ---------------------------------------------------------------------------

export const BUCKETS = ['todo', 'doing', 'done'] as const
export type Bucket = (typeof BUCKETS)[number]

export const ITEM_KINDS = ['video', 'script', 'thumbnail', 'audio', 'doc', 'other'] as const
export type ItemKind = (typeof ITEM_KINDS)[number]

export const ROLES = ['admin', 'editor', 'viewer'] as const
export type Role = (typeof ROLES)[number]

export const SCRIPT_STATUSES = ['draft', 'review', 'final'] as const
export type ScriptStatus = (typeof SCRIPT_STATUSES)[number]

export const pipelineEntrySchema = z.object({
  id: z.string(),
  label: z.string(),
  bucket: z.enum(BUCKETS).default('todo'),
})

export const syncSettingsSchema = z.object({
  debounceMs: z.number().int().min(250).default(2500),
  pollMs: z.number().int().min(2000).default(10_000),
  tombstoneGcDays: z.number().int().min(7).default(90),
  snapshotKeep: z.number().int().min(3).default(30),
  maxDocBytes: z.number().int().min(100_000).default(4_000_000),
})

export const settingsSchema = z
  .object({
    rootFolderName: z.string().min(1).default('Nexus Root'),
    api: z.object({ keyOverride: z.string().nullable().default(null) }).default({ keyOverride: null }),
    privacy: z
      .object({
        // Default true: the site URL alone must not reveal content — viewers
        // need their login link. (The Drive folder itself remains link-shared,
        // which is what makes the API-key read path work at all.)
        requireViewerLogin: z.boolean().default(true),
        redactNames: z.boolean().default(false),
      })
      .default({ requireViewerLogin: true, redactNames: false }),
    pipeline: z.array(pipelineEntrySchema).default([
      { id: 'pending', label: 'Pending', bucket: 'todo' },
      { id: 'in_process', label: 'In process', bucket: 'doing' },
      { id: 'completed', label: 'Completed', bucket: 'done' },
    ]),
    labels: z.array(z.string()).default(['finished', 'client-approved', 'needs-review']),
    workflow: z.object({ archiveDoneAfterDays: z.number().int().min(0).default(30) }).default({ archiveDoneAfterDays: 30 }),
    sync: syncSettingsSchema.default({}),
  })
  .default({})

export const deletedSchema = z
  .object({ at: z.string(), by: z.string() })
  .nullable()
  .default(null)
export type Deleted = z.infer<typeof deletedSchema>

const stampsSchema = z.object({
  createdAt: z.string(),
  updatedAt: z.string(),
  writerId: z.string().default('unknown'),
  deleted: deletedSchema,
  archivedAt: z.string().nullable().default(null),
})

export const projectSchema = stampsSchema.extend({
  id: z.string(),
  name: z.string().min(1),
  description: z.string().default(''),
  folderId: z.string().nullable().default(null),
  labels: z.array(z.string()).default([]),
})
export type Project = z.infer<typeof projectSchema>

export const itemSchema = stampsSchema.extend({
  id: z.string(),
  projectId: z.string().nullable().default(null),
  title: z.string().min(1),
  kind: z.enum(ITEM_KINDS).default('video'),
  status: z.string().default('pending'),
  labels: z.array(z.string()).default([]),
  fileIds: z.array(z.string()).default([]),
  assigneeAppId: z.string().nullable().default(null),
  dueAt: z.string().nullable().default(null),
  notes: z.string().default(''),
})
export type Item = z.infer<typeof itemSchema>

export const scriptStorageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('inline'), body: z.string().default('') }),
  z.object({ type: z.literal('drive-doc'), fileId: z.string() }),
])

export const scriptSchema = stampsSchema.extend({
  id: z.string(),
  title: z.string().min(1),
  storage: scriptStorageSchema.default({ type: 'inline', body: '' }),
  projectId: z.string().nullable().default(null),
  itemId: z.string().nullable().default(null),
  status: z.enum(SCRIPT_STATUSES).default('draft'),
  copies: z.array(z.object({ fileId: z.string(), label: z.string(), at: z.string() })).default([]),
})
export type Script = z.infer<typeof scriptSchema>

export const appUserSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  role: z.enum(ROLES),
  disabled: z.boolean().default(false),
  auth: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('token'), hash: z.string() }), // "sha256$<hex>"
    z.object({ kind: z.literal('argon2id'), hash: z.string() }), // PHC encoded string
    z.object({ kind: z.literal('pbkdf2'), hash: z.string(), salt: z.string(), iterations: z.number().int() }),
  ]),
  createdAt: z.string(),
  createdBy: z.string().default('bootstrap'),
})
export type AppUser = z.infer<typeof appUserSchema>

export const activityEventSchema = z.object({
  at: z.string(),
  actor: z.string(), // app user id, or "system:<verb>"
  verb: z.string(), // e.g. "item.status", "project.create", "*.undelete"
  ref: z.string(), // entity id
  meta: z.record(z.string(), z.unknown()).default({}),
})
export type ActivityEvent = z.infer<typeof activityEventSchema>

export const tombstoneSchema = z.object({
  type: z.enum(['project', 'item', 'script']),
  id: z.string(),
  at: z.string(),
  by: z.string(),
})
export type Tombstone = z.infer<typeof tombstoneSchema>

export const snapshotMetaSchema = z.object({
  fileId: z.string(),
  rev: z.number().int(),
  at: z.string(),
  by: z.string(),
  note: z.string().default(''),
})
export type SnapshotMeta = z.infer<typeof snapshotMetaSchema>

export const viewerSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  tokenHash: z.string(), // "sha256$<hex>" — 256-bit random token, never stored raw
  createdAt: z.string(),
  createdBy: z.string().default('bootstrap'),
  revokedAt: z.string().nullable().default(null),
  note: z.string().default(''),
})
export type Viewer = z.infer<typeof viewerSchema>

export const usersSchema = z
  .object({
    app: z.array(appUserSchema).default([]),
    studioSub: z.string().nullable().default(null),
    viewers: z.array(viewerSchema).default([]),
  })
  .default({})

export const nexusDocSchema = z.object({
  schema: z.number().int().min(1),
  rev: z.number().int().min(0).default(0),
  writerId: z.string().default('bootstrap'),
  updatedAt: z.string().default(''),
  ids: z
    .object({ rootFolderId: z.string().default(''), nexusFileId: z.string().default('') })
    .default({ rootFolderId: '', nexusFileId: '' }),
  users: usersSchema,
  settings: settingsSchema,
  projects: z.record(z.string(), projectSchema).default({}),
  items: z.record(z.string(), itemSchema).default({}),
  scripts: z.record(z.string(), scriptSchema).default({}),
  tombstones: z.array(tombstoneSchema).default([]),
  activity: z.array(activityEventSchema).default([]),
  snapshots: z.array(snapshotMetaSchema).default([]),
  crypto: z.null().default(null), // reserved for the v2 client-side encryption envelope
})
export type NexusDoc = z.infer<typeof nexusDocSchema>

/** Entities whose LWW merge happens per-key inside a Record. */
export type EntityMaps = Pick<NexusDoc, 'projects' | 'items' | 'scripts'>
export type EntityOf<K extends keyof EntityMaps> = EntityMaps[K][string]

export function emptyDoc(): NexusDoc {
  return nexusDocSchema.parse({ schema: 1, rev: 0 })
}

export type ParseFail = { ok: false; error: z.ZodError }
export type ParseOk = { ok: true; doc: NexusDoc }

export function parseDoc(raw: string | unknown): ParseOk | ParseFail {
  let json: unknown
  if (typeof raw === 'string') {
    try {
      json = JSON.parse(raw)
    } catch {
      return { ok: false, error: new z.ZodError([{ code: 'custom', message: 'not valid JSON', path: [] }]) }
    }
  } else {
    json = raw
  }
  const result = nexusDocSchema.safeParse(json)
  if (result.success) return { ok: true, doc: result.data }
  return { ok: false, error: result.error }
}

export const defaultStatus = (doc: NexusDoc): string => doc.settings.pipeline[0]?.id ?? 'pending'
export const statusLabel = (doc: NexusDoc, id: string): string =>
  doc.settings.pipeline.find((p) => p.id === id)?.label ?? id
export const statusBucket = (doc: NexusDoc, id: string): Bucket =>
  doc.settings.pipeline.find((p) => p.id === id)?.bucket ?? 'todo'
