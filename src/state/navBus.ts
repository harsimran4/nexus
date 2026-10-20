// Cross-page deep-link requests for pages whose selection is local state.
// The ⌘K palette navigates to /scripts AND names the script to open; the
// Scripts page consumes the request on arrival. Module store — no provider.

let pendingScriptId: string | null = null
const subs = new Set<() => void>()

function emit(): void {
  for (const fn of subs) fn()
}

/** Ask the Scripts page to open this script (after navigating there). */
export function requestScript(id: string): void {
  pendingScriptId = id
  emit()
}

export function peekScriptRequest(): string | null {
  return pendingScriptId
}

/** Scripts page: subscribe; when an id is pending, select it and consume. */
export function consumeScriptRequest(): string | null {
  const id = pendingScriptId
  if (id !== null) {
    pendingScriptId = null
    emit()
  }
  return id
}

export function subscribe(fn: () => void): () => void {
  subs.add(fn)
  return () => subs.delete(fn)
}
