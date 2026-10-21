import { describe, expect, it } from 'vitest'
import { bookkeepingOps, compileOps, validateOps, type WireOp } from '../src/server/d1/apply'

const goodPut = { t: 'put', table: 'projects', row: { id: 'prj_1', group_id: 'g', name: 'X', status: 'todo', updated_at: 't2', created_at: 't1' } } as const

describe('validateOps', () => {
  it('accepts a valid mixed batch and returns it typed', () => {
    const ops = [
      goodPut,
      { t: 'del', table: 'scripts', pk: ['scr_1'], at: 't5' },
      { t: 'meta', key: 'settings', value: '{}' },
      { t: 'activity', events: [{ at: 't1', actor: 'a', verb: 'v', ref: 'r', meta: {} }] },
      { t: 'tombstone', tombstone: { type: 'script', id: 'scr_9', at: 't1', by: 'u' } },
      { t: 'put', table: 'project_files', row: { project_id: 'p', file_key: 'k', section_id: null, added_at: 't1', added_by: 'u' } },
    ]
    expect(validateOps(ops)).toHaveLength(6)
  })

  it('rejects unknown tables, bad columns, missing pk/stamp', () => {
    expect(() => validateOps([{ t: 'put', table: 'sqlite_master', row: { id: 'x' } }])).toThrow(/unknown table/)
    expect(() => validateOps([{ t: 'put', table: 'projects', row: { id: 'p', evil: 1, updated_at: 't' } }])).toThrow(/column evil/)
    expect(() => validateOps([{ t: 'put', table: 'projects', row: { name: 'x', updated_at: 't' } }])).toThrow(/missing pk/)
    expect(() => validateOps([{ t: 'put', table: 'projects', row: { id: 'p' } }])).toThrow(/updated_at/)
    expect(() => validateOps([{ t: 'del', table: 'refs', pk: [] }])).toThrow(/pk/)
  })

  it('rejects non-client-writable meta keys (rev is server-authoritative)', () => {
    expect(() => validateOps([{ t: 'meta', key: 'rev', value: '999999' }])).toThrow(/not client-writable/)
    expect(() => validateOps([{ t: 'meta', key: 'stage', value: '2' }])).toThrow(/not client-writable/)
  })

  it('rejects malformed activity events and oversized batches', () => {
    expect(() => validateOps([{ t: 'activity', events: [{ at: 't' }] }])).toThrow(/at\/actor\/verb\/ref/)
    expect(() => validateOps(new Array(501).fill({ t: 'meta', key: 'ids', value: '{}' }))).toThrow(/too many ops/)
  })

  it('story tables validate like the rest of the registry', () => {
    // beats put: composite pk (script_id, id) + LWW stamp required
    expect(() =>
      validateOps([{ t: 'put', table: 'beats', row: { id: 'beat_1', script_id: 'scr_1', act_id: 'act_opening', sort: 100, pos_x: 1, pos_y: 2, created_at: 't1', updated_at: 't2' } }]),
    ).not.toThrow()
    expect(() =>
      validateOps([{ t: 'put', table: 'beats', row: { id: 'beat_1', script_id: 'scr_1', act_id: 'a', updated_at: 't2', created_at: 't1' } }]),
    ).not.toThrow()
    // missing script_id in the pk → rejected
    expect(() =>
      validateOps([{ t: 'put', table: 'story_links', row: { id: 'lnk_1', from_kind: 'ref', from_id: 'ref_1', to_kind: 'beat', to_id: 'beat_1', rel: 'inspires', created_at: 't1', updated_at: 't2' } }]),
    ).toThrow(/missing pk/)
    // guarded (non-strong) dels need the FULL composite key
    expect(() => validateOps([{ t: 'del', table: 'beats', pk: ['scr_1'], at: 't9' }])).toThrow(/full 2-column key/)
    expect(() => validateOps([{ t: 'del', table: 'beats', pk: ['scr_1', 'beat_1'], at: 't9' }])).not.toThrow()
    // mirror strong dels may use the script_id prefix (the sweep)
    expect(() => validateOps([{ t: 'del', table: 'beats', pk: ['scr_1'], strong: true }], { allowStrong: true })).not.toThrow()
    // unknown story column rejected
    expect(() =>
      validateOps([{ t: 'put', table: 'shots', row: { id: 's', script_id: 'p', evil: 1, updated_at: 't' } }]),
    ).toThrow(/column evil/)
  })
})

