// Public guest-info endpoint for an upload link: the /upload/<token> page
// posts the raw token here and learns ONLY the project name, section name,
// expiry, per-file size cap and the destination folder id — nothing else
// about the workspace. Same throttle model as login; successes forgive the
// IP so a multi-file guest can't lock themselves out.

import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/upload/link')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { getRequest } = await import('@tanstack/react-start/server')
        const ip = getRequest().headers.get('CF-Connecting-IP') ?? 'unknown'
        const auth = await import('../../../server/auth')
        if (auth.loginThrottled(ip)) {
          return Response.json({ error: 'Too many attempts — wait a few minutes and try again' }, { status: 429 })
        }
        let token = ''
        try {
          const body = (await request.json()) as { token?: unknown }
          if (typeof body.token === 'string') token = body.token
        } catch {
          /* fall through to the invalid-token path */
        }
        if (!token || token.length < 20 || token.length > 200) {
          return Response.json({ error: 'This upload link is not valid or has expired' }, { status: 401 })
        }
        // FRESH read — a just-minted link must not dead-end on a stale
        // isolate doc cache (same rationale as loginFn's loadNexusDoc).
        let doc
        try {
          doc = await auth.loadNexusDoc()
        } catch {
          return Response.json({ error: 'Workspace is not reachable — try again in a moment' }, { status: 503 })
        }
        const { resolveUploadLink } = await import('../../../server/uploadLinks')
        const verdict = await resolveUploadLink(doc, token, Date.now())
        if (!verdict.ok) {
          console.log(`[upload-link] reject (${verdict.log}) from ${ip}`)
          return Response.json({ error: verdict.message }, { status: verdict.status })
        }
        auth.loginForgiven(ip)
        const { link, project } = verdict
        if (!project.folderId) {
          return Response.json({ error: 'The project folder is not ready yet — try again in a few seconds' }, { status: 409 })
        }
        const sectionName = project.mediaSections.find((s) => s.id === link.sectionId)?.name ?? null
        return Response.json(
          {
            projectName: project.name,
            sectionName, // null when the section was deleted after mint — uploads land un-sectioned ("All")
            expiresAt: link.expiresAt,
            maxFileBytes: link.maxFileBytes,
            folderId: project.folderId,
          },
          { headers: { 'Cache-Control': 'no-store' } },
        )
      },
    },
  },
})
