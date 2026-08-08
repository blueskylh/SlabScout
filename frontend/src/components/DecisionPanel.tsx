import { useI18n } from '../lib/i18n'
import type { Decision } from '../lib/types'
import { StatusPill } from './StatusPill'

function money(value?: number | null) {
  if (value === null || value === undefined) return '—'
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function percent(value?: number | null) {
  if (value === null || value === undefined) return '—'
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`
}

function days(value?: number | null) {
  if (value === null || value === undefined) return '—'
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}d`
}

export function DecisionPanel({ decision, title }: { decision: Decision; title: string }) {
  const { t, pick } = useI18n()
  return (
    <section className="rounded-[28px] border border-border-strong bg-bg-base p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-black text-fg-base">{title}</h2>
          <p className="mt-1 text-sm leading-6 text-fg-subtle">{pick(decision, 'explanation')}</p>
        </div>
        <StatusPill tone={decision.action}>{decision.action}</StatusPill>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-4">
        <div className="decision-metric"><span>{t('decision.metric.ask')}</span><strong>{money(decision.metrics.askUsd)}</strong></div>
        <div className="decision-metric"><span>{t('decision.metric.allowed')}</span><strong>{money(decision.metrics.allowedAskUsd)}</strong></div>
        <div className="decision-metric"><span>{t('decision.metric.discount')}</span><strong>{percent(decision.metrics.discountToMedianPct)}</strong></div>
        <div className="decision-metric"><span>{t('decision.metric.saleAge')}</span><strong>{days(decision.metrics.saleAgeDays)}</strong></div>
      </div>

      <div className="mt-5 overflow-hidden rounded-2xl border border-border-strong">
        <table className="w-full text-left text-sm">
          <thead className="bg-bg-subtle text-xs uppercase tracking-[0.14em] text-fg-muted">
            <tr>
              <th className="px-4 py-3">{t('decision.table.rule')}</th>
              <th className="px-4 py-3">{t('decision.table.status')}</th>
              <th className="px-4 py-3">{t('decision.table.details')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-strong">
            {decision.checks.map((item) => (
              <tr key={item.id} className="bg-bg-base">
                <td className="px-4 py-3 font-bold text-fg-base">{pick(item, 'label')}</td>
                <td className="px-4 py-3"><StatusPill tone={item.status}>{item.status}</StatusPill></td>
                <td className="px-4 py-3 text-fg-subtle">{pick(item, 'details')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
