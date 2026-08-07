import { useEffect, useMemo, useState } from 'react'
import { AuthorizationPanel } from './components/AuthorizationPanel'
import { DecisionPanel } from './components/DecisionPanel'
import { MetricCard } from './components/MetricCard'
import { OfferSelector } from './components/OfferSelector'
import { ProofAndEscrow } from './components/ProofAndEscrow'
import { SignalPanel } from './components/SignalPanel'
import { StatusPill } from './components/StatusPill'
import { Timeline } from './components/Timeline'
import { getDemoConfig, runScout } from './lib/api'
import type { Authorization, DemoConfig, Offer, ScoutRunResult } from './lib/types'

const FALLBACK_AUTHORIZATION: Authorization = {
  targetCard: 'Reshiram & Charizard-GX · Tag All Stars · Japanese · PSA 10',
  targetItemId: '6e7fdc9a-8054-4034-bc02-8fb64209c688',
  targetRenaissItemId: '81d9d2d5-9adf-4f16-9bae-7fafabcce4ae',
  targetHref: '/card/pokemon/tag-all-stars/16-reshiram-charizard-gx-psa-10-japanese-6e7fdc9a',
  certNumber: '80396943',
  company: 'PSA',
  gradeLabel: 'PSA 10',
  maxOfferUsd: 100,
  maxPriceVsMedianPct: 95,
  minConfidence: 'medium',
  minSourceCount: 2,
  minObservationCount: 5,
  maxLastSaleAgeDays: 14,
  maxMethodDeviationPct: 15,
  maxIntelFeeUsdc: 0.01,
  maxDepositUsdc: 0.5,
  dailyBudgetUsdc: 1,
  spentTodayUsdc: 0,
  requireMarketProof: true,
}

const FALLBACK_OFFERS: Offer[] = [
  {
    id: 'offer-reshizard-95',
    title: 'Seller A · verified discount',
    targetCard: 'Reshiram & Charizard-GX · Tag All Stars · Japanese · PSA 10',
    targetItemId: '6e7fdc9a-8054-4034-bc02-8fb64209c688',
    targetRenaissItemId: '81d9d2d5-9adf-4f16-9bae-7fafabcce4ae',
    targetHref: '/card/pokemon/tag-all-stars/16-reshiram-charizard-gx-psa-10-japanese-6e7fdc9a',
    certNumber: '80396943',
    company: 'PSA',
    gradeLabel: 'PSA 10',
    askUsd: 95,
    depositUsdc: 0.1,
    sellerAddress: '0x5000000000000000000000000000000000000001',
    expiresAt: '2030-08-09T10:00:00.000Z',
    imageConfidence: 'high',
    certFound: true,
    narrative: '真实 PSA cert 80396943 对应 Reshiram & Charizard-GX PSA 10，报价低于授权阈值。',
  },
]

