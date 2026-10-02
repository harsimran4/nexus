import type { ReactNode } from 'react'
import { useStore } from '../../sync/store'
import { canWrite } from '../../auth/session'
import { Empty } from '../components'

// Static, honest guarantees page. The copy below is FIXED — it is the contract
// between Nexus and its users, including the ugly parts. Render faithfully;
// change behavior, not this text.

type Tone = 'good' | 'bad'

const GUARANTEES: readonly ReactNode[] = [
  <>Editors and admins never hold storage credentials — all writes go through this app's own server functions running on the Worker, which keeps the OCI signing keys as server-side secrets.</>,
  <>Logins are app-issued tokens or passwords. Passwords are stretched in your browser (600,000-round PBKDF2) and only a sha256 of the stretched key is stored.</>,
  <>Sessions are short-lived signed tokens (12h) carrying your identity and role; the server re-checks them against the live user list on every write (~60s staleness).</>,
  <>Reading content requires no account when the workspace is public, but writing always requires a signed-in editor or admin — anonymous and viewer requests are structurally limited to the read-only routes.</>,
  <>Every write is verified against the remote file before commit (etag compare) and merged per-item, so concurrent edits don't clobber each other.</>,
  <>Every deletion is tombstoned so a stale sync can't resurrect it.</>,
  <>Daily snapshots are kept in the bucket (Admin → Maintenance restores them).</>,
  <>Every error names its cause and fix.</>,
]

const NOT_GUARANTEES: readonly ReactNode[] = [
  <>The workspace file (<code>master/nexus.json</code>) is publicly readable so anonymous visitors and viewers can load the app — everything in it, including password hashes, is readable by anyone with the URL. Mitigation: hashes are 600k-stretched; 256-bit tokens are even safer.</>,
  <>Login rate limiting is best-effort (per Cloudflare isolate) — a large distributed brute-force is not stopped by the app alone.</>,
  <>Admin-vs-editor separation is enforced by the signed session token and the server's re-checks — strong, but revocation of an active session can take ~60s to land.</>,
  <>Deletes are eventually-safe (a raced newer edit can beat an older tombstone and is surfaced as an undelete event).</>,
  <>Revoking a viewer lands at their next poll and cannot claw back locally saved copies.</>,
  <>Deleted projects keep their files until Purge in the Archive — between those two moments the files remain in the bucket (but out of the app's index).</>,
]

const ENFORCEMENT: readonly (readonly [ability: string, enforcedBy: ReactNode])[] = [
  ['View without a login', <>nothing when "require login to view" is off (by design: content is publicly served so viewers without accounts can read)</>],
  ['Upload / edit / delete', <>app login (<code>admin|editor</code>) — writes run as server functions that sign OCI requests with credentials only the Worker holds</>],
  ['Admin actions', <>app admin login — the role travels inside the HMAC-signed session token and is re-checked server-side</>],
  ['Direct bucket access', 'only the OCI console / Customer Secret Keys — not this app'],
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
