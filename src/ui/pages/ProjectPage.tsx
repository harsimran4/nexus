import { useStore } from '../../sync/store'
import { Empty, PageQuote, StatusBadge } from '../components'
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
      <div className="content-header">
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 8 }}>
            <a href="/" className="faint small">← board</a>
            {group && <a href={`/group/${group.id}`} className="faint small">{group.name} /</a>}
          </div>
          <NameEditor projectId={projectId} name={project.name} />
          <div className="row wrap" style={{ marginTop: 6 }}>
            <select
              className="input"
              style={{ maxWidth: 170, padding: '4px 9px', fontSize: 13 }}
              value={project.status}
              disabled={!canWrite()}
              onChange={(e) => setProjectStatus(projectId, e.target.value)}
            >
              {doc.settings.pipeline.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <StatusBadge doc={doc} status={project.status} />
          </div>
        </div>
        <div className="row">
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
 *  name sits in a manila folder tab: a project IS a folder on Drive. */
function NameEditor({ projectId, name }: { projectId: string; name: string }): React.JSX.Element {
  const writable = canWrite()
  return (
    <div className="project-tab">
      <input
        className="input"
        style={{ fontSize: 20, fontWeight: 650, background: 'none', border: 'none', padding: '2px 0', maxWidth: 620 }}
        defaultValue={name}
        disabled={!writable}
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
