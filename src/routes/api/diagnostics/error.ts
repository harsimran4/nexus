// Client error beacon — the receiving end of src/ui/errorReport.ts.
// Authenticated-only (any valid session, viewers included): an open endpoint
// would be an abuse vector. One bucket object per report, ≤8KB — append-free,
// so there's no read-modify-write and no CAS races with the doc. Listed (and
// pruned) by Admin → Maintenance later; not surfaced in the app yet.

import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/diagnostics/error')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { env } = await import('cloudflare:workers')
        const auth = await import('../../../server/auth')
        const session = await auth.verifyToken(env.SESSION_SECRET, auth.bearerFrom(request))
        if (!session || !(await auth.stillValid(session))) {
          return Response.json({ error: 'unauthorized' }, { status: 401 })
        }
        let raw: string
        try {
          raw = JSON.stringify(await request.json())
        } catch {
          return Response.json({ error: 'bad json' }, { status: 400 })
        }
        if (!raw || raw.length > 8192) return Response.json({ error: 'payload too large' }, { status: 413 })
        const s3 = await import('../../../server/s3')
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const rand = crypto.randomUUID().slice(0, 8)
        await s3.put(`diagnostics/client-errors/${stamp}-${rand}.json`, raw, { contentType: 'application/json' })
        return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
      },
    },
  },
})
