// Minimal hybrid logical clock (HLC): wall-clock ms + same-ms counter.
// Encoded as "<ms>.<counter base36>" — comparable by (ms, counter).
// observes() folds remote stamps in so clocks that jumped ahead converge
// instead of dominating forever.

let lastMs = 0
let counter = 0

export function hlcNow(): string {
  const ms = Date.now()
  if (ms > lastMs) {
    lastMs = ms
    counter = 0
  } else {
    counter++
  }
  return encodeHlc(lastMs, counter)
}

export function encodeHlc(ms: number, c: number): string {
  return `${ms}.${c.toString(36).padStart(4, '0')}`
}

export function decodeHlc(stamp: string | undefined | null): { ms: number; c: number } {
  if (!stamp) return { ms: 0, c: 0 }
  const dot = stamp.indexOf('.')
  if (dot < 0) return { ms: 0, c: 0 }
  const ms = Number(stamp.slice(0, dot))
  const c = parseInt(stamp.slice(dot + 1), 36) || 0
  return { ms: Number.isFinite(ms) ? ms : 0, c }
}

/** Fold a remote stamp into the local clock so future local stamps sort after it. */
export function observeHlc(stamp: string | undefined | null): void {
  const { ms, c } = decodeHlc(stamp)
  if (ms > lastMs) {
    lastMs = ms
    counter = 0
  } else if (ms === lastMs && c > counter) {
    counter = c + 1
  }
}

/** -1 if a < b, 1 if a > b, 0 if equal. */
export function compareHlc(a: string | undefined | null, b: string | undefined | null): number {
  const da = decodeHlc(a)
  const db = decodeHlc(b)
  if (da.ms !== db.ms) return da.ms < db.ms ? -1 : 1
  if (da.c !== db.c) return da.c < db.c ? -1 : 1
  return 0
}

/** LWW winner: newer HLC wins; deterministic writerId tie-break. */
export function lwwWinner(aUpdatedAt: string, aWriter: string, bUpdatedAt: string, bWriter: string): 'a' | 'b' {
  const c = compareHlc(aUpdatedAt, bUpdatedAt)
  if (c !== 0) return c > 0 ? 'a' : 'b'
  return aWriter > bWriter ? 'a' : 'b'
}
