import { useI18n } from '../lib/i18n'
import type { Signal } from '../lib/types'
import { MetricCard } from './MetricCard'
import { StatusPill } from './StatusPill'

function money(value?: number | null) {
  if (value === null || value === undefined) return '—'
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function dateLabel(value?: string | null) {
  if (!value) return 'unknown'
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString() : 'unknown'
}

export function SignalPanel({ signal }: { signal: Signal }) {
  const { t } = useI18n()
  const medianLine = signal.trend.find((line) => line.method === 'median')
  const points = medianLine?.points || []
  const values = points.map((point) => point.usd)
  const min = values.length ? Math.min(...values) : 0
  const max = values.length ? Math.max(...values) : 1
  const span = max - min || 1
  const path = points.map((point, index) => {
    const x = (index / Math.max(points.length - 1, 1)) * 100
    const y = 42 - ((point.usd - min) / span) * 34
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
  }).join(' ')

  return (
    <section className="rounded-[28px] border border-border-strong bg-bg-base p-5 shadow-sm">
      <div className="flex flex-col gap-5 lg:flex-row">
        <div className="lg:w-56">
          <div className="overflow-hidden rounded-3xl border border-border-strong bg-bg-chat">
            {signal.card.imageUrl ? <img src={signal.card.imageUrl} alt={signal.card.name} className="h-72 w-full object-cover" /> : null}
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-xs font-bold uppercase tracking-[0.18em] text-fg-muted">Renaiss OS Index</div>
              <h2 className="mt-1 text-2xl font-black text-fg-base">{signal.card.name} · {signal.card.gradeLabel}</h2>
              <p className="mt-1 text-sm leading-6 text-fg-subtle">{signal.card.setName} · {signal.card.language}</p>
            </div>
            <div className="flex gap-2">
              <StatusPill tone={signal.quality.confidence === 'prime' ? 'pass' : 'warn'}>{signal.quality.confidence}</StatusPill>
              <StatusPill tone={signal.identity.certMatchesOffer ? 'pass' : 'fail'}>{signal.identity.certMatchesOffer ? 'cert match' : 'cert fail'}</StatusPill>
              <StatusPill tone={signal.quality.refreshing ? 'warn' : 'pass'}>{signal.quality.refreshing ? 'refreshing' : 'fresh'}</StatusPill>
            </div>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard label="7D Median" value={money(signal.valuation.medianUsd)} helper={t('signal.median.helper')} />
            <MetricCard label="Mean" value={money(signal.valuation.meanUsd)} helper={t('signal.mean.helper')} />
            <MetricCard label="VWAP" value={money(signal.valuation.vwapUsd)} helper={t('signal.vwap.helper')} />
            <MetricCard label="Sources / Obs" value={`${signal.quality.sourceCount} / ${signal.quality.observationCount}`} helper={t('signal.lastSale', { date: dateLabel(signal.quality.lastSaleAt) })} />
          </div>

          <div className="mt-5 rounded-2xl border border-border-strong bg-bg-chat p-4">
            <div className="flex items-center justify-between text-xs font-bold uppercase tracking-[0.18em] text-fg-muted">
              <span>30D Median Trend</span>
              <span>{signal.dataMode}</span>
            </div>
            <svg viewBox="0 0 100 46" className="mt-3 h-28 w-full overflow-visible">
              <path d={path} fill="none" stroke="var(--brand-100)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              {points.map((point, index) => {
                const x = (index / Math.max(points.length - 1, 1)) * 100
                const y = 42 - ((point.usd - min) / span) * 34
                return <circle key={point.t} cx={x} cy={y} r={index === points.length - 1 ? 2.2 : 1.4} fill="var(--brand-100)" />
              })}
            </svg>
          </div>
        </div>
      </div>
    </section>
  )
}
