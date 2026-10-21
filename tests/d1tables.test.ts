import { describe, expect, it } from 'vitest'
import {
  activityHash,
  canonicalJson,
  diffDocs,
  docToOps,
  importActivityOps,
  renderSql,
  rowsToDoc,
  wipeOps,
  wireDiff,
  type AllRows,
  type LightDoc,
  type SqlOp,
} from '../src/server/d1/tables'
import { compileOps } from '../src/server/d1/apply'

// The mirror's op stream = the ONE wire diff through the ONE SQL compiler —
// the exact pair the stage-2 gateway uses.
async function mirrorOps(prev: LightDoc, next: LightDoc): Promise<SqlOp[]> {
  return compileOps(await wireDiff(prev, next))
}

// INVARIANT: every compiled statement's placeholder count equals its arg
// count — D1 rejects the whole batch otherwise ("wrong number of parameter
// bindings"). Checked on every fixture transition below.
function expectBindingsMatch(ops: SqlOp[]): void {
  for (const op of ops) {
    const placeholders = (op.sql.match(/\?/g) ?? []).length
    expect(placeholders, `binding mismatch in: ${op.sql}`).toBe(op.args.length)
  }
}

// ---------------------------------------------------------------------------
// A tiny op interpreter: applies SqlOps to Maps keyed by each table's PK —
// the same semantics D1 gives the batch, without needing SQLite in vitest.
// ---------------------------------------------------------------------------

const PK: Record<string, string[]> = {
  meta: ['key'],
  groups: ['id'],
  projects: ['id'],
  media_sections: ['project_id', 'id'],
  project_files: ['project_id', 'file_key'],
  scripts: ['id'],
  script_acts: ['script_id', 'id'],
  script_copies: ['script_id', 'file_id'],
  beats: ['script_id', 'id'],
  scenes: ['script_id', 'id'],
  shots: ['script_id', 'id'],
  story_links: ['script_id', 'id'],
  users_app: ['id'],
  viewers: ['id'],
  upload_links: ['id'],
  refs: ['id'],
  comments: ['id'],
  activity: ['h'],
  deletions: ['type', 'id'],
  snapshots: ['file_id'],
}

type Db = Map<string, Map<string, Record<string, unknown>>>

const AUTOINC: Record<string, string> = { activity: 'seq' } // tables with AUTOINCREMENT PKs
const autoincSeq: Record<string, number> = {}

function apply(db: Db, ops: SqlOp[]): void {
  expectBindingsMatch(ops)
  for (const op of ops) {
    if (/^DELETE FROM activity WHERE h IN/.test(op.sql)) {
      const hashes = new Set(op.args.map(String))
      const target = db.get('activity')!
      for (const [k, row] of target) if (hashes.has(String(row.h))) target.delete(k)
      continue
    }
    const m = /^DELETE FROM (\w+)/.exec(op.sql)
    if (m) {
      const table = m[1]!
      if (op.args.length === 0) {
        db.set(table, new Map())
        continue
      }
      const pk = PK[table]!
      // WHERE constrains only the columns given args (a child-table delete by
      // parent id omits the rest of the PK)
      const target = db.get(table) ?? new Map()
      for (const [k, row] of target) {
        if (pk.every((c, i) => i >= op.args.length || row[c] === op.args[i])) target.delete(k)
      }
      continue
    }
    const ins = /^INSERT(?: OR REPLACE| OR IGNORE)? INTO (\w+)/.exec(op.sql)
    if (ins) {
      const table = ins[1]!
      const ignore = /INSERT OR IGNORE/.test(op.sql)
      const cols = op.sql.slice(op.sql.indexOf('(') + 1, op.sql.indexOf(')')).split(',')
      const row: Record<string, unknown> = {}
      cols.forEach((c, i) => (row[c.trim()] = op.args[i]))
      const auto = AUTOINC[table]
      if (auto && row[auto] === undefined) row[auto] = (autoincSeq[table] = (autoincSeq[table] ?? 0) + 1)
      const pk = PK[table]!
      const key = pk.map((c) => String(row[c])).join(':')
      const target = db.get(table) ?? new Map()
      const existing = target.get(key)
      if (existing) {
        if (ignore) continue // OR IGNORE: duplicate (activity hash) is a no-op
        // upsert with the LWW guard — two stamp dialects: HLC (digits/dots)
        // always beats legacy ISO; within a dialect, lexical compare
        const isHlc = (v: unknown) => /^[0-9.]*$/.test(String(v))
        const newer =
          String(row.updated_at) > String(existing.updated_at) ||
          (isHlc(row.updated_at) && !isHlc(existing.updated_at))
        if (/ON CONFLICT/.test(op.sql) && !newer) continue
        target.set(key, row)
      } else {
        target.set(key, row)
      }
      db.set(table, target)
      continue
    }
    throw new Error(`unhandled op: ${op.sql}`)
  }
}

