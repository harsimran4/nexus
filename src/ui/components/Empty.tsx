import type { ReactNode } from 'react'

export function Empty({ icon = '◎', children }: { icon?: string; children: ReactNode }) {
  return (
    <div className="empty">
      <div className="big">{icon}</div>
      <div>{children}</div>
    </div>
  )
}
