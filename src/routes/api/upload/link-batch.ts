// Verify-and-repair for guest uploads — POST /api/upload/link-batch.
//
// Each file is linked server-side at its own completion (hardened there), but
// the CAS cannot be atomic (OCI ignores If-Match): a late peer put can erase
// links that already verified. Once a batch DRAINS the contention is over, so
// one quiescent read-modify-write over ALL the batch's keys re-links anything
// a late clobber dropped — a no-op when nothing is missing. The guest page
// calls this right before showing "All done". Same credential as init: the
// raw link token as the bearer.

import { createFileRoute } from '@tanstack/react-router'

const MAX_KEYS = 64 // one doc rewrite per call; the client chunks bigger batches

export const Route = createFileRoute('/api/upload/link-batch')({
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
        const doc = await auth.loadNexusDoc().catch(() => null)
        if (!doc) return Response.json({ error: 'Workspace is not reachable — try again in a moment' }, { status: 503 })
        const { resolveUploadLink } = await import('../../../server/uploadLinks')
        const verdict = await resolveUploadLink(doc, bearer, Date.now())
        if (!verdict.ok) {
          console.log(`[upload-link-batch] reject (${verdict.log}) from ${ip}`)
          return Response.json({ error: verdict.message }, { status: verdict.status })
        }
        auth.loginForgiven(ip) // successes must not count toward the failure window
        const { link, project } = verdict

        let body: { keys?: unknown }
        try {
          body = (await request.json()) as { keys?: unknown }
        } catch {
          return Response.json({ error: 'Bad request body' }, { status: 400 })
        }
        const keys = Array.isArray(body.keys) ? [...new Set(body.keys.filter((k): k is string => typeof k === 'string'))] : []
        if (keys.length === 0 || keys.length > MAX_KEYS) {
          return Response.json({ error: `Send 1–${MAX_KEYS} keys` }, { status: 400 })
        }
        // Every key MUST belong to the link's project folder — the link token
        // must never move (or invent) files anywhere else.
        const prefix = project.folderId ?? ''
        if (!prefix || !keys.every((k) => k.startsWith(prefix))) {
          return Response.json({ error: 'Key outside this link\'s project' }, { status: 403 })
        }

        const { linkUploadedFiles } = await import('../../../server/linking')
        try {
          const { outcome, added } = await linkUploadedFiles(
            keys.map((key) => ({ key, projectId: link.projectId, sectionId: link.sectionId, actorUid: link.id })),
          )
          return Response.json({ ok: true, checked: keys.length, outcome, added }, { headers: { 'Cache-Control': 'no-store' } })
        } catch (e) {
          console.error(`[upload-link-batch] ${link.id}: ${e instanceof Error ? e.message : e}`)
          return Response.json({ error: 'Could not verify the uploads — try again' }, { status: 502 })
        }
      },
    },
  },
})
