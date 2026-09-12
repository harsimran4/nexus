import { Empty } from '../components'

export function Setup({ title, message }: { title: string; message: string }): React.JSX.Element {
  return (
    <div className="card">
      <Empty icon="⚠">
        <h2>{title}</h2>
        <p style={{ maxWidth: 460, margin: '8px auto 0' }} className="muted">{message}</p>
      </Empty>
    </div>
  )
}
