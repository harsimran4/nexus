import { createFileRoute } from '@tanstack/react-router'
import { Scripts } from '../ui/pages/Scripts'
import { parseScriptList } from '../util/scriptUrl'

export const Route = createFileRoute('/scripts/')({
  // List filters ride the URL (see util/scriptUrl.ts) — refresh and shared
  // links preserve the exact filter state.
  validateSearch: parseScriptList,
  component: Scripts,
})
