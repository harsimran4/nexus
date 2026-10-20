import { useState } from 'react'
import { setProjectStatus } from '../../../state/actions'

/** Shared HTML5 drag state for the board views with drop targets (Columns,
 *  Lanes — any future status-geography view). Spread `bandDragProps(status)`
 *  onto each drop container; pass `isOver`/`dragging` to class and card
 *  props. The mutation (setProjectStatus) lives here so every view moves
 *  cards identically. */
export function useBoardDrag(writable: boolean, projects: Record<string, { status: string } | undefined>) {
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)

  const onDragStart = (id: string) => setDragId(id)
  const onDragEnd = () => {
    setDragId(null)
    setDragOver(null)
  }

  /** Spread onto a drop container keyed by pipeline-stage id. */
  const bandDragProps = (status: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!writable || dragId === null) return
      e.preventDefault()
      setDragOver(status)
    },
    onDragLeave: () => setDragOver((c) => (c === status ? null : c)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      if (dragId && writable) {
        const p = projects[dragId]
        if (p && p.status !== status) setProjectStatus(dragId, status)
      }
      onDragEnd()
    },
  })

  return { dragId, dragOver, onDragStart, onDragEnd, bandDragProps }
}
