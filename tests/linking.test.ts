// linkUploadedFiles under concurrency — the 97-files-lost incident (2026-10).
// The mock store models the OCI semantics that matter: whole-object puts,
// monotonic etags, and NOTHING rejecting a stale overwrite (If-Match is
// ignored). Hook points inject peer writes at the two vulnerable moments:
// between our read and our CAS check, and after our put has landed.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/server/s3', () => {
  type Obj = { body: string; etag: number }
  const store = new Map<string, Obj>()
  let etagSeq = 1
  let headCalls = 0
  const hooks: {
    beforeSecondHead: null | (() => Promise<void> | void)
    afterPut: null | (() => Promise<void> | void)
  } = { beforeSecondHead: null, afterPut: null }
  return {
    head: async (key: string) => {
      headCalls++
      if (headCalls % 2 === 0 && hooks.beforeSecondHead) await hooks.beforeSecondHead()
      const o = store.get(key)
      return o
        ? { etag: 'E' + o.etag, size: o.body.length, contentType: 'application/json', lastModified: null }
        : null
    },
    getText: async (key: string) => store.get(key)!.body,
    put: async (key: string, body: string) => {
      store.set(key, { body, etag: ++etagSeq })
      if (hooks.afterPut) await hooks.afterPut()
      return { etag: 'E' + etagSeq }
    },
    __mock: {
      store,
      hooks,
      writeDoc(body: string): void {
        store.set('master/nexus.json', { body, etag: ++etagSeq })
      },
      reset(): void {
        store.clear()
        etagSeq = 1
        headCalls = 0
        hooks.beforeSecondHead = null
        hooks.afterPut = null
      },
    },
  }
})
vi.mock('../src/server/auth', () => ({ invalidateDocCache: () => {} }))
vi.mock('../src/config', () => ({ config: { maxKnownSchema: 1, appVersion: 'test' } }))

const { linkUploadedFile, linkUploadedFiles } = await import('../src/server/linking')
const { emptyDoc } = await import('../src/types/schema')
const { __mock } = (await import('../src/server/s3')) as unknown as {
  __mock: {
    store: Map<string, { body: string; etag: number }>
    hooks: { beforeSecondHead: null | (() => Promise<void> | void); afterPut: null | (() => Promise<void> | void) }
    writeDoc(body: string): void
    reset(): void
  }
}

const KEY_A = 'groups/g1/p1/f_1__a.jpg'
const KEY_B = 'groups/g1/p1/f_2__b.jpg'
const KEY_C = 'groups/g1/p1/f_3__c.jpg'

const infoA = { key: KEY_A, projectId: 'p1', sectionId: 's1', actorUid: 'ul_test', fileName: 'a.jpg' }

function fixtureDoc(): string {
  const doc = emptyDoc()
  ;(doc.projects as Record<string, unknown>)['p1'] = {
    id: 'p1',
    groupId: 'g1',
    name: 'P',
    createdAt: 't0',
    updatedAt: 't0',
    deleted: null,
    folderId: 'groups/g1/p1/',
    fileIds: [],
    mediaSections: [{ id: 's1', name: 'Finished' }],
    mediaSectionOf: {},
  }
  return JSON.stringify(doc)
}

function docState(): { fileIds: string[]; mediaSectionOf: Record<string, string>; rev: number; activity: unknown[] } {
  const doc = JSON.parse(__mock.store.get('master/nexus.json')!.body)
  const p = doc.projects.p1
  return { fileIds: p.fileIds, mediaSectionOf: p.mediaSectionOf, rev: doc.rev, activity: doc.activity }
}

function withKey(base: string, key: string, section?: string): string {
  const doc = JSON.parse(base)
  doc.projects.p1.fileIds = [...(doc.projects.p1.fileIds ?? []), key]
  if (section) doc.projects.p1.mediaSectionOf[key] = section
  return JSON.stringify(doc)
}

