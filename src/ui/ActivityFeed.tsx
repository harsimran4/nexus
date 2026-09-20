// The activity feed — doc.activity has been recorded on every action since
// day one but was never rendered. Read-only component: newest first, actor
// ids resolved to names, verbs humanized, relative timestamps.

import { useMemo, useState } from 'react'
import { useStore } from '../sync/store'
import { statusLabel, type ActivityEvent, type NexusDoc } from '../types/schema'
import { decodeHlc } from '../util/hlc'
import { PageQuote } from './components'

const QUIET_VERBS = new Set(['group.folder', 'project.folder']) // folder bookkeeping is noise

function actorName(doc: NexusDoc, id: string): string {
  if (!id || id === 'anonymous') return 'Someone'
  if (id.startsWith('system:')) return 'Nexus'
  const u = doc.users.app.find((x) => x.id === id)
  if (u) return u.name
  if (id.startsWith('worker:')) return id.slice(7) // legacy sessions pre-uid
  return id
}

function entityName(doc: NexusDoc, ref: string): string {
  return doc.projects[ref]?.name ?? doc.groups[ref]?.name ?? doc.scripts[ref]?.title ?? (ref === 'settings' ? 'settings' : '')
}

function describe(doc: NexusDoc, e: ActivityEvent): string {
  const name = entityName(doc, e.ref)
  const quoted = name ? `"${name}"` : ''
  const meta = e.meta as Record<string, unknown>
  switch (e.verb) {
    case 'group.create': return `created group ${quoted}`
    case 'group.rename': return `renamed a group to "${String(meta.name ?? '')}"`
    case 'group.delete': return `deleted group ${quoted}`
    case 'project.create': return `created project ${quoted}`
    case 'project.update': {
      const fields = Array.isArray(meta.fields) ? meta.fields.join(', ') : ''
      return `updated ${quoted}${fields ? ` (${fields})` : ''}`
    }
    case 'project.status': {
      const from = statusLabel(doc, String(meta.from ?? ''))
      const to = statusLabel(doc, String(meta.to ?? ''))
      return `moved ${quoted}: ${from} → ${to}`
    }
    case 'project.attach': return `attached "${String(meta.fileName ?? 'a file')}" to ${quoted}`
    case 'project.detach': return `unlinked a file from ${quoted}`
    case 'project.file.delete': return `deleted a file from ${quoted}`
    case 'project.delete': return `deleted project ${quoted}`
    case 'project.restore': return `restored project ${quoted}`
    case 'project.purge': return `purged project ${quoted}`
    case 'project.archive': return `archived project ${quoted}`
    case 'project.unarchive': return `moved ${quoted} back to the board`
    case 'project.moveFailed': return `⚠ folder move failed for ${quoted}`
    case 'project.folder': return `created the folder for ${quoted}`
    case 'script.create': return `created script ${quoted}`
    case 'script.status': return `script ${quoted} → ${String(meta.to ?? '')}`
    case 'script.delete': return `deleted script ${quoted}`
    case 'user.create': return `added ${String(meta.name ?? 'a user')} (${String(meta.role ?? '')})`
    case 'user.disable': return `disabled ${String(meta.name ?? 'a user')}`
    case 'user.enable': return `re-enabled ${String(meta.name ?? 'a user')}`
    case 'user.reset': return `reset the login for ${String(meta.name ?? 'a user')}`
    case 'user.delete': return `removed ${String(meta.name ?? 'a user')}`
    case 'user.role': return `changed ${String(meta.name ?? 'a user')}'s role to ${String(meta.role ?? '')}`
    case 'viewer.create': return `minted a viewer token for ${String(meta.name ?? '')}`
    case 'viewer.revoke': return `revoked the viewer token for ${String(meta.name ?? '')}`
    case 'settings.update': return 'updated workspace settings'
    case 'settings.apiKey': return 'rotated the API key override'
    case 'workspace.reset': return 'wiped the workspace data'
    case '*.undelete': return `undeleted ${quoted}`
    default: return e.verb
  }
}

function rel(stamp: string): string {
  const ms = decodeHlc(stamp).ms
  if (!ms) return ''
  const mins = Math.floor((Date.now() - ms) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(ms).toLocaleDateString()
}

export function ActivityFeed({ collapsedCount = 8 }: { collapsedCount?: number }): React.JSX.Element | null {
  const doc = useStore((s) => s.doc)
  const [expanded, setExpanded] = useState(false)

  const events = useMemo(() => {
    if (!doc) return []
    return [...doc.activity].reverse().filter((e) => !QUIET_VERBS.has(e.verb))
  }, [doc])

  if (!doc || events.length === 0) return null
  // The redact-names privacy setting hides people elsewhere; the feed is
  // mostly people, so it hides too.
  if (doc.settings.privacy.redactNames) return null

  const shown = expanded ? events : events.slice(0, collapsedCount)

  return (
    <div className="card">
      <PageQuote topic="activity" />
      <div className="spread mb8">
        <h3 style={{ margin: 0 }}>Recent activity</h3>
        {events.length > collapsedCount && (
          <button className="btn ghost small" onClick={() => setExpanded((x) => !x)}>
            {expanded ? 'Show less' : `Show all (${events.length})`}
          </button>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {shown.map((e, i) => {
          const text = describe(doc, e)
          return (
            <div key={`${e.at}|${e.actor}|${e.verb}|${e.ref}|${i}`} className="row" style={{ alignItems: 'baseline', gap: 8, padding: '4px 6px', borderRadius: 6, background: i % 2 ? 'var(--bg-raised, var(--panel))' : undefined }}>
              <span style={{ fontWeight: 570, fontSize: 13 }}>{actorName(doc, e.actor)}</span>
              <span className="small" style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{text}</span>
              <span className="faint small" style={{ whiteSpace: 'nowrap' }}>{rel(e.at)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