describe('compileOps', () => {
  it('LWW puts compile to a guarded upsert', async () => {
    const [op] = await compileOps([goodPut as unknown as WireOp])
    expect(op!.sql).toMatch(/^INSERT INTO projects/)
    expect(op!.sql).toMatch(/ON CONFLICT\(id\) DO UPDATE SET/)
    expect(op!.sql).toMatch(/WHERE excluded\.updated_at > projects\.updated_at/)
  })

  it('child-table puts stay unconditional INSERT OR REPLACE', async () => {
    const [op] = await compileOps([{ t: 'put', table: 'media_sections', row: { project_id: 'p', id: 's', name: 'Raw', sort: 0 } }])
    expect(op!.sql).toMatch(/^INSERT OR REPLACE INTO media_sections/)
    expect(op!.sql).not.toMatch(/CONFLICT.*WHERE/)
  })

  it('LWW deletes refuse newer rows; child deletes do not', async () => {
    const [d1] = await compileOps([{ t: 'del', table: 'refs', pk: ['ref_1'], at: 't9' }])
    expect(d1!.sql).toMatch(/AND \(updated_at IS NULL OR updated_at <= \? OR \(\? NOT GLOB/)
    expect(d1!.args).toEqual(['ref_1', 't9', 't9'])
    const [d2] = await compileOps([{ t: 'del', table: 'project_files', pk: ['p', 'k'] }])
    expect(d2!.sql).toBe('DELETE FROM project_files WHERE project_id = ? AND file_key = ?')
  })

  it('story puts compile to composite-key guarded upserts; prefix dels sweep by script', async () => {
    const [beatPut] = await compileOps([
      { t: 'put', table: 'beats', row: { id: 'beat_1', script_id: 'scr_1', act_id: 'act_opening', sort: 100, pos_x: null, pos_y: null, created_at: 't1', updated_at: 't2' } },
    ])
    expect(beatPut!.sql).toMatch(/^INSERT INTO beats/)
    expect(beatPut!.sql).toMatch(/ON CONFLICT\(script_id, ?id\) DO UPDATE SET/)

    const [sweep] = await compileOps([{ t: 'del', table: 'beats', pk: ['scr_1'], strong: true }])
    expect(sweep!.sql).toBe('DELETE FROM beats WHERE script_id = ?')

    const [guarded] = await compileOps([{ t: 'del', table: 'beats', pk: ['scr_1', 'beat_1'], at: 't9' }])
    expect(guarded!.sql).toBe('DELETE FROM beats WHERE script_id = ? AND id = ? AND (updated_at IS NULL OR updated_at <= ? OR (? NOT GLOB \'*[^0-9.]*\' AND updated_at GLOB \'*[^0-9.]*\'))')
  })

  it('activity dedupes by the SAME sha256 identity the shadow mirror uses', async () => {
    const ev = { at: 't', actor: 'a', verb: 'v', ref: 'r', meta: { x: 1 } }
    const [op] = await compileOps([{ t: 'activity', events: [ev] }])
    const { activityHash } = await import('../src/server/d1/tables')
    expect(op!.sql).toMatch(/^INSERT OR IGNORE INTO activity/)
    expect(op!.args![5]).toBe(await activityHash(ev))
  })

  it('bookkeeping bumps rev server-side and stamps the transition', () => {
    const ops = bookkeepingOps('gateway:u1', 'stamp-1')
    expect(ops[0]!.sql).toMatch(/UPDATE meta SET value = CAST\(CAST\(value AS INTEGER\) \+ 1 AS TEXT\) WHERE key = 'rev'/)
    expect(ops[1]!.args![0]).toContain('gateway:u1')
  })
})
