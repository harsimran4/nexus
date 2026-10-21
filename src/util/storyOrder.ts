// Pure ordering for story siblings (beats within an act, scenes within a
// beat, shots within their scene-or-beat parent). Sibling order lives as a
// `sort` int on EACH entity — never as a parent-carried id array, which two
// concurrent writers would clobber under whole-parent LWW (the rule the refs
// schema comment lays down). Renders always tie-break by id, so the order is
// deterministic even when two writers' renumbers interleave.

export interface Sortable {
  id: string
  sort: number
}

export const SORT_STEP = 100

/** Siblings in display order: (sort, id). */
export function bySort<T extends Sortable>(list: T[]): T[] {
  return [...list].sort((a, b) => a.sort - b.sort || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** The sort key for appending one sibling: max + step (step on empty). */
export function nextSort(list: Sortable[]): number {
  let max = 0
  for (const s of list) if (s.sort > max) max = s.sort
  return max + SORT_STEP
}

/**
 * Sort keys to move `id` to display index `toIndex`. Returns a PARTIAL map —
 * only ids whose sort actually changes — for the caller to apply inside its
 * commit; {} when the move is a no-op or the id is unknown. Prefers a
 * midpoint of the new neighbours (one row written); falls back to renumbering
 * the whole sibling set when no integer gap exists. A renumber writes each
 * sibling's own sort key (per-entity LWW), so it never clobbers a concurrent
 * content edit — the siblings merely converge on one deterministic order.
 */
export function moveSorts(list: Sortable[], id: string, toIndex: number): Record<string, number> {
  const moving = list.find((s) => s.id === id)
  if (!moving) return {}
  const ordered = bySort(list)
  const currentIndex = ordered.findIndex((s) => s.id === id)
  const rest = ordered.filter((s) => s.id !== id)
  const at = Math.max(0, Math.min(toIndex, rest.length))
  // After reinsertion the moving id sits at display index `at` — same index,
  // same order, nothing to write.
  if (currentIndex === at) return {}

  const prev = at > 0 ? rest[at - 1].sort : null
  const next = at < rest.length ? rest[at].sort : null
  if (prev !== null && next !== null) {
    const mid = (prev + next) / 2
    if (Number.isInteger(mid) && mid > prev && mid < next) {
      return mid === moving.sort ? {} : { [id]: mid }
    }
  } else if (prev !== null) {
    // Appending at the end — there is always room one step past the last.
    return { [id]: prev + SORT_STEP }
  } else if (next !== null) {
    const mid = next - SORT_STEP
    return mid === moving.sort ? {} : { [id]: mid }
  } else {
    return { [id]: SORT_STEP } // sole sibling
  }
  // No integer gap between the new neighbours — renumber everyone.
  const withMoving = [...rest.slice(0, at), moving, ...rest.slice(at)]
  const out: Record<string, number> = {}
  withMoving.forEach((s, i) => {
    const want = i * SORT_STEP + SORT_STEP
    if (s.sort !== want) out[s.id] = want
  })
  return out
}
