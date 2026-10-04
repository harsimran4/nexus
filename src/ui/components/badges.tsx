import { statusBucket, statusLabel, type NexusDoc } from '../../types/schema'

export function StatusBadge({ doc, status }: { doc: NexusDoc; status: string }) {
  const bucket = statusBucket(doc, status)
  return <span className={`badge ${bucket}`}>{statusLabel(doc, status)}</span>
}

export function KindBadge({ kind }: { kind: string }) {
  return <span className="badge kind">{kind}</span>
}
