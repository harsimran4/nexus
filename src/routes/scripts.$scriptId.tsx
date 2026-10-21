import { createFileRoute } from '@tanstack/react-router'
import { ScriptWorkspace } from '../ui/pages/scripts/ScriptWorkspace'
import { parseScriptView } from '../util/scriptUrl'

export const Route = createFileRoute('/scripts/$scriptId')({
  // Workspace tab + focused-node state ride the URL (see util/scriptUrl.ts) —
  // refresh, Back/Forward, and shared links preserve the exact view.
  validateSearch: parseScriptView,
  component: () => {
    const { scriptId } = Route.useParams()
    return <ScriptWorkspace scriptId={scriptId} />
  },
})