function rowsOf(db: Db): AllRows {
  const out = {} as AllRows
  for (const t of Object.keys(PK)) out[t as keyof AllRows] = [...(db.get(t)?.values() ?? [])] as never
  return out
}

function emptyDb(): Db {
  const db: Db = new Map()
  for (const t of Object.keys(PK)) db.set(t, new Map())
  return db
}

// ---------------------------------------------------------------------------
// Fixture — a realistic parsed doc (post-zod shape, defaults materialized)
// ---------------------------------------------------------------------------

function fixtureDoc(): LightDoc {
  return {
    schema: 1,
    rev: 42,
    writerId: 'u_admin',
    updatedAt: '2026-10-17T10:00:00.000Z',
    ids: { rootFolderId: '', nexusFileId: 'master/nexus.json', systemFolders: { master: 'master/', snapshots: 'snapshots/' } },
    users: {
      studioSub: null,
      app: [
        {
          id: 'u_admin',
          name: 'Admin',
          role: 'admin',
          disabled: false,
          auth: { kind: 'pbkdf2', hash: 'sha256$abc', salt: 's1', iterations: 600000 },
          createdAt: '2026-10-01T00:00:00.000Z',
          createdBy: 'bootstrap',
          sessionEpoch: 3,
          updatedAt: '2026-10-02T00:00:00.000Z',
          writerId: 'bootstrap',
        },
      ],
      viewers: [{ id: 'v_1', name: 'Client', tokenHash: 'sha256$def', createdAt: '2026-10-01T00:00:00.000Z', createdBy: 'u_admin', revokedAt: null, note: 'acme' }],
    },
    settings: { rootFolderName: 'Nexus Root', labels: ['finished'], sync: { debounceMs: 2500 } },
    uploadLinks: [
      {
        id: 'ul_1',
        tokenHash: 'sha256$eee',
        projectId: 'prj_1',
        sectionId: 'sec_raw',
        maxFileBytes: 104857600,
        note: '',
        createdAt: '2026-10-03T00:00:00.000Z',
        createdBy: 'u_admin',
        expiresAt: '2026-10-04T00:00:00.000Z',
        revokedAt: null,
      },
    ],
    refs: [
      { id: 'ref_1', projectId: 'prj_1', url: 'https://example.com', title: 'Inspo', note: '', createdAt: '2026-10-03T01:00:00.000Z', deleted: null },
      { id: 'ref_2', projectId: null, url: 'https://gone.example', title: 'Old', note: 'x', createdAt: '2026-10-03T02:00:00.000Z', deleted: { at: '2026-10-05T00:00:00.000Z', by: 'u_admin' } },
    ],
    comments: [
      { id: 'cmt_1', projectId: 'prj_1', body: 'logo looks good', by: 'u_admin', createdAt: '2026-10-06T02:00:00.000Z', updatedAt: '2026-10-06T02:00:00.000Z', writerId: 'u_admin|d|t', deleted: null },
      { id: 'cmt_2', projectId: 'prj_1', body: 'swap the music', by: 'u_editor', createdAt: '2026-10-06T03:00:00.000Z', deleted: { at: '2026-10-06T04:00:00.000Z', by: 'u_admin|d|t' } },
    ],
    groups: {
      grp_1: {
        id: 'grp_1',
        name: 'Client Work',
        description: 'Acme',
        folderId: 'groups/grp_1/',
        color: 'sticky-1',
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-02T00:00:00.000Z',
        writerId: 'u_admin',
        deleted: null,
        archivedAt: null,
      },
      grp_del: {
        id: 'grp_del',
        name: 'Old Group',
        description: '',
        folderId: null,
        color: '',
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-05T00:00:00.000Z',
        writerId: 'u_admin',
        deleted: { at: '2026-10-05T00:00:00.000Z', by: 'u_admin' },
        archivedAt: null,
      },
    },
    projects: {
      prj_1: {
        id: 'prj_1',
        groupId: 'grp_1',
        name: 'Launch Video',
        folderId: 'groups/grp_1/prj_1/',
        status: 'doing',
        labels: ['needs-review'],
        fileIds: ['groups/grp_1/prj_1/f_a__shot.mp4', 'groups/grp_1/prj_1/f_b__logo.png'],
        mediaSections: [
          { id: 'sec_raw', name: 'Raw' },
          { id: 'sec_done', name: 'Finished' },
        ],
        mediaSectionOf: { 'groups/grp_1/prj_1/f_a__shot.mp4': 'sec_raw', 'groups/grp_1/prj_1/f_b__logo.png': 'sec_done' },
        assigneeAppId: 'u_admin',
        dueAt: '2026-11-01T00:00:00.000Z',
        notes: 'keep the logo',
        approved: { at: '2026-10-06T05:00:00.000Z', by: 'u_admin' },
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-06T00:00:00.000Z',
        writerId: 'u_admin',
        deleted: null,
        archivedAt: null,
      },
    },
    scripts: {
      scr_1: {
        id: 'scr_1',
        title: 'Voiceover',
        storage: { type: 'inline', body: '# line' },
        projectId: 'prj_1',
        status: 'review',
        copies: [{ fileId: 'scripts/copy1.md', label: 'review', at: '2026-10-06T01:00:00.000Z' }],
        acts: [
          { id: 'act_opening', name: 'Opening' },
          { id: 'act_middle', name: 'Middle' },
        ],
        // rides scripts.extra — deliberately NOT a column (SCRIPT_KNOWN omits it)
        brief: { concept: 'a film about film', premise: '', themes: 'time', audience: '', tone: '', mood: '', goals: '' },
        createdAt: '2026-10-04T00:00:00.000Z',
        updatedAt: '2026-10-06T01:00:00.000Z',
        writerId: 'u_admin',
        deleted: null,
        archivedAt: null,
      },
    },
    beats: {
      beat_1: {
        id: 'beat_1',
        scriptId: 'scr_1',
        actId: 'act_opening',
        title: 'Cold open',
        summary: 'The city wakes.',
        purpose: 'Establish the world.',
        bridge: 'Hard cut to the studio.',
        sort: 100,
        pos: { x: 120.5, y: -40 },
        createdAt: '2026-10-05T00:00:00.000Z',
        updatedAt: '2026-10-06T00:00:00.000Z',
        writerId: 'u_admin',
        deleted: null,
        archivedAt: null,
      },
      beat_2: {
        id: 'beat_2',
        scriptId: 'scr_1',
        actId: 'act_middle',
        title: 'Turn',
        summary: 'The plan fails.',
        purpose: 'Raise the stakes.',
        bridge: '',
        sort: 100,
        // NO pos — absent must stay absent (the shadow-diff trap)
        createdAt: '2026-10-05T01:00:00.000Z',
        updatedAt: '2026-10-05T01:00:00.000Z',
        writerId: 'u_admin',
        deleted: null,
        archivedAt: null,
      },
    },
    scenes: {
      scn_1: {
        id: 'scn_1',
        scriptId: 'scr_1',
        beatId: 'beat_1',
        title: 'Rooftops',
        action: 'Dawn pan across the city.',
        location: 'Rooftop, downtown',
        sort: 100,
        pos: { x: 300, y: 90 },
        createdAt: '2026-10-05T02:00:00.000Z',
        updatedAt: '2026-10-05T02:00:00.000Z',
        writerId: 'u_admin',
        deleted: null,
        archivedAt: null,
      },
    },
    shots: {
      shot_1: {
        id: 'shot_1',
        scriptId: 'scr_1',
        sceneId: 'scn_1',
        beatId: null,
        caption: 'Wide establishing',
        shotSize: 'Wide',
        cameraMove: 'Slow pan',
        composition: 'Rule of thirds',
        lighting: 'Golden hour',
        sound: 'City rumble',
        durationSec: 4.5,
        storyboardFileKey: 'groups/grp_1/prj_1/f_b__logo.png',
        sort: 100,
        createdAt: '2026-10-05T03:00:00.000Z',
        updatedAt: '2026-10-05T03:00:00.000Z',
        writerId: 'u_admin',
        deleted: null,
        archivedAt: null,
      },
      shot_2: {
        id: 'shot_2',
        scriptId: 'scr_1',
        sceneId: null,
        beatId: 'beat_1', // a beat-level shot (no scene yet)
        caption: 'Insert — alarm clock',
        shotSize: 'Close-up',
        cameraMove: '',
        composition: '',
        lighting: '',
        sound: '',
        sort: 200,
        createdAt: '2026-10-05T04:00:00.000Z',
        updatedAt: '2026-10-05T04:00:00.000Z',
        writerId: 'u_admin',
        deleted: null,
        archivedAt: null,
      },
    },
    storyLinks: [
      { id: 'lnk_1', scriptId: 'scr_1', fromKind: 'ref', fromId: 'ref_1', toKind: 'beat', toId: 'beat_1', rel: 'inspires', note: 'the light here', createdAt: '2026-10-06T00:00:00.000Z', deleted: null },
      { id: 'lnk_2', scriptId: 'scr_1', fromKind: 'scene', fromId: 'scn_1', toKind: 'beat', toId: 'beat_2', rel: 'serves', note: '', createdAt: '2026-10-06T01:00:00.000Z', updatedAt: '2026-10-06T02:00:00.000Z', writerId: 'u_admin', deleted: { at: '2026-10-06T03:00:00.000Z', by: 'u_admin' } },
    ],
    tombstones: [
      { type: 'project', id: 'prj_old', at: '2026-10-05T00:00:00.000Z', by: 'u_admin' },
      { type: 'script', id: 'scr_old', at: '2026-10-05T01:00:00.000Z', by: 'u_admin' },
    ],
    activity: [
      { at: '2026-10-06T00:00:00.000Z', actor: 'u_admin', verb: 'project.rename', ref: 'prj_1', meta: { from: 'A', to: 'Launch Video' } },
      { at: '2026-10-06T01:00:00.000Z', actor: 'u_admin', verb: 'script.milestone', ref: 'scr_1', meta: { label: 'review' } },
      { at: '2026-10-06T02:00:00.000Z', actor: 'system:upload', verb: 'project.attach', ref: 'prj_1', meta: { fileId: 'groups/grp_1/prj_1/f_b__logo.png', via: 'upload' } },
    ],
    snapshots: [{ fileId: 'snapshots/1728000000000-r42.json', rev: 42, at: '2026-10-06T03:00:00.000Z', by: 'u_admin', note: 'pre-move' }],
  }
}

