// Guest upload progress beacon — POST /api/upload/progress.
//
// The guest page reports coarse batch progress (done/total/failed) a few
// times per upload so the app can show the owner a live "friend's upload:
// 34/100" pill. Deliberately NOT doc writes: each report overwrites ONE small
// object (progress/<linkId>.json) — last-write-wins is fine for stats, and no
// read-modify-write means the beacon can't feed the completion CAS storm the
// linking hardening defends against. Same credential as init: the raw token.

import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/upload/progress')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { getRequest } = await import('@tanstack/react-start/server')
        const ip = getRequest().headers.get('CF-Connecting-IP') ?? 'unknown'
        const auth = await import('../../../server/auth')
        if (auth.loginThrottled(ip)) {
          return Response.json({ error: 'Too many attempts — wait a few minutes and try again' }, { status: 429 })
        }
        const bearer = auth.bearerFrom(request)
        if (!bearer) return Response.json({ error: 'Missing upload link' }, { status: 401 })
        // Cached doc is fine here: progress is informational, not authorization —
        // a revoked link's beacons stop within the 60s cache window.
        const doc = await auth.getCachedDoc()
        if (!doc) return Response.json({ error: 'Workspace is not reachable' }, { status: 503 })
        const { resolveUploadLink } = await import('../../../server/uploadLinks')
        const verdict = await resolveUploadLink(doc, bearer, Date.now())
        if (!verdict.ok) return Response.json({ error: verdict.message }, { status: verdict.status })
        auth.loginForgiven(ip)
        const { link, project } = verdict

        let body: { total?: unknown; done?: unknown; failed?: unknown; state?: unknown; keys?: unknown }
        try {
          body = (await request.json()) as typeof body
        } catch {
          return Response.json({ error: 'Bad request body' }, { status: 400 })
        }
        const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), 1e6) : 0)
        const record = {
          linkId: link.id,
          projectId: link.projectId,
          total: num(body.total),
          done: num(body.done),
          failed: num(body.failed),
          state: body.state === 'complete' ? 'complete' : body.state === 'failed' ? 'failed' : 'active',
          at: new Date().toISOString(),
        }
        const s3 = await import('../../../server/s3')
        try {
          await s3.put(`progress/${link.id}.json`, JSON.stringify(record), { contentType: 'application/json' })
        } catch (e) {
          // A dropped beacon must never fail the upload — log and 200.
          console.error(`[upload-progress] ${link.id}: ${e instanceof Error ? e.message : e}`)
        }

        // SERVER-SIDE BATCH REPAIR on completion: the guest tab may die right
        // after its own client-side repair pass starts (or never start it) —
        // the final beacon carries the batch's keys, so the worker can run the
        // same quiescent re-link here. Best-effort: a failed repair still
        // answers 200 (the client repair pass and the adopt-orphans script
        // remain the backstops; D1 makes this whole class disappear).
        if (record.state === 'complete' && Array.isArray(body.keys)) {
          const keys = [...new Set(body.keys.filter((k): k is string => typeof k === 'string'))]
          const prefix = project.folderId ?? ''
          if (prefix && keys.length > 0 && keys.length <= 512 && keys.every((k) => k.startsWith(prefix))) {
            const { linkUploadedFiles } = await import('../../../server/linking')
            try {
              for (let i = 0; i < keys.length; i += 64) {
                const chunk = keys.slice(i, i + 64)
                const { added } = await linkUploadedFiles(
                  chunk.map((key) => ({ key, projectId: link.projectId, sectionId: link.sectionId, actorUid: link.id })),
                )
                if (added > 0) console.log(`[upload-progress] repair ${link.id}: re-linked ${added}`)
              }
            } catch (e) {
              console.error(`[upload-progress] repair ${link.id}: ${e instanceof Error ? e.message : e}`)
            }
          }
        }

        void project
        return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })

      },
    },
  },
})
