// GET/HEAD /files/<key..> — PUBLIC content route (viewers, anonymous boot,
// thumbnails, downloads). Same exposure level the old setup had: everything
// link-shared on Drive was readable with the embedded API key. trash/ and
// folder markers are denied. Streams through with Range support for video.

import { createFileRoute } from '@tanstack/react-router'
import { FOLDER_MARKER, TRASH_PREFIX } from '../../server/keys'

export const Route = createFileRoute('/files/$')({
  server: {
    handlers: {
      GET: async ({ request, params }) => serve(request, params),
      HEAD: async ({ request, params }) => serve(request, params, true),
    },
  },
})

async function serve(request: Request, params: { _splat?: string }, headOnly = false): Promise<Response> {
  // The router already percent-decodes the splat — decoding again would
  // corrupt any key containing a literal '%' sequence.
  const key = params._splat ?? ''
  // Traversal defense, precisely: only whole '.'/'..' path segments are
  // dangerous (and none can exist in our keys). Names may legitimately
  // contain consecutive dots ("clip... .mp4") — those are fine.
  if (!key || key.split('/').some((seg) => seg === '.' || seg === '..')) return new Response('Bad key', { status: 400 })
  // Deny internals quietly (404 — don't reveal their existence). nexus.json
  // itself stays public: anonymous boot reads it (same as the old setup).
  if (key.startsWith(TRASH_PREFIX) || key.endsWith('/' + FOLDER_MARKER)) {
    return new Response('Not found', { status: 404 })
  }
  const s3 = await import('../../server/s3')
  const range = request.headers.get('Range')
  const res = await s3.getRaw(key, range)
  if (!res.ok && res.status !== 304) {
    return new Response(res.status === 404 ? 'Not found' : 'Storage error', { status: res.status === 404 ? 404 : 502 })
  }
  const headers = new Headers()
  for (const h of ['Content-Type', 'Content-Length', 'Content-Range', 'ETag', 'Last-Modified']) {
    const v = res.headers.get(h)
    if (v) headers.set(h, v)
  }
  headers.set('Accept-Ranges', 'bytes')
  headers.set('X-Content-Type-Options', 'nosniff')
  // Media bytes at a key never change in place (uploads/renames mint fresh
  // keys; snapshots are write-once copies) → immutable. Doc and scripts
  // mutate in place → revalidate every time.
  const immutable = key.startsWith('groups/') || key.startsWith('snapshots/')
  headers.set('Cache-Control', immutable ? 'public, max-age=86400, immutable' : 'no-cache')
  if (headOnly) return new Response(null, { status: res.status, headers })
  return new Response(res.body, { status: res.status, headers })
}