async function importDoc(doc: LightDoc): Promise<Db> {
  const db = emptyDb()
  apply(db, wipeOps())
  apply(db, docToOps(doc))
  apply(db, await importActivityOps(doc))
  return db
}

// ---------------------------------------------------------------------------
// Roundtrip: doc → rows → doc must be EXACT
// ---------------------------------------------------------------------------

describe('d1 roundtrip', () => {
  it('regenerates the doc exactly', async () => {
    const doc = fixtureDoc()
    const db = await importDoc(doc)
    const regen = rowsToDoc(rowsOf(db))
    expect(canonicalJson(regen)).toBe(canonicalJson(doc))
  })

  it('round-trips soft deletes with BOTH halves', async () => {
    const doc = fixtureDoc()
    const db = await importDoc(doc)
    const g = db.get('groups')!.get('grp_del')!
    expect(g.deleted_at).toBe('2026-10-05T00:00:00.000Z')
    expect(g.deleted_by).toBe('u_admin')
    const ref = db.get('refs')!.get('ref_2')!
    expect(ref.deleted_by).toBe('u_admin')
  })

  it('lands unknown entity fields in extra and merges them back', async () => {
    const doc = fixtureDoc()
    ;(doc.groups!.grp_1 as Record<string, unknown>).futureField = { v: 1 }
    const db = await importDoc(doc)
    const row = db.get('groups')!.get('grp_1')!
    expect(String(row.extra)).toContain('futureField')
    const regen = rowsToDoc(rowsOf(db))
    expect((regen.groups!.grp_1 as Record<string, unknown>).futureField).toEqual({ v: 1 })
  })

  it('re-import is idempotent (wipe + replace converges)', async () => {
    const doc = fixtureDoc()
    const db = await importDoc(doc)
    apply(db, wipeOps())
    apply(db, docToOps(doc))
    apply(db, await importActivityOps(doc))
    expect(canonicalJson(rowsToDoc(rowsOf(db)))).toBe(canonicalJson(doc))
  })

  it('story: pos omitted stays absent, pos set round-trips', async () => {
    const doc = fixtureDoc()
    const db = await importDoc(doc)
    const withPos = db.get('beats')!.get('scr_1:beat_1')!
    expect(withPos.pos_x).toBe(120.5)
    expect(withPos.pos_y).toBe(-40)
    const withoutPos = db.get('beats')!.get('scr_1:beat_2')!
    expect(withoutPos.pos_x).toBeNull()
    expect(withoutPos.pos_y).toBeNull()
    const regen = rowsToDoc(rowsOf(db))
    expect((regen.beats!.beat_2 as Record<string, unknown>).pos).toBeUndefined()
    expect((regen.beats!.beat_1 as Record<string, unknown>).pos).toEqual({ x: 120.5, y: -40 })
  })

  it('story: the brief rides scripts.extra, never a column', async () => {
    const doc = fixtureDoc()
    const db = await importDoc(doc)
    const row = db.get('scripts')!.get('scr_1')!
    expect(Object.keys(row)).not.toContain('brief')
    expect(String(row.extra)).toContain('brief')
    expect(String(row.extra)).toContain('a film about film')
    const regen = rowsToDoc(rowsOf(db))
    expect((regen.scripts!.scr_1 as Record<string, unknown>).brief).toEqual(doc.scripts!.scr_1!.brief)
  })

  it('story: shot omit-when-unset keys round-trip', async () => {
    const doc = fixtureDoc()
    const db = await importDoc(doc)
    const regen = rowsToDoc(rowsOf(db))
    expect((regen.shots!.shot_1 as Record<string, unknown>).durationSec).toBe(4.5)
    expect((regen.shots!.shot_2 as Record<string, unknown>).durationSec).toBeUndefined()
    expect((regen.shots!.shot_2 as Record<string, unknown>).storyboardFileKey).toBeUndefined()
    expect((regen.shots!.shot_1 as Record<string, unknown>).storyboardFileKey).toBe('groups/grp_1/prj_1/f_b__logo.png')
  })
})

