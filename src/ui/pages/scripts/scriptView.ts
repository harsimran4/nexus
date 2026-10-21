// URL-backed view state for the script workspace. Tab writes push history
// (Back leaves the page naturally); the focused-node `select` param replaces
// (it's a view twiddle, not a place). Mirrors project/mediaView.ts.

import { getRouteApi } from '@tanstack/react-router'
import { parseScriptView, serializeScriptView, type ScriptViewUrl, type ScriptWorkspaceTab } from '../../../util/scriptUrl'

const routeApi = getRouteApi('/scripts/$scriptId')

export interface ResolvedScriptView {
  tab: ScriptWorkspaceTab
  select?: string
}

export const SCRIPT_VIEW_DEFAULTS: ResolvedScriptView = { tab: 'brief' }

export function useScriptView(): {
  view: ResolvedScriptView
  /** Select/filter writes — replace:true, they don't deserve history entries. */
  setView: (patch: Partial<Omit<ScriptViewUrl, 'tab'>>) => void
  /** Tab writes push history entries. */
  setTab: (tab: ResolvedScriptView['tab']) => void
} {
  const search = routeApi.useSearch()
  const navigate = routeApi.useNavigate()

  const view: ResolvedScriptView = {
    tab: search.tab ?? SCRIPT_VIEW_DEFAULTS.tab,
    select: search.select,
  }

  const setView = (patch: Partial<Omit<ScriptViewUrl, 'tab'>>): void => {
    void navigate({
      search: (prev: ScriptViewUrl) => serializeScriptView({ ...parseScriptView(prev), ...patch }),
      replace: true,
    })
  }

  const setTab = (tab: ResolvedScriptView['tab']): void => {
    void navigate({
      search: (prev: ScriptViewUrl) => serializeScriptView({ ...parseScriptView(prev), tab }),
      // Defaults never serialize, so leaving a tab also drops its noise.
      replace: false,
    })
  }

  return { view, setView, setTab }
}
