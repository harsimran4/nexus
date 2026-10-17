import { Empty } from '../components'

/** A full-screen state card. `stamp` renders the state as a badge label
 *  (red for blocked, neutral otherwise). */
export function Setup({ title, message, stamp, tone = 'ink' }: { title: string; message: string; stamp?: string; tone?: 'red' | 'ink' }): React.JSX.Element {
  return (
    <div className="card">
      <Empty icon="⚠">
        {stamp && <div className="mt8"><span className={`badge ${tone === 'red' ? 'red' : ''}`}>{stamp}</span></div>}
        <h2>{title}</h2>
        <p style={{ maxWidth: 460, margin: '8px auto 0' }} className="muted">{message}</p>
      </Empty>
    </div>
  )
}
