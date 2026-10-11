import { compareHlc } from './hlc'
import type { Group } from '../types/schema'

/** The palette a group color can name — each maps to the --sticky-N tokens
 *  in tokens.css (light + dark). Stored on group.color as one of these
 *  strings, or '' (Auto) / 'none' (explicit neutral). */
export const GROUP_COLOR_KEYS = [
  'sticky-1', 'sticky-2', 'sticky-3', 'sticky-4',
  'sticky-5', 'sticky-6', 'sticky-7', 'sticky-8',
] as const

export const GROUP_COLOR_NAMES: Record<(typeof GROUP_COLOR_KEYS)[number], string> = {
  'sticky-1': 'Pale yellow',
  'sticky-2': 'Pale green',
  'sticky-3': 'Pale pink',
  'sticky-4': 'Pale blue',
  'sticky-5': 'Pale purple',
  'sticky-6': 'Pale teal',
  'sticky-7': 'Terracotta',
  'sticky-8': 'Sage',
}

/** groupId -> color class ('sticky-N'). Explicit colors win; Auto ('')
 *  groups take the lowest-index shade nobody uses yet, else cycle by
 *  createdAt rank; 'none' groups get no entry (neutral paper). The input
 *  order is normalized to createdAt HLC so every client derives the same
 *  map — unlike object key order, which re-flows on every add/delete
 *  (the old `i % 5` bug: colors that wandered on their own). */
export function groupColorMap(groups: Group[]): Record<string, string> {
  const ordered = [...groups].sort((a, b) => compareHlc(a.createdAt, b.createdAt))
  const taken = new Set<string>()
  for (const g of ordered) if (g.color?.startsWith('sticky-')) taken.add(g.color)
  const autoTaken = new Set<string>()
  const out: Record<string, string> = {}
  ordered.forEach((g, rank) => {
    const c = g.color ?? ''
    if (c === 'none') return
    if (c.startsWith('sticky-')) {
      out[g.id] = c
      return
    }
    let pick = GROUP_COLOR_KEYS.find((k) => !taken.has(k) && !autoTaken.has(k))
    pick ??= GROUP_COLOR_KEYS[rank % GROUP_COLOR_KEYS.length]
    autoTaken.add(pick)
    out[g.id] = pick
  })
  return out
}
