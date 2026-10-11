import type { Group, NexusDoc, Project } from '../../../types/schema'

/** Props every board view receives from Dashboard — the filtered/sorted
 *  project list and the callbacks the header owns. Views own their own
 *  drag state (only the ones with drop targets need any). */
export interface BoardViewProps {
  doc: NexusDoc
  projects: Project[]
  groups: Group[]
  colorByGroup: Record<string, string>
  writable: boolean
  /** Header "+" buttons — status presets the pipeline column, group presets
   *  the quick-add group select (shelf "+", or the active group filter). */
  onQuickAdd: (status?: string, groupId?: string) => void
  onOpen: (projectId: string) => void
  onOpenGroup: (groupId: string) => void
}