// ---------------------------------------------------------------------------
// mirrorOps — the diff-based transitions
// ---------------------------------------------------------------------------

describe('d1 mirrorOps', () => {
  it('first sight (prev null) full-inserts', async () => {
    const doc = fixtureDoc()
    const ops = [...docToOps(doc), ...(await importActivityOps(doc))]
    const db = emptyDb()
    apply(db, ops)
    expect(canonicalJson(rowsToDoc(rowsOf(db)))).toBe(canonicalJson(doc))
  })

  it('a rename touches one project row, not its children', async () => {
    const prev = fixtureDoc()
    const next = structuredClone(prev)
    next.projects!.prj_1!.name = 'Renamed'
    next.rev = 43
    const ops = await mirrorOps(prev, next)
    const puts = ops.filter((o) => o.sql.startsWith('INSERT'))
    const dels = ops.filter((o) => o.sql.startsWith('DELETE'))
    // exactly two puts: meta.rev and the project row — no child churn, no dels
    expect(puts).toHaveLength(2)
    expect(puts[1]!.sql).toMatch(/^INSERT INTO projects .*ON CONFLICT\(id\) DO UPDATE/)
    expect(dels).toHaveLength(0)
    expect(ops.filter((o) => o.sql.includes('project_files'))).toHaveLength(0)
    expect(ops.filter((o) => o.sql.includes('media_sections'))).toHaveLength(0)
  })

  it('adding a file inserts one project_files row (plus the parent row)', async () => {
    const prev = fixtureDoc()
    const key = 'groups/grp_1/prj_1/f_c__new.mp4'
    const next = structuredClone(prev)
    next.projects!.prj_1!.fileIds!.push(key)
    next.projects!.prj_1!.mediaSectionOf![key] = 'sec_raw'
    const ops = await mirrorOps(prev, next)
    expect(ops.filter((o) => o.sql.includes('INTO project_files'))).toHaveLength(1)
    const db = await importDoc(prev)
    apply(db, ops)
    expect(db.get('project_files')!.size).toBe(3)
    expect(canonicalJson(rowsToDoc(rowsOf(db)))).toBe(canonicalJson(next))
  })

  it('a section move updates only the moved file rows', async () => {
    const prev = fixtureDoc()
    const next = structuredClone(prev)
    next.projects!.prj_1!.mediaSectionOf!['groups/grp_1/prj_1/f_a__shot.mp4'] = 'sec_done'
    const ops = await mirrorOps(prev, next)
    const fileOps = ops.filter((o) => o.sql.includes('project_files'))
    expect(fileOps).toHaveLength(1)
    expect(fileOps[0]!.sql).toMatch(/^INSERT/)
  })

  it('deleting a script cleans its copies before the parent row', async () => {
    const prev = fixtureDoc()
    const next = structuredClone(prev)
    delete next.scripts!.scr_1
    next.tombstones!.push({ type: 'script', id: 'scr_1', at: '2026-10-07T00:00:00.000Z', by: 'u_admin' })
    const ops = await mirrorOps(prev, next)
    const delIdx = ops.map((o) => o.sql)
    expect(delIdx.indexOf('DELETE FROM script_copies WHERE script_id = ?')).toBeLessThan(delIdx.indexOf('DELETE FROM scripts WHERE id = ?'))
    const db = await importDoc(prev)
    apply(db, ops)
    expect(db.get('scripts')!.size).toBe(0)
    expect(db.get('script_copies')!.size).toBe(0)
  })

  it('story: deleting a script sweeps every story child first (FK order)', async () => {
    const prev = fixtureDoc()
    const next = structuredClone(prev)
    delete next.scripts!.scr_1
    delete next.beats!.beat_1
    delete next.beats!.beat_2
    delete next.scenes!.scn_1
    delete next.shots!.shot_1
    delete next.shots!.shot_2
    next.storyLinks = []
    next.tombstones!.push({ type: 'script', id: 'scr_1', at: '2026-10-07T00:00:00.000Z', by: 'u_admin' })
    const ops = await mirrorOps(prev, next)
    const order = ops.map((o) => o.sql)
    const scriptsIdx = order.indexOf('DELETE FROM scripts WHERE id = ?')
    for (const child of ['DELETE FROM story_links WHERE script_id = ?', 'DELETE FROM shots WHERE script_id = ?', 'DELETE FROM scenes WHERE script_id = ?', 'DELETE FROM beats WHERE script_id = ?', 'DELETE FROM script_acts WHERE script_id = ?']) {
      expect(order.indexOf(child)).toBeLessThan(scriptsIdx)
    }
    const db = await importDoc(prev)
    apply(db, ops)
    for (const t of ['story_links', 'shots', 'scenes', 'beats', 'script_acts', 'scripts']) {
      expect(db.get(t)!.size).toBe(0)
    }
  })

  it('story: a GC-removed beat on a living script deletes exactly its row', async () => {
    const prev = fixtureDoc()
    const next = structuredClone(prev)
    delete next.beats!.beat_1
    next.tombstones!.push({ type: 'beat', id: 'beat_1', at: '2026-10-07T00:00:00.000Z', by: 'u_admin' })
    const ops = await mirrorOps(prev, next)
    const beatDels = ops.filter((o) => o.sql === 'DELETE FROM beats WHERE script_id = ? AND id = ?')
    expect(beatDels).toHaveLength(1)
    expect(beatDels[0]!.args).toEqual(['scr_1', 'beat_1'])
    const db = await importDoc(prev)
    apply(db, ops)
    expect(db.get('beats')!.size).toBe(1) // beat_2 survives
    expect(canonicalJson(rowsToDoc(rowsOf(db)))).toBe(canonicalJson(next))
  })

  it('story: a beat edit is one row put; a title flip churns no act rows', async () => {
    const prev = fixtureDoc()
    const next = structuredClone(prev)
    next.beats!.beat_1!.summary = 'The city wakes, hungry.'
    const ops = await mirrorOps(prev, next)
    expect(ops.filter((o) => o.sql.includes('INTO beats'))).toHaveLength(1)
    expect(ops.some((o) => o.sql.includes('script_acts'))).toBe(false)

    const actsMove = structuredClone(prev)
    actsMove.scripts!.scr_1!.acts = [
      { id: 'act_middle', name: 'Middle' },
      { id: 'act_opening', name: 'Opening' },
    ]
    const ops2 = await mirrorOps(prev, actsMove)
    // whole rewrite: one prefix del + one put per act
    expect(ops2.filter((o) => o.sql === 'DELETE FROM script_acts WHERE script_id = ?')).toHaveLength(1)
    expect(ops2.filter((o) => o.sql.includes('INTO script_acts'))).toHaveLength(2)
    const db = await importDoc(prev)
    apply(db, ops2)
    expect(canonicalJson(rowsToDoc(rowsOf(db)))).toBe(canonicalJson(actsMove))
  })

  it('story: adding a link is one story_links put; a soft delete updates the row', async () => {
    const prev = fixtureDoc()
    const next = structuredClone(prev)
    next.storyLinks!.push({ id: 'lnk_3', scriptId: 'scr_1', fromKind: 'script', fromId: 'scr_1', toKind: 'scene', toId: 'scn_1', rel: 'references', note: '', createdAt: '2026-10-06T05:00:00.000Z', deleted: null })
    const ops = await mirrorOps(prev, next)
    expect(ops.filter((o) => o.sql.includes('INTO story_links'))).toHaveLength(1)
    const db = await importDoc(prev)
    apply(db, ops)
    expect(db.get('story_links')!.size).toBe(3)

    const removed = structuredClone(next)
    removed.storyLinks = removed.storyLinks!.map((l) => (l.id === 'lnk_3' ? { ...l, deleted: { at: '2026-10-07T00:00:00.000Z', by: 'u_admin' } } : l))
    const ops2 = await mirrorOps(next, removed)
    expect(ops2.filter((o) => o.sql.startsWith('DELETE FROM story_links'))).toHaveLength(0) // soft delete = row update
    expect(ops2.filter((o) => o.sql.includes('INTO story_links'))).toHaveLength(1)
  })

  it('deleting a project cleans sections and files before the parent row', async () => {
    const prev = fixtureDoc()
    const next = structuredClone(prev)
    delete next.projects!.prj_1
    next.tombstones!.push({ type: 'project', id: 'prj_1', at: '2026-10-07T00:00:00.000Z', by: 'u_admin' })
    const ops = await mirrorOps(prev, next)
    const order = ops.map((o) => o.sql)
    expect(order.indexOf('DELETE FROM media_sections WHERE project_id = ?')).toBeLessThan(order.indexOf('DELETE FROM projects WHERE id = ?'))
    expect(order.indexOf('DELETE FROM project_files WHERE project_id = ? AND file_key = ?')).toBeLessThan(order.indexOf('DELETE FROM projects WHERE id = ?'))
  })

  it('appending activity adds only new events (hash-identified)', async () => {
    const prev = fixtureDoc()
    const next = structuredClone(prev)
    next.activity!.push({ at: '2026-10-08T00:00:00.000Z', actor: 'u_admin', verb: 'project.move', ref: 'prj_1', meta: {} })
    const ops = await mirrorOps(prev, next)
    const activityOps = ops.filter((o) => o.sql.includes('INTO activity') || o.sql.includes('FROM activity'))
    expect(activityOps).toHaveLength(1)
    expect(activityOps[0]!.sql).toMatch(/^INSERT/)
    const db = await importDoc(prev)
    apply(db, ops)
    expect(db.get('activity')!.size).toBe(4)
  })

  it('a restore (ring moves backwards) deletes the newer events', async () => {
    const prev = fixtureDoc()
    const older = structuredClone(prev)
    older.activity = prev.activity!.slice(0, 1) // doc rolled back to one event
    const ops = await mirrorOps(prev, older)
    const dels = ops.filter((o) => o.sql.startsWith('DELETE FROM activity WHERE h IN'))
    expect(dels).toHaveLength(1)
    expect(dels[0]!.args).toHaveLength(2)
    const db = await importDoc(prev)
    apply(db, ops)
    expect(db.get('activity')!.size).toBe(1)
  })

  it('clearing studioSub removes its meta row', async () => {
    const prev = fixtureDoc()
    prev.users!.studioSub = 'sub_123'
    const next = structuredClone(prev)
    next.users!.studioSub = null
    const ops = await mirrorOps(prev, next)
    expect(ops.some((o) => o.sql === 'DELETE FROM meta WHERE key = ?' && o.args[0] === 'studioSub')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// identity + rendering + diff
// ---------------------------------------------------------------------------

describe('activity identity', () => {
  it('hash is stable across meta key order', async () => {
    const a = { at: 't', actor: 'a', verb: 'v', ref: 'r', meta: { x: 1, y: 2 } }
    const b = { ref: 'r', verb: 'v', actor: 'a', at: 't', meta: { y: 2, x: 1 } }
    expect(await activityHash(a)).toBe(await activityHash(b))
  })
  it('distinguishes content', async () => {
    const a = { at: 't', actor: 'a', verb: 'v', ref: 'r', meta: { x: 1 } }
    const b = { at: 't', actor: 'a', verb: 'v', ref: 'r', meta: { x: 2 } }
    expect(await activityHash(a)).not.toBe(await activityHash(b))
  })
})

describe('renderSql', () => {
  it('escapes quotes, NULLs, survives ? inside values', () => {
    const sql = renderSql({ sql: 'INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)', args: ["o'brien ? weird", null] })
    expect(sql).toBe(`INSERT OR REPLACE INTO meta (key,value) VALUES ('o''brien ? weird',NULL)`)
    expect(renderSql({ sql: 'DELETE FROM meta', args: [] })).toBe('DELETE FROM meta')
  })
})

describe('diffDocs', () => {
  it('clean on identical docs', async () => {
    const doc = fixtureDoc()
    const db = await importDoc(doc)
    const report = await diffDocs(doc, rowsToDoc(rowsOf(db)))
    expect(report.clean).toBe(true)
    expect(report.divergences).toEqual([])
  })

  it('names the path of a doc-side mutation', async () => {
    const doc = fixtureDoc()
    const db = await importDoc(doc)
    const mutated = structuredClone(doc)
    mutated.projects!.prj_1!.status = 'done'
    const report = await diffDocs(mutated, rowsToDoc(rowsOf(db)))
    expect(report.clean).toBe(false)
    expect(report.divergences.some((d) => d.path === 'projects.prj_1')).toBe(true)
  })

  it('catches a doc-only file (the exact class that lost 97 files)', async () => {
    const doc = fixtureDoc()
    const db = await importDoc(doc)
    const mutated = structuredClone(doc)
    mutated.projects!.prj_1!.fileIds!.push('groups/grp_1/prj_1/f_lost__gone.mp4')
    const report = await diffDocs(mutated, rowsToDoc(rowsOf(db)))
    expect(report.clean).toBe(false)
    expect(report.divergences.some((d) => d.path.startsWith('projects.prj_1.fileIds'))).toBe(true)
  })

  it('catches a missing meta row (ids never imported)', async () => {
    const doc = fixtureDoc()
    const db = await importDoc(doc)
    db.get('meta')!.delete('ids')
    const report = await diffDocs(doc, rowsToDoc(rowsOf(db)))
    expect(report.clean).toBe(false)
    expect(report.divergences.some((d) => d.path === 'ids')).toBe(true)
  })

  it('treats approved:null and absent as the same state (post-P7 client writes)', async () => {
    const doc = fixtureDoc()
    const db = await importDoc(doc)
    // An app-written project serializes the zod nullable default into the
    // doc; regen omits it. The shadow diff must not fire on the difference.
    const written = structuredClone(doc)
    written.projects!.prj_1!.approved = null
    const regen = rowsToDoc(rowsOf(db))
    ;(regen.projects!.prj_1 as Record<string, unknown>).approved = undefined
    delete (regen.projects!.prj_1 as Record<string, unknown>).approved
    const report = await diffDocs(written, regen)
    expect(report.clean).toBe(true)
  })

  it('activity order across writers is NOT a divergence (set compare)', async () => {
    const doc = fixtureDoc()
    const db = await importDoc(doc)
    // regen returns rows in seq order; doc order differs by an interleave
    const regen = rowsToDoc(rowsOf(db))
    const reordered = structuredClone(doc)
    reordered.activity = [...(doc.activity ?? [])].reverse()
    const report = await diffDocs(reordered, regen)
    expect(report.clean).toBe(true)
  })
})
