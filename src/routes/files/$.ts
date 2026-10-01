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
  let key = params._splat ?? ''
  try {
    key = decodeURIComponent(key)
  } catch {
    /* keep raw */
  }
  if (!key || key.includes('..')) return new Response('Bad key', { status: 400 })
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
  // Media bytes at a key never change (uploads mint fresh keys) → immutable.
  // Doc/scripts/snapshots mutate in place → revalidate every time.
  headers.set('Cache-Control', key.startsWith('projects/') ? 'public, max-age=86400, immutable' : 'no-cache')
  if (headOnly) return new Response(null, { status: res.status, headers })
  return new Response(res.body, { status: res.status, headers })
}
