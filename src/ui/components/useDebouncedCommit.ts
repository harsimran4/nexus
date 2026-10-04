import { useEffect, useRef } from 'react'
import type { NexusDoc } from '../../types/schema'
import { commit } from '../../sync/writer'

/**
 * Merge rapid mutations (typing in an input) into ONE commit after the user
 * pauses. Every keystroke calling commit() directly floods the activity log
 * and churns storage revisions.
 */
export function useDebouncedCommit(delay = 800): (fn: (doc: NexusDoc) => void) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<((doc: NexusDoc) => void) | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )
  return (fn) => {
    pending.current = fn
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const p = pending.current
      pending.current = null
      timer.current = null
      if (p) commit(p)
    }, delay)
  }
}
