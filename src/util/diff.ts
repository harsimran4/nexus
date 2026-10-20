// Line diff for script milestone copies — the smallest honest LCS diff:
// one pass over the LCS table, output as equal/remove/add rows. Bodies are
// script-sized (KBs), so the O(n·m) table is fine; cap inputs defensively.

export type DiffRow =
  | { kind: 'same'; text: string }
  | { kind: 'old'; text: string }
  | { kind: 'new'; text: string }

const MAX_LINES = 4000

/** Split into lines, keeping a stable trailing-empty handling (no phantom
 *  final row when the text ends with a newline). */
function toLines(text: string): string[] {
  const capped = text.length > 200_000 ? text.slice(0, 200_000) : text
  return capped.split('\n').slice(0, MAX_LINES)
}

/** Classic LCS table diff. Returns rows in document order. */
export function diffLines(aText: string, bText: string): DiffRow[] {
  const a = toLines(aText)
  const b = toLines(bText)
  const n = a.length
  const m = b.length
  // lcs[i][j] = LCS length of a[i..] vs b[j..]
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const rows: DiffRow[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'same', text: a[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      rows.push({ kind: 'old', text: a[i++] })
    } else {
      rows.push({ kind: 'new', text: b[j++] })
    }
  }
  while (i < n) rows.push({ kind: 'old', text: a[i++] })
  while (j < m) rows.push({ kind: 'new', text: b[j++] })
  return rows
}

/** Quick summary for the diff header: +added −removed counts. */
export function diffStats(rows: DiffRow[]): { added: number; removed: number; same: number } {
  const s = { added: 0, removed: 0, same: 0 }
  for (const r of rows) {
    if (r.kind === 'new') s.added++
    else if (r.kind === 'old') s.removed++
    else s.same++
  }
  return s
}
