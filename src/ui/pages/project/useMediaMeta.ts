import { useEffect, useState } from 'react'
import { getMeta, listChildren, type FileMeta } from '../../../drive/client'

/** Human-readable name from a storage key's decorative tail — the fallback
 *  when metadata can't be fetched (offline, missing object). Far better than
 *  showing a raw S3 key. */
export function keyName(key: string): string {
  const seg = key.slice(key.lastIndexOf('/') + 1)
  const name = seg.includes('__') ? seg.slice(seg.indexOf('__') + 2) : seg
  try {
    return decodeURIComponent(name) || key
  } catch {
    return name || key
  }
}

/** One listing per visit replaces N× getMeta calls; per-file getMeta fills
 *  only ids the listing missed (or when no folder is linked yet). Extracted
 *  from the old MediaTab unchanged, except failed lookups now store a
 *  readable key-derived name instead of the raw key. */
export function useMediaMeta(fileIds: string[], folderId: string | null | undefined): Record<string, FileMeta> {
  const [meta, setMeta] = useState<Record<string, FileMeta>>({})
  // Keys are user-named and may contain commas — '\n' can't appear in a key.
  const fileKey = fileIds.join('\n')

  useEffect(() => {
    let alive = true
    const ids = fileKey ? fileKey.split('\n') : []
    const fetchOne = (f: string) =>
      getMeta(f)
        .then((m) => {
          if (alive) setMeta((prev) => ({ ...prev, [f]: m }))
        })
        .catch(() => {
          if (alive) setMeta((prev) => ({ ...prev, [f]: { id: f, name: keyName(f) } }))
        })
    const run = async () => {
      if (folderId) {
        try {
          const files: FileMeta[] = []
          let pageToken: string | undefined
          for (let page = 0; page < 10 && (page === 0 || pageToken); page++) {
            const res = await listChildren(folderId, { pageToken })
            files.push(...res.files)
            pageToken = res.nextPageToken
          }
          if (!alive) return
          const byId = new Map(files.map((f) => [f.id, f]))
          setMeta((prev) => {
            const next = { ...prev }
            for (const f of ids) {
              const m = byId.get(f)
              if (m) next[f] = m
            }
            return next
          })
          for (const f of ids) if (!byId.has(f)) void fetchOne(f)
          return
        } catch {
          // listing failed (e.g. key path can't see the folder) — per-file below
        }
      }
      for (const f of ids) void fetchOne(f)
    }
    void run()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKey, folderId])

  return meta
}
