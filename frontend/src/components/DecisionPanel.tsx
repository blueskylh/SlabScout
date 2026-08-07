import type { Decision } from '../lib/types'
import { StatusPill } from './StatusPill'

function money(value?: number | null) {
  if (value === null || value === undefined) return '—'
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function DecisionPanel({ decision, title }: { decision: Decision; title: string }) {
  return (
    <section className="rounded-[28px] border border-border-strong bg-bg-base p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-black text-fg-base">{title}</h2>
          <p className="mt-1 text-sm leading-6 text-fg-subtle">{decision.explanation}</p>
        </div>
        <StatusPill tone={decision.action}>{decision.action}</StatusPill>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-4">
        <div className="decision-metric"><span>Ask</span><strong>{money(decision.metrics.askUsd)}</strong></div>
        <div className="decision-metric"><span>Allowed</span><strong>{money(decision.metrics.allowedAskUsd)}</strong></div>
        <div className="decision-metric"><span>Discount</span><strong>{decision.metrics.discountToMedianPct ?? '—'}%</strong></div>
        <div className="decision-metric"><span>Sale age</span><strong>{decision.metrics.saleAgeDays ?? '—'}d</strong></div>
      </div>

      <div className="mt-5 overflow-hidden rounded-2xl border border-border-strong">
        <table className="w-full text-left text-sm">
          <thead className="bg-bg-subtle text-xs uppercase tracking-[0.14em] text-fg-muted">
            <tr>
              <th className="px-4 py-3">规则</th>
              <th className="px-4 py-3">状态</th>
              <th className="px-4 py-3">细节</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-strong">
            {decision.checks.map((item) => (
              <tr key={item.id} className="bg-bg-base">
                <td className="px-4 py-3 font-bold text-fg-base">{item.label}</td>
                <td className="px-4 py-3"><StatusPill tone={item.status}>{item.status}</StatusPill></td>
                <td className="px-4 py-3 text-fg-subtle">{item.details}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
