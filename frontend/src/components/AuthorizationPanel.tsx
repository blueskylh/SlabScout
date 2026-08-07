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
  const update = <K extends keyof Authorization>(key: K, value: Authorization[K]) => {
    onChange({ ...authorization, [key]: value })
  }

  return (
    <section className="rounded-[28px] border border-border-strong bg-bg-base p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-black text-fg-base">一次性采购授权</h2>
          <p className="mt-1 text-sm leading-6 text-fg-subtle">代理只能在这些边界内购买 MarketProof 和锁定 USDC 订金。</p>
        </div>
        <label className="flex items-center gap-2 rounded-full border border-border-strong px-3 py-2 text-xs font-bold text-fg-subtle">
          <input
            type="checkbox"
            checked={authorization.requireMarketProof}
            onChange={(event) => update('requireMarketProof', event.target.checked)}
          />
          Require Proof
        </label>
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <label className="field-label">
          最高报价 USD
          <input className="field-input" type="number" min="1" value={authorization.maxOfferUsd} onChange={(event) => update('maxOfferUsd', numberValue(event.target.value))} />
        </label>
        <label className="field-label">
          中位价折扣阈值 %
          <input className="field-input" type="number" min="1" max="100" value={authorization.maxPriceVsMedianPct} onChange={(event) => update('maxPriceVsMedianPct', numberValue(event.target.value))} />
        </label>
        <label className="field-label">
          最小置信度
          <select className="field-input" value={authorization.minConfidence} onChange={(event) => update('minConfidence', event.target.value)}>
            <option value="prime">prime</option>
            <option value="high">high</option>
            <option value="medium">medium</option>
            <option value="low">low</option>
          </select>
        </label>
        <label className="field-label">
          来源数 / 样本数
          <div className="grid grid-cols-2 gap-2">
            <input className="field-input" type="number" min="1" value={authorization.minSourceCount} onChange={(event) => update('minSourceCount', numberValue(event.target.value))} />
            <input className="field-input" type="number" min="1" value={authorization.minObservationCount} onChange={(event) => update('minObservationCount', numberValue(event.target.value))} />
          </div>
        </label>
        <label className="field-label">
          单次情报费上限 USDC
          <input className="field-input" type="number" min="0.001" step="0.001" value={authorization.maxIntelFeeUsdc} onChange={(event) => update('maxIntelFeeUsdc', numberValue(event.target.value))} />
        </label>
        <label className="field-label">
          订金 / 日预算 USDC
          <div className="grid grid-cols-2 gap-2">
            <input className="field-input" type="number" min="0.01" step="0.01" value={authorization.maxDepositUsdc} onChange={(event) => update('maxDepositUsdc', numberValue(event.target.value))} />
            <input className="field-input" type="number" min="0.01" step="0.01" value={authorization.dailyBudgetUsdc} onChange={(event) => update('dailyBudgetUsdc', numberValue(event.target.value))} />
          </div>
        </label>
      </div>
    </section>
  )
}
