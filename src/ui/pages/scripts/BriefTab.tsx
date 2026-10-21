// The Creative Brief — concept, premise, themes, audience, tone, mood, goals.
// Fields ride the script record and commit on blur (the title-input house
// pattern — no debounce, since a pending debounce across DIFFERENT fields
// would drop all but the last); inspiration attaches at brief level as story
// links from the script itself (rel: 'inspires').

import { useStore } from '../../../sync/store'
import type { Script, ScriptBrief } from '../../../types/schema'
import { useCanWrite } from '../../../auth/session'
import { createStoryLink, updateScriptBrief } from '../../../state/actions'
import { Icon, Menu, MenuItem, toast } from '../../components'
import { LinkRows } from './fields'
import { navigate } from '../../../nav'

const BRIEF_FIELDS: { key: keyof ScriptBrief; label: string; placeholder: string; rows: number }[] = [
  { key: 'concept', label: 'Concept', placeholder: 'What are you trying to express? The one-line heart of the film…', rows: 3 },
  { key: 'premise', label: 'Premise', placeholder: 'The setup: who wants what, and what stands in the way…', rows: 3 },
  { key: 'themes', label: 'Themes', placeholder: 'What ideas run underneath?…', rows: 2 },
  { key: 'audience', label: 'Audience', placeholder: 'Who is this for?…', rows: 2 },
  { key: 'tone', label: 'Tone', placeholder: 'How does it feel — wry, earnest, dread-soaked?…', rows: 2 },
  { key: 'mood', label: 'Mood', placeholder: 'What should the room feel like while watching?…', rows: 2 },
  { key: 'goals', label: 'Creative goals', placeholder: 'What should this piece prove, test or reach?…', rows: 3 },
]

export function BriefTab({ script }: { script: Script }): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const writable = useCanWrite()

  if (!doc) return <></>

  const brief = script.brief
  const links = (doc.storyLinks ?? []).filter((l) => !l.deleted && l.scriptId === script.id && l.fromKind === 'script')
  const projectRefs = (doc.refs ?? []).filter((r) => !r.deleted && (script.projectId ? r.projectId === script.projectId : true))

  const attachRef = (refId: string): void => {
    try {
      createStoryLink({ scriptId: script.id, from: { kind: 'script', id: script.id }, to: { kind: 'ref', id: refId }, rel: 'inspires' })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not attach')
    }
  }

  return (
    <div className="brief-wrap">
      <div className="card brief-sheet">
        <div className="brief-grid">
          {BRIEF_FIELDS.map((f) => (
            <label key={f.key} className="story-field">
              <span className="story-field-label">{f.label}</span>
              <textarea
                className="input"
                rows={f.rows}
                defaultValue={brief?.[f.key] ?? ''}
                placeholder={f.placeholder}
                disabled={!writable}
                onBlur={(e) => {
                  if (e.target.value !== (brief?.[f.key] ?? '')) updateScriptBrief(script.id, { [f.key]: e.target.value })
                }}
              />
            </label>
          ))}
        </div>
        <span className="faint small">Fields save as you leave them — no button to press.</span>
      </div>

      <div className="card brief-inspo">
        <div className="spread mb8">
          <h3 style={{ margin: 0 }}>Inspiration</h3>
          {writable && (
            <Menu
              label="Attach inspiration"
              trigger={(p) => (
                <button {...p} className="btn small">
                  <Icon name="link" size={13} /> Attach
                </button>
              )}
            >
              {projectRefs.length === 0 ? (
                <MenuItem
                  icon="external"
                  disabled={!script.projectId}
                  onSelect={() => {
                    if (script.projectId) navigate(`/project/${script.projectId}?tab=refs`)
                  }}
                >
                  {script.projectId ? 'Save a reference first…' : 'Link the script to a project first'}
                </MenuItem>
              ) : (
                projectRefs.map((r) => (
                  <MenuItem key={r.id} icon="link" onSelect={() => attachRef(r.id)}>
                    {r.title || r.url}
                  </MenuItem>
                ))
              )}
            </Menu>
          )}
        </div>
        <LinkRows doc={doc} links={links} emptyText="Nothing attached yet — the project's References can inspire the whole film; they also appear as graph nodes." disabled={!writable} />
      </div>
    </div>
  )
}
