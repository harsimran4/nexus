// Public guest upload page — /upload/<token>. Rendered bare (see __root.tsx:
// guest paths bypass the shell, doc boot and viewer-login gate entirely).

import { createFileRoute } from '@tanstack/react-router'
import { UploadLinkPage } from '../ui/pages/UploadLink'

export const Route = createFileRoute('/upload/$token')({
  component: () => {
    const { token } = Route.useParams()
    return <UploadLinkPage token={token} />
  },
})
