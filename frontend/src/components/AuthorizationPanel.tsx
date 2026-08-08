import { useI18n } from '../lib/i18n'
import type { Authorization } from '../lib/types'

interface Props {
  authorization: Authorization
  onChange: (next: Authorization) => void
}

function numberValue(value: string) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function AuthorizationPanel({ authorization, onChange }: Props) {
  const { t } = useI18n()
  const update = <K extends keyof Authorization>(key: K, value: Authorization[K]) => {
    onChange({ ...authorization, [key]: value })
  }

  return (
    <section className="rounded-[28px] border border-border-strong bg-bg-base p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-black text-fg-base">{t('auth.title')}</h2>
          <p className="mt-1 text-sm leading-6 text-fg-subtle">{t('auth.desc')}</p>
        </div>
        <label className="flex items-center gap-2 rounded-full border border-border-strong px-3 py-2 text-xs font-bold text-fg-subtle">
          <input
            type="checkbox"
            checked={authorization.requireMarketProof}
            onChange={(event) => update('requireMarketProof', event.target.checked)}
          />
          {t('auth.requireProof')}
        </label>
      </div>

      <div className="mt-5 rounded-2xl border border-border-strong bg-bg-chat p-4 text-xs leading-6 text-fg-subtle">
        <div className="font-black uppercase tracking-[0.16em] text-fg-muted">{t('auth.readonlyIdentity')}</div>
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          <ReadOnly label={t('auth.field.card')} value={authorization.targetCard} />
          <ReadOnly label={t('auth.field.cert')} value={authorization.certNumber || '—'} />
          <ReadOnly label={t('auth.field.grade')} value={authorization.gradeLabel || '—'} />
          <ReadOnly label={t('auth.field.itemId')} value={authorization.targetItemId || '—'} mono />
          <ReadOnly label={t('auth.field.proofFeeCap')} value={`${authorization.maxIntelFeeUsdc} USDC`} />
          <ReadOnly label={t('auth.field.depositCap')} value={`${authorization.maxDepositUsdc} / ${authorization.dailyBudgetUsdc} USDC`} />
        </div>
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <label className="field-label">
          {t('auth.input.maxOffer')}
          <input className="field-input" type="number" min="1" value={authorization.maxOfferUsd} onChange={(event) => update('maxOfferUsd', numberValue(event.target.value))} />
        </label>
        <label className="field-label">
          {t('auth.input.medianPct')}
          <input className="field-input" type="number" min="1" max="100" value={authorization.maxPriceVsMedianPct} onChange={(event) => update('maxPriceVsMedianPct', numberValue(event.target.value))} />
        </label>
        <label className="field-label">
          {t('auth.input.minConfidence')}
          <select className="field-input" value={authorization.minConfidence} onChange={(event) => update('minConfidence', event.target.value)}>
            <option value="prime">prime</option>
            <option value="high">high</option>
            <option value="medium">medium</option>
            <option value="low">low</option>
          </select>
        </label>
        <label className="field-label">
          {t('auth.input.sourcesSamples')}
          <div className="grid grid-cols-2 gap-2">
            <input className="field-input" type="number" min="1" value={authorization.minSourceCount} onChange={(event) => update('minSourceCount', numberValue(event.target.value))} />
            <input className="field-input" type="number" min="1" value={authorization.minObservationCount} onChange={(event) => update('minObservationCount', numberValue(event.target.value))} />
          </div>
        </label>
        <label className="field-label">
          {t('auth.input.intelFeeCap')}
          <input className="field-input" type="number" min="0.001" step="0.001" value={authorization.maxIntelFeeUsdc} onChange={(event) => update('maxIntelFeeUsdc', numberValue(event.target.value))} />
        </label>
        <label className="field-label">
          {t('auth.input.depositBudget')}
          <div className="grid grid-cols-2 gap-2">
            <input className="field-input" type="number" min="0.01" step="0.01" value={authorization.maxDepositUsdc} onChange={(event) => update('maxDepositUsdc', numberValue(event.target.value))} />
            <input className="field-input" type="number" min="0.01" step="0.01" value={authorization.dailyBudgetUsdc} onChange={(event) => update('dailyBudgetUsdc', numberValue(event.target.value))} />
          </div>
        </label>
      </div>
    </section>
  )
}

function ReadOnly({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-xl bg-bg-base px-3 py-2">
      <span className="text-fg-muted">{label}: </span>
      <span className={`font-bold text-fg-base ${mono ? 'font-mono text-[10px]' : ''}`}>{value}</span>
    </div>
  )
}
