import { Empty } from '../components'

/** A full-screen state card. `stamp` renders a rubber-stamp label (states
 *  read as stamps on paper); tone picks red (blocked) or ink. */
export function Setup({ title, message, stamp, tone = 'ink' }: { title: string; message: string; stamp?: string; tone?: 'red' | 'ink' }): React.JSX.Element {
  return (
    <div className="card">
      <Empty icon="⚠">
        {stamp && <div><span className={`stamp ${tone === 'red' ? 'stamp-red' : 'stamp-ink'}`}>{stamp}</span></div>}
        <h2>{title}</h2>
        <p style={{ maxWidth: 460, margin: '8px auto 0' }} className="muted">{message}</p>
      </Empty>
    </div>
  )
}
