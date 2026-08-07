import type { ReactNode } from 'react'

export function MetricCard({ label, value, helper }: { label: string; value: ReactNode; helper?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-border-strong bg-bg-base p-4 shadow-sm">
      <div className="text-xs font-bold uppercase tracking-[0.18em] text-fg-muted">{label}</div>
      <div className="mt-2 text-2xl font-black text-fg-base">{value}</div>
      {helper ? <div className="mt-1 text-xs leading-5 text-fg-subtle">{helper}</div> : null}
    </div>
  )
}
