// URL-backed view state for the project page. Filters (section/kind/sort/q)
// and the lightbox target live in the search params — refresh, back/forward,
// and shared links preserve the exact view. Filter writes use replace:true
// (they're view twiddles, not places); tab changes push history so Back
// leaves the page naturally.

import { getRouteApi } from '@tanstack/react-router'
import type { MediaKind, MediaSort } from '../../../util/media'
import { parseMediaView, serializeMediaView, type MediaViewUrl } from '../../../util/mediaUrl'

const routeApi = getRouteApi('/project/$projectId')

export interface ResolvedMediaView {
  tab: 'media' | 'scripts' | 'settings'
  section: string
  kind: MediaKind | 'all'
  sort: MediaSort
  q: string
  /** Storage key of the file open in the lightbox, when any. */
  file?: string
}

export const MEDIA_VIEW_DEFAULTS: ResolvedMediaView = {
  tab: 'media',
  section: 'all',
  kind: 'all',
  sort: 'date-desc',
  q: '',
}

export function useMediaView(): {
  view: ResolvedMediaView
  /** Filter writes — replace:true, they don't deserve their own history entries. */
  setView: (patch: Partial<Omit<MediaViewUrl, 'tab'>>) => void
  /** Tab writes push history entries. */
  setTab: (tab: ResolvedMediaView['tab']) => void
} {
  const search = routeApi.useSearch()
  const navigate = routeApi.useNavigate()

  const view: ResolvedMediaView = {
    tab: search.tab ?? MEDIA_VIEW_DEFAULTS.tab,
    section: search.section ?? MEDIA_VIEW_DEFAULTS.section,
    kind: search.kind ?? MEDIA_VIEW_DEFAULTS.kind,
    sort: search.sort ?? MEDIA_VIEW_DEFAULTS.sort,
    q: search.q ?? MEDIA_VIEW_DEFAULTS.q,
    file: search.file,
  }

  const setView = (patch: Partial<Omit<MediaViewUrl, 'tab'>>): void => {
    void navigate({
      search: (prev: MediaViewUrl) => serializeMediaView({ ...parseMediaView(prev), ...patch }),
      replace: true,
    })
  }

  const setTab = (tab: ResolvedMediaView['tab']): void => {
    void navigate({
      search: (prev: MediaViewUrl) => serializeMediaView({ ...parseMediaView(prev), tab }),
      // Defaults never serialize, so leaving the Media tab also drops media
      // filter noise from the URL.
      replace: false,
    })
  }

  return { view, setView, setTab }
}
