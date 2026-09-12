import type { ReactNode } from 'react'
import { useStore } from '../../sync/store'
import { canWrite } from '../../auth/session'
import { Empty } from '../components'

// Static, honest guarantees page. The copy below is FIXED — it is the contract
// between Nexus and its users, including the ugly parts. Render faithfully;
// change behavior, not this text.

type Tone = 'good' | 'bad'

const GUARANTEES: readonly ReactNode[] = [
  <>Writes only happen through a signed-in Google token (scope <code>drive.file</code>).</>,
  <>Viewers read through an API key that Google structurally cannot write with.</>,
  <>Every write is verified against the remote file before commit and merged per-item, so concurrent edits don't clobber each other.</>,
  <>Every deletion is tombstoned so a stale sync can't resurrect it.</>,
  <>Daily snapshots are kept on Drive (Admin → Maintenance restores them).</>,
  <>Every error names its cause and fix.</>,
]

const NOT_GUARANTEES: readonly ReactNode[] = [
  <>Viewer login gates the APP, not the data — the API key reads link-shared content anonymously, so a determined viewer can still extract file bytes.</>,
  <>The embedded API key is extractable from the HTML (referrer restriction is advisory; worst case is quota burn — rotate via Admin → Settings).</>,
  <>Admin-vs-editor separation is procedural, not cryptographic (all writers share the studio Google account).</>,
  <>Deletes are eventually-safe (a raced newer edit can beat an older tombstone and is surfaced as an undelete event).</>,
  <>Revoking a viewer lands at their next poll and cannot claw back locally saved copies.</>,
  <>Password hashes live in a link-readable file — use the 256-bit tokens instead.</>,
]

const ENFORCEMENT: readonly (readonly [ability: string, enforcedBy: ReactNode])[] = [
  ['View without a login', <>nothing (by design: data is link-shared so viewers without Google accounts can read)</>],
  ['Upload / edit / delete', <>app login (<code>admin|editor</code>) AND Google bearer token</>],
  ['Admin actions', 'app admin login only'],
  ['True no-download per person', 'only Google Drive sharing per Google account — not this app'],
]

function PointList({ points, tone }: { points: readonly ReactNode[]; tone: Tone }): React.JSX.Element {
  if (points.length === 0) {
    return <Empty icon={tone === 'good' ? '✓' : '✕'}>Nothing listed.</Empty>
  }
  const color = tone === 'good' ? 'var(--green)' : 'var(--red)'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {points.map((point, i) => (
        <div
          key={i}
          className="row"
          style={{
            alignItems: 'flex-start',
            gap: 9,
            background: 'var(--bg-raised)',
            borderLeft: `2px solid ${color}`,
            borderRadius: '0 var(--radius-sm) var(--radius-sm) 0',
            padding: '8px 12px',
          }}
        >
          <span style={{ color, fontWeight: 700 }}>{tone === 'good' ? '✓' : '✕'}</span>
          <span>{point}</span>
        </div>
      ))}
    </div>
  )
}

function EnforcementTable(): React.JSX.Element {
  if (ENFORCEMENT.length === 0) {
    return <Empty icon="§">Nothing to enforce.</Empty>
  }
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Ability</th>
          <th>What enforces it</th>
        </tr>
      </thead>
      <tbody>
        {ENFORCEMENT.map(([ability, enforcedBy]) => (
          <tr key={ability}>
            <td style={{ fontWeight: 550 }}>{ability}</td>
            <td className="muted">{enforcedBy}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function Security(): React.JSX.Element {
  const session = useStore((s) => s.session)
  const writable = canWrite()

  return (
    <div>
      <div className="content-header">
        <div>
          <h1>Security</h1>
          <div className="sub">The honest contract: what Nexus protects, what it cannot, and what enforces each rule.</div>
        </div>
        <span className="badge">{session ? `${session.name} · ${session.role}` : 'not signed in'}</span>
      </div>

      {!writable && (
        <p className="muted small">
          You're {session ? `signed in as ${session.role}` : 'not signed in'} — this page has no actions and reads the same for every role.
        </p>
      )}

      <div className="card mb8">
        <h2>What Nexus guarantees</h2>
        <PointList points={GUARANTEES} tone="good" />
      </div>

      <div className="card mb8">
        <h2>
          What Nexus <span style={{ color: 'var(--red)' }}>does NOT</span> guarantee
        </h2>
        <PointList points={NOT_GUARANTEES} tone="bad" />
      </div>

      <div className="card">
        <h2>How enforcement actually works</h2>
        <EnforcementTable />
      </div>
    </div>
  )
}
