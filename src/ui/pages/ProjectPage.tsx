import { useStore } from '../../sync/store'
import { Empty, PageQuote } from '../components'
import { canWrite } from '../../auth/session'
import { setProjectStatus, updateProject } from '../../state/actions'
import { useMediaView } from './project/mediaView'
import { MediaTab } from './project/MediaTab'
import { ScriptsTab } from './project/ScriptsTab'
import { SettingsTab } from './project/SettingsTab'

const TABS: { id: 'media' | 'scripts' | 'settings'; label: string }[] = [
  { id: 'media', label: 'Media' },
  { id: 'scripts', label: 'Scripts' },
  { id: 'settings', label: 'Settings' },
]

export function ProjectPage({ projectId }: { projectId: string }): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const { view, setTab } = useMediaView()
  const project = doc?.projects[projectId]

  if (!doc || !project || project.deleted !== null) {
    return (
      <Empty icon="▦">
        This project doesn't exist or was deleted. <a href="/">Back to board</a>
      </Empty>
    )
  }

  const group = doc.groups[project.groupId]

  return (
    <div>
      {/* One line: back · group › nameplate · status · tabs. The select IS
          the status display (the old select+badge pair said it twice). */}
      <div className="content-header project-head">
        <a href="/" className="faint small project-head-back">← board</a>
        {group && (
          <>
            <a href={`/group/${group.id}`} className="faint small project-head-crumb">{group.name}</a>
            <span className="project-head-sep faint" aria-hidden="true">›</span>
          </>
        )}
        <NameEditor projectId={projectId} name={project.name} />
        <select
          className="input project-head-status"
          value={project.status}
          disabled={!canWrite()}
          onChange={(e) => setProjectStatus(projectId, e.target.value)}
          aria-label="Project status"
        >
          {doc.settings.pipeline.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <div className="row project-head-tabs">
          {TABS.map((t) => (
            <button key={t.id} className={`chip ${view.tab === t.id ? 'on' : ''}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <PageQuote topic="project" />

      {view.tab === 'media' && <MediaTab projectId={projectId} />}
      {view.tab === 'scripts' && <ScriptsTab projectId={projectId} />}
      {view.tab === 'settings' && <SettingsTab projectId={projectId} />}
    </div>
  )
}

/** Inline-editable project name — renames the Drive subfolder to match. The
 *  name sits in a compact manila nameplate: a project IS a folder on Drive.
 *  `size` (not CSS) gives the input its intrinsic width so the plate hugs
 *  short names and gives up space gracefully when the row gets tight. */
function NameEditor({ projectId, name }: { projectId: string; name: string }): React.JSX.Element {
  const writable = canWrite()
  return (
    <div className="project-tab">
      <input
        className="input"
        size={Math.min(42, Math.max(6, name.length + 1))}
        defaultValue={name}
        disabled={!writable}
        aria-label="Project name"
        onBlur={(e) => {
          const v = e.target.value.trim()
          if (!v || v === name) {
            e.target.value = name
            return
          }
          // Doc-only: the storage prefix (…/<projectId>/) never changes.
          updateProject(projectId, { name: v })
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
      />
    </div>
  )
}
