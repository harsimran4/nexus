// GET /api/public/list?parent=&pageSize=&pageToken= — public listing (viewer
// reads + the migration script's verify step). Same exposure as the old
// API-key path: any non-trash key is listable. trash/ is denied.

import { createFileRoute } from '@tanstack/react-router'
import { TRASH_PREFIX } from '../../../server/keys'

export const Route = createFileRoute('/api/public/list')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        const parent = url.searchParams.get('parent') ?? ''
        const pageSize = Math.min(Number(url.searchParams.get('pageSize') ?? '100') || 100, 1000)
        const pageToken = url.searchParams.get('pageToken') ?? undefined
        if (parent.startsWith(TRASH_PREFIX)) return Response.json({ error: 'Not found' }, { status: 404 })
        try {
          const { listCore } = await import('../../../server/queries')
          return Response.json(await listCore(parent, pageSize, pageToken))
        } catch (e) {
          return Response.json({ error: e instanceof Error ? e.message : 'List failed' }, { status: 502 })
        }
      },
    },
  },
})