export default function App() {
  const [demo, setDemo] = useState<DemoConfig | null>(null)
  const [authorization, setAuthorization] = useState<Authorization>(FALLBACK_AUTHORIZATION)
  const [selectedOfferId, setSelectedOfferId] = useState(FALLBACK_OFFERS[0].id)
  const [mode, setMode] = useState<'replay' | 'live'>('replay')
  const [result, setResult] = useState<ScoutRunResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getDemoConfig()
      .then((config) => {
        if (cancelled) return
        setDemo(config)
        setAuthorization(config.defaultAuthorization)
        setSelectedOfferId(config.offers[0]?.id || FALLBACK_OFFERS[0].id)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => { cancelled = true }
  }, [])

  const offers = demo?.offers || FALLBACK_OFFERS
  const selectedOffer = useMemo(() => offers.find((offer) => offer.id === selectedOfferId) || offers[0], [offers, selectedOfferId])

  async function execute() {
    if (!selectedOffer) return
    setLoading(true)
    setError(null)
    try {
      const next = await runScout({ mode, offerId: selectedOffer.id, authorization })
      setResult(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const signal = result?.signal || demo?.replaySignal
  const finalAction = result?.finalDecision.action || 'INVESTIGATE'

  return (
    <main className="min-h-screen bg-bg-chat text-fg-base">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6 md:px-8 md:py-10">
        <header className="overflow-hidden rounded-[32px] border border-border-strong bg-bg-base p-6 shadow-sm md:p-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <div className="mb-4 flex flex-wrap gap-2">
                <StatusPill tone={result ? finalAction : 'READY'}>{result ? finalAction : 'READY'}</StatusPill>
                <StatusPill tone="warn">Arc Testnet</StatusPill>
                <StatusPill tone="pass">Renaiss backend-only</StatusPill>
              </div>
              <h1 className="text-4xl font-black tracking-tight text-fg-base md:text-6xl">
                SlabScout<span className="text-brand-100">.</span>
              </h1>
              <p className="mt-4 max-w-2xl text-lg leading-8 text-fg-subtle">
                一个会先买市场证明、再自主锁定卡牌交易订金的 USDC 代理。用户只授权一次，之后由确定性规则引擎决定是否支付。
              </p>
            </div>
            <div className="flex flex-col gap-3 rounded-3xl border border-border-strong bg-bg-chat p-4 md:min-w-80">
              <div className="grid grid-cols-2 gap-2 rounded-2xl bg-bg-subtle p-1">
                {(['replay', 'live'] as const).map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => {
                      setMode(item)
                      setResult(null)
                    }}
                    className={`rounded-xl px-4 py-2 text-sm font-black transition ${mode === item ? 'bg-bg-base text-brand-100 shadow-sm' : 'text-fg-subtle hover:text-fg-base'}`}
                  >
                    {item.toUpperCase()}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={execute}
                disabled={loading}
                className="rounded-2xl bg-brand-100 px-5 py-3 text-sm font-black text-white shadow-lg shadow-pink-500/20 transition hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loading ? 'Agent running…' : 'Run SlabScout Agent'}
              </button>
              <p className="text-xs leading-5 text-fg-subtle">Live 会优先请求 Renaiss；非证书类故障会进入 REPLAY_FALLBACK，但真实支付/锁仓会被禁止。</p>
            </div>
          </div>
        </header>

        {error ? (
          <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-sm font-bold text-red-600">{error}</div>
        ) : null}

        <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
          <MetricCard label="Proof fee" value="0.001 USDC" helper="Circle nanopayment demo adapter" />
          <MetricCard label="Demo deposit" value={`${selectedOffer?.depositUsdc || 0.1} USDC`} helper="Arc escrow reserve amount" />
          <MetricCard label="Offer ask" value={`$${selectedOffer?.askUsd || 0}`} helper={selectedOffer?.title || 'Seller offer'} />
          <MetricCard label="Policy" value="V1.1" helper={`Decision: ${finalAction}`} />
          <MetricCard label="Execution" value={result?.executionStatus || 'not-started'} helper="separate from policy decision" />
        </section>

        <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
          <AuthorizationPanel authorization={authorization} onChange={(next) => {
            setAuthorization(next)
            setResult(null)
          }} />
          <OfferSelector offers={offers} selectedOfferId={selectedOfferId} onSelect={(id) => {
            setSelectedOfferId(id)
            setResult(null)
          }} />
        </div>

        {signal ? <SignalPanel signal={signal} /> : null}

        {result ? (
          <>
            <Timeline items={result.timeline} />
            <DecisionPanel decision={result.preliminary} title="规则初判" />
            <ProofAndEscrow payment={result.payment} proof={result.proof} escrow={result.escrow} />
            <DecisionPanel decision={result.finalDecision} title="规则复判" />
            <section className="rounded-[28px] border border-border-strong bg-bg-base p-5 shadow-sm">
              <h2 className="text-lg font-black text-fg-base">审计凭证</h2>
              <p className="mt-1 text-sm leading-6 text-fg-subtle">每次运行保留 policyVersion、规则结果、MarketProof 哈希和 Arc 交易哈希，便于复盘。</p>
              <pre className="mt-4 overflow-auto rounded-2xl bg-neutral-950 p-4 text-xs leading-6 text-neutral-50">{JSON.stringify(result.audit, null, 2)}</pre>
            </section>
          </>
        ) : (
          <section className="rounded-[28px] border border-dashed border-border-contrast bg-bg-base p-8 text-center shadow-sm">
            <h2 className="text-xl font-black text-fg-base">准备运行第一条代理决策</h2>
            <p className="mt-2 text-sm leading-6 text-fg-subtle">选择 Seller A 展示 RESERVE 主路径；选择 Seller B 或 C 展示拒绝路径。</p>
          </section>
        )}

        <footer className="rounded-[24px] border border-border-strong bg-bg-base p-5 text-sm leading-7 text-fg-subtle">
          <strong className="text-fg-base">Demo disclosure:</strong> Renaiss API key/secret 仅放在 backend env；Arc 当前按 Testnet 展示，Circle/Arc 默认使用 deterministic mock/replay adapter；mock/replay 不会展示为真实 paid、reserved、tx hash 或 explorer evidence。
          {signal?.card.pageUrl ? <a className="ml-2 font-bold text-brand-100" href={signal.card.pageUrl} target="_blank" rel="noreferrer">Open Renaiss card page</a> : null}
        </footer>
      </div>
    </main>
  )
}