beforeEach(() => {
  __mock.reset()
  __mock.store.set('master/nexus.json', { body: fixtureDoc(), etag: 1 })
})

describe('linkUploadedFile basics', () => {
  it('links a file and stamps the doc', async () => {
    const res = await linkUploadedFile(infoA)
    expect(res).toEqual({ outcome: 'linked', added: 1 })
    const st = docState()
    expect(st.fileIds).toEqual([KEY_A])
    expect(st.mediaSectionOf[KEY_A]).toBe('s1')
    expect(st.rev).toBe(1)
    expect(st.activity).toHaveLength(1)
  })

  it('is a no-op for an already-linked key (no doc write)', async () => {
    __mock.store.set('master/nexus.json', { body: withKey(fixtureDoc(), KEY_A, 's1'), etag: 1 })
    const before = __mock.store.get('master/nexus.json')!.etag
    const res = await linkUploadedFile(infoA)
    expect(res).toEqual({ outcome: 'already-linked', added: 0 })
    expect(__mock.store.get('master/nexus.json')!.etag).toBe(before)
  })

  it('resolves the project by key prefix when projectId is absent', async () => {
    const res = await linkUploadedFile({ key: KEY_B })
    expect(res).toEqual({ outcome: 'linked', added: 1 })
    expect(docState().fileIds).toContain(KEY_B)
  })

  it('reports no-project for a key nothing owns', async () => {
    const res = await linkUploadedFile({ key: 'groups/ghost/p9/f_1__x.jpg' })
    expect(res).toEqual({ outcome: 'no-project', added: 0 })
  })
})

describe('linkUploadedFiles batch', () => {
  it('writes once for the whole set and counts only new keys', async () => {
    __mock.store.set('master/nexus.json', { body: withKey(fixtureDoc(), KEY_A), etag: 1 })
    const res = await linkUploadedFiles([
      infoA,
      { key: KEY_B, projectId: 'p1', sectionId: 's1' },
      { key: KEY_C, projectId: 'p1' },
    ])
    expect(res).toEqual({ outcome: 'linked', added: 2 })
    const st = docState()
    expect(st.fileIds.sort()).toEqual([KEY_A, KEY_B, KEY_C].sort())
    expect(st.mediaSectionOf[KEY_C]).toBeUndefined() // section null → untouched
  })
})

describe('convergence under racing writers', () => {
  it('retries when a peer write lands before the CAS check', async () => {
    let peerLanded = false
    __mock.hooks.beforeSecondHead = () => {
      if (!peerLanded) {
        peerLanded = true
        __mock.writeDoc(withKey(fixtureDoc(), KEY_B))
      }
    }
    const res = await linkUploadedFile(infoA)
    expect(res.outcome).toBe('linked')
    const st = docState()
    expect(st.fileIds.sort()).toEqual([KEY_A, KEY_B].sort()) // peer's key survived our retry
  })

  it('post-put verify catches a late clobber and re-applies', async () => {
    let clobbered = false
    __mock.hooks.afterPut = () => {
      if (!clobbered) {
        // our put just landed; a peer whose read predated it overwrites with
        // a snapshot holding only ITS key — ours is gone
        clobbered = true
        __mock.writeDoc(withKey(fixtureDoc(), KEY_B))
      }
    }
    const res = await linkUploadedFile(infoA)
    expect(res.outcome).toBe('linked')
    const st = docState()
    expect(st.fileIds.sort()).toEqual([KEY_A, KEY_B].sort()) // both survive
  })

  it('gives up honestly after sustained contention (throw, not silent loss)', { timeout: 20_000 }, async () => {
    __mock.hooks.beforeSecondHead = () => {
      __mock.writeDoc(withKey(fixtureDoc(), KEY_B)) // churn on EVERY attempt
    }
    await expect(linkUploadedFile(infoA)).rejects.toThrow(/changed too quickly/)
    // nothing partial was written under our stale snapshot
    const st = docState()
    expect(st.fileIds).toEqual([KEY_B])
  })
})
