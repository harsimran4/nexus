// GET /api/public/meta?key=<key> — public metadata for one key (viewer
// reads + health checks). trash/ and folder markers denied.

import { createFileRoute } from '@tanstack/react-router'
import { FOLDER_MARKER, TRASH_PREFIX } from '../../../server/keys'

export const Route = createFileRoute('/api/public/meta')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        const key = url.searchParams.get('key') ?? ''
        if (!key || key.includes('..') || key.startsWith(TRASH_PREFIX) || key.endsWith('/' + FOLDER_MARKER)) {
          return Response.json({ error: 'Not found' }, { status: 404 })
        }
        try {
          const { metaCore } = await import('../../../server/queries')
          return Response.json(await metaCore(key))
        } catch (e) {
          const status = e instanceof Error && (e as { status?: number }).status === 404 ? 404 : 502
          return Response.json({ error: e instanceof Error ? e.message : 'Meta failed' }, { status })
        }
      },
    },
  },
})
