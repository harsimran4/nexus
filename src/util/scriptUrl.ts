// Pure parse/serialize for the Scripts pages' URL state — the routes'
// validateSearch runs parseScriptView so hand-edited URLs can't crash the
// page: every unknown value silently falls back to the default downstream.
// Mirrors util/mediaUrl.ts (the project page precedent). Unit-tested in
// tests/scriptUrl.test.ts.

import type { ScriptStatus } from '../types/schema'

export type ScriptWorkspaceTab = 'brief' | 'story' | 'shots' | 'graph' | 'manuscript'

/** The /scripts library list's filters. */
export interface ScriptListUrl {
  q?: string
  status?: ScriptStatus
}

/** The /scripts/$scriptId workspace's view state. */
export interface ScriptViewUrl {
  tab?: ScriptWorkspaceTab
  /** Focused story node (graph select / story editor) — deep-linkable. */
  select?: string
}

const WORKSPACE_TABS: ScriptWorkspaceTab[] = ['brief', 'story', 'shots', 'graph', 'manuscript']
const STATUSES: ScriptStatus[] = ['draft', 'review', 'final']

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)

export function parseScriptList(search: Record<string, unknown> | ScriptListUrl): ScriptListUrl {
  const s = search as Record<string, unknown>
  const q = str(s.q)
  const status = str(s.status)
  return {
    q: q ? q.slice(0, 100) : undefined,
    status: status && STATUSES.includes(status as ScriptStatus) ? (status as ScriptStatus) : undefined,
  }
}

export function serializeScriptList(view: ScriptListUrl): Record<string, string> {
  const out: Record<string, string> = {}
  if (view.q) out.q = view.q
  if (view.status) out.status = view.status
  return out
}

/** Accepts a raw search record (validateSearch) or an already-typed view
 *  (re-parsing before a navigate). */
export function parseScriptView(search: Record<string, unknown> | ScriptViewUrl): ScriptViewUrl {
  const s = search as Record<string, unknown>
  const tab = str(s.tab)
  return {
    tab: tab && WORKSPACE_TABS.includes(tab as ScriptWorkspaceTab) ? (tab as ScriptWorkspaceTab) : undefined,
    select: str(s.select),
  }
}

/** URL search object holding only non-defaults (tab defaults to 'brief'). */
export function serializeScriptView(view: ScriptViewUrl): Record<string, string> {
  const out: Record<string, string> = {}
  if (view.tab && view.tab !== 'brief') out.tab = view.tab
  if (view.select) out.select = view.select
  return out
}
