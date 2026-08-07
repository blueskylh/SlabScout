import { type ComponentType, type FormEvent, type ReactNode, lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { EChartsOption } from 'echarts'
import {
  Activity,
  BadgeCheck,
  BarChart3,
  Camera,
  CheckCircle2,
  Clock3,
  ExternalLink,
  LineChart,
  Loader2,
  Search,
  ShieldCheck,
  Sparkles,
  Star,
  TrendingDown,
  TrendingUp,
  WalletCards,
} from 'lucide-react'
import {
  type BootstrapResponse,
  type CardDetailBundle,
  type CardSummary,
  type GameSlug,
  type GradedLookup,
  type IndexBundle,
  type IndexSeriesPoint,
  type IndexTile,
  type RateLimit,
  type SearchGameSlug,
  type SourceBreakdownEntry,
  type TradeRow,
  renaiss,
} from './lib/renaiss'

const GAME_LABELS: Record<GameSlug, string> = {
  pokemon: 'Pokémon',
  'one-piece': 'One Piece',
  sports: 'Sports',
}

const GAME_ORDER: GameSlug[] = ['pokemon', 'one-piece', 'sports']
const INDEX_WINDOWS = [30, 90, 365, 1095]
const CARD_WINDOWS = [30, 90, 365]
const SEARCH_GAMES: Array<SearchGameSlug | 'all'> = ['all', 'pokemon', 'one-piece', 'sports', 'digimon', 'mtg', 'yugioh', 'lorcana']
const ReactECharts = lazy(() => import('echarts-for-react'))

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const currency2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })

function formatUsdCents(cents?: number | null, decimals = 0) {
  if (cents === undefined || cents === null || Number.isNaN(cents)) return '—'
  return decimals > 0 ? currency2.format(cents / 100) : currency.format(cents / 100)
}

function formatCompactUsdCents(cents?: number | null) {
  if (cents === undefined || cents === null || Number.isNaN(cents)) return '—'
  return `$${compact.format(cents / 100)}`
}

function formatPct(value?: number | null) {
  if (value === undefined || value === null || Number.isNaN(value)) return '—'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(Math.abs(value) >= 100 ? 0 : 2)}%`
}

function formatIndexValue(value?: number | null) {
  if (value === undefined || value === null || Number.isNaN(value)) return '—'
  return numberFormat.format(value)
}

function formatDate(value?: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function timeAgo(value?: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  const seconds = Math.max(1, Math.floor((Date.now() - date.getTime()) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function deltaTone(value?: number | null) {
  if (value === undefined || value === null) return 'neutral'
  if (value > 0) return 'up'
  if (value < 0) return 'down'
  return 'neutral'
}

function confidenceTone(value?: string | null) {
  const normalized = String(value || '').toLowerCase()
  if (['prime', 'high', 'very_high'].includes(normalized)) return 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20'
  if (['medium', 'ok'].includes(normalized)) return 'bg-amber-500/10 text-amber-600 border-amber-500/20'
  return 'bg-[var(--bg-subtle)] text-[var(--fg-subtle)] border-[var(--border-strong)]'
}

function hasErrors(errors?: Record<string, string>) {
  return Boolean(errors && Object.keys(errors).length > 0)
}

function bestRateLimit(data?: BootstrapResponse, health?: RateLimit) {
  const limits = [health, ...Object.values(data?.rateLimits || {})].filter(Boolean) as RateLimit[]
  return limits.find((item) => item.remaining !== undefined) || limits[0]
}

function gameLabel(game?: string | null) {
  if (!game) return 'Unknown'
  return GAME_LABELS[game as GameSlug] || game.replace(/-/g, ' ')
}

function CardImage({ src, alt, className = '' }: { src?: string | null; alt: string; className?: string }) {
  const [failed, setFailed] = useState(false)
  if (!src || failed) {
    return (
      <div className={`flex items-center justify-center bg-gradient-to-br from-[var(--brand-10)] to-[var(--bg-subtle)] text-[var(--fg-muted)] ${className}`}>
        <WalletCards className="h-8 w-8" />
      </div>
    )
  }

  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      className={`object-cover ${className}`}
    />
  )
}

function DeltaBadge({ value, compact: compactBadge = false }: { value?: number | null; compact?: boolean }) {
  const tone = deltaTone(value)
  const toneClass = tone === 'up'
    ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20'
    : tone === 'down'
      ? 'bg-rose-500/10 text-rose-600 border-rose-500/20'
      : 'bg-[var(--bg-subtle)] text-[var(--fg-subtle)] border-[var(--border-strong)]'
  const Icon = tone === 'down' ? TrendingDown : TrendingUp
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs font-bold ${toneClass}`}>
      {tone !== 'neutral' && <Icon className="h-3 w-3" />}
      {compactBadge ? formatPct(value).replace('%', '') : formatPct(value)}
    </span>
  )
}

function SectionCard({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-[28px] border border-[var(--border-strong)] bg-[var(--bg-base)] shadow-[0_24px_80px_rgba(0,0,0,0.04)] backdrop-blur ${className}`}>
      {children}
    </section>
  )
}

function PanelHeader({ icon: Icon, title, subtitle, action }: { icon: ComponentType<{ className?: string }>; title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-strong)] px-5 py-4">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[var(--brand-10)] text-[var(--brand-100)]">
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-base font-black text-[var(--fg-base)]">{title}</h2>
          {subtitle && <p className="text-xs text-[var(--fg-subtle)]">{subtitle}</p>}
        </div>
      </div>
      {action}
    </div>
  )
}

function LoadingBlock({ label = 'Loading market data…' }: { label?: string }) {
  return (
    <div className="flex min-h-[180px] items-center justify-center gap-2 text-sm text-[var(--fg-subtle)]">
      <Loader2 className="h-4 w-4 animate-spin text-[var(--brand-100)]" />
      {label}
    </div>
  )
}

function ErrorNotice({ message }: { message?: string }) {
  return (
    <div className="rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-600">
      {message || 'Data source temporarily unavailable. Please retry in a moment.'}
    </div>
  )
}

function ChartCanvas({ option, height }: { option: EChartsOption; height: number }) {
  return (
    <Suspense fallback={<div className="animate-pulse rounded-2xl bg-[var(--bg-subtle)]" style={{ height }} />}>
      <ReactECharts option={option} style={{ height, width: '100%' }} opts={{ renderer: 'svg' }} />
    </Suspense>
  )
}

function SparklineChart({ values, positive, height = 70 }: { values: Array<number | null | undefined>; positive?: boolean; height?: number }) {
  const clean = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  if (clean.length < 2) return <div className="h-[70px] rounded-2xl bg-[var(--bg-subtle)]" />
  const lineColor = positive ? '#10b981' : '#fd4b96'
  const option: EChartsOption = {
    animation: false,
    grid: { left: 0, right: 0, top: 4, bottom: 0 },
    xAxis: { type: 'category', show: false, data: clean.map((_, index) => index) },
    yAxis: { type: 'value', show: false, scale: true },
    series: [{
      type: 'line',
      data: clean,
      smooth: true,
      showSymbol: false,
      lineStyle: { width: 2, color: lineColor },
      areaStyle: { color: positive ? 'rgba(16,185,129,0.12)' : 'rgba(253,75,150,0.12)' },
    }],
    tooltip: { show: false },
  }
  return <ChartCanvas option={option} height={height} />
}

function IndexChart({ points }: { points?: IndexSeriesPoint[] }) {
  const data = points || []
  if (data.length < 2) return <LoadingBlock label="Waiting for index series…" />

  const option: EChartsOption = {
    animationDuration: 420,
    color: ['#ff2882', '#6366f1'],
    grid: { left: 46, right: 18, top: 24, bottom: 36 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(16,16,16,0.92)',
      borderColor: 'rgba(255,255,255,0.08)',
      textStyle: { color: '#fff' },
      formatter: (params: any) => {
        const rows = Array.isArray(params) ? params : [params]
        const date = rows[0]?.axisValue || ''
        return [date, ...rows.map((row: any) => `${row.marker} ${row.seriesName}: ${row.seriesName === 'Turnover' ? `$${compact.format(Number(row.value || 0))}` : numberFormat.format(Number(row.value || 0))}`)].join('<br/>')
      },
    },
    legend: { bottom: 0, textStyle: { color: '#7a7a7a' } },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      axisLine: { lineStyle: { color: 'rgba(122,122,122,0.25)' } },
      axisLabel: { color: '#7a7a7a' },
      data: data.map((item) => new Date(item.t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })),
    },
    yAxis: [
      { type: 'value', scale: true, axisLabel: { color: '#7a7a7a' }, splitLine: { lineStyle: { color: 'rgba(122,122,122,0.12)' } } },
      { type: 'value', show: false, scale: true },
    ],
    series: [
      {
        name: 'Index',
        type: 'line',
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 3, color: '#ff2882' },
        areaStyle: { color: 'rgba(255,40,130,0.10)' },
        data: data.map((item) => item.value ?? null),
      },
      {
        name: 'Turnover',
        type: 'bar',
        yAxisIndex: 1,
        barWidth: '42%',
        itemStyle: { borderRadius: [6, 6, 0, 0], color: 'rgba(99,102,241,0.26)' },
        data: data.map((item) => (item.volUsdCents || 0) / 100),
      },
    ],
  }

  return <ChartCanvas option={option} height={320} />
}

function CardPriceChart({ bundle }: { bundle?: CardDetailBundle }) {
  const fmv = bundle?.fmvSeries?.points || []
  const pricePoints = bundle?.priceSeries?.points || []
  const methodLines = (bundle?.fmvSeries?.series || []).slice(0, 2)

  const axis = fmv.length > 0
    ? fmv.map((point) => point.t)
    : pricePoints.map((point) => point.t)

  if (axis.length < 2) return <LoadingBlock label="Waiting for card price series…" />

  const option: EChartsOption = {
    animationDuration: 420,
    color: ['#ff2882', '#10b981', '#6366f1', '#f59e0b'],
    grid: { left: 58, right: 20, top: 24, bottom: 34 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(16,16,16,0.92)',
      borderColor: 'rgba(255,255,255,0.08)',
      textStyle: { color: '#fff' },
      formatter: (params: any) => {
        const rows = Array.isArray(params) ? params : [params]
        const date = rows[0]?.axisValue || ''
        return [date, ...rows.map((row: any) => `${row.marker} ${row.seriesName}: ${currency2.format(Number(row.value || 0))}`)].join('<br/>')
      },
    },
    legend: { bottom: 0, textStyle: { color: '#7a7a7a' } },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      axisLine: { lineStyle: { color: 'rgba(122,122,122,0.25)' } },
      axisLabel: { color: '#7a7a7a' },
      data: axis.map((item) => new Date(item).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })),
    },
    yAxis: { type: 'value', scale: true, axisLabel: { color: '#7a7a7a', formatter: (value: number) => `$${compact.format(value)}` }, splitLine: { lineStyle: { color: 'rgba(122,122,122,0.12)' } } },
    series: [
      {
        name: 'FMV',
        type: 'line',
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 3, color: '#ff2882' },
        areaStyle: { color: 'rgba(255,40,130,0.10)' },
        data: (fmv.length > 0 ? fmv : pricePoints).map((item) => (item.usdCents ?? null) === null ? null : Number(item.usdCents) / 100),
      },
      ...methodLines.map((line) => ({
        name: line.label || line.method || 'Method',
        type: 'line' as const,
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 2, type: 'dashed' as const },
        data: axis.map((date) => {
          const match = line.points?.find((point) => point.t === date)
          return match?.usdCents === undefined || match.usdCents === null ? null : match.usdCents / 100
        }),
      })),
    ],
  }

  return <ChartCanvas option={option} height={310} />
}

function HeaderStatus({ bootstrap, healthRateLimit }: { bootstrap?: BootstrapResponse; healthRateLimit?: RateLimit }) {
  const limit = bestRateLimit(bootstrap, healthRateLimit)
  const authenticated = bootstrap?.authenticated
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 font-bold ${authenticated ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600' : 'border-amber-500/20 bg-amber-500/10 text-amber-600'}`}>
        <ShieldCheck className="h-3.5 w-3.5" />
        {authenticated ? 'Partner API' : 'Anonymous tier'}
      </span>
      <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-strong)] bg-[var(--bg-base)] px-3 py-1.5 text-[var(--fg-subtle)]">
        <Activity className="h-3.5 w-3.5 text-[var(--brand-100)]" />
        Remaining {limit?.remaining ?? '—'} / {limit?.limit ?? '—'}
      </span>
      <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-strong)] bg-[var(--bg-base)] px-3 py-1.5 text-[var(--fg-subtle)]">
        <Clock3 className="h-3.5 w-3.5" />
        Updated {formatDate(bootstrap?.fetchedAt)}
      </span>
    </div>
  )
}

function IndexTileCard({ tile, selected, onSelect }: { tile: IndexTile; selected: boolean; onSelect: () => void }) {
  const d30 = tile.deltas?.d30
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`group rounded-3xl border p-4 text-left transition hover:-translate-y-0.5 hover:shadow-lg ${selected ? 'border-[var(--brand-100)] bg-[var(--brand-10)]' : 'border-[var(--border-strong)] bg-[var(--bg-base-opaque)] hover:border-[var(--border-contrast)]'}`}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--fg-muted)]">{GAME_LABELS[tile.game]}</p>
          <p className="mt-1 text-2xl font-black text-[var(--fg-base)]">{formatIndexValue(tile.value)}</p>
        </div>
        <DeltaBadge value={d30} />
      </div>
      <SparklineChart values={(tile.sparkline || []).map((point) => point.usdCents)} positive={(d30 || 0) >= 0} height={64} />
      <div className="mt-3 flex items-center justify-between text-xs text-[var(--fg-subtle)]">
        <span>{tile.constituentCount ?? '—'} constituents</span>
        <span>{tile.rebalance || 'Monthly'}</span>
      </div>
    </button>
  )
}

function CardTile({ card, selected, onSelect, compactView = false }: { card: CardSummary; selected?: boolean; onSelect: () => void; compactView?: boolean }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`group flex w-full gap-3 rounded-3xl border p-3 text-left transition hover:-translate-y-0.5 hover:shadow-lg ${selected ? 'border-[var(--brand-100)] bg-[var(--brand-10)]' : 'border-[var(--border-strong)] bg-[var(--bg-base-opaque)] hover:border-[var(--border-contrast)]'}`}
    >
      <CardImage src={card.imageUrlThumb || card.imageUrl} alt={card.name} className={`${compactView ? 'h-16 w-12' : 'h-24 w-18'} shrink-0 rounded-2xl`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-black text-[var(--fg-base)]">{card.name}</p>
            <p className="truncate text-xs text-[var(--fg-subtle)]">{card.setCode || '—'} · #{card.cardNumber || '—'} · {card.gradeLabel || card.grade || 'Raw'}</p>
          </div>
          <DeltaBadge value={card.deltaPct} compact />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-lg font-black text-[var(--fg-base)]">{formatUsdCents(card.priceUsdCents)}</span>
          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${confidenceTone(card.confidence)}`}>{card.confidence || 'n/a'}</span>
        </div>
        {!compactView && (
          <div className="mt-2">
            <SparklineChart values={card.spark || []} positive={(card.deltaPct || 0) >= 0} height={44} />
          </div>
        )}
      </div>
    </button>
  )
}

function SearchPanel({
  searchInput,
  setSearchInput,
  searchGame,
  setSearchGame,
  onSubmit,
  searchResults,
  isFetching,
  selectedHref,
  onSelect,
}: {
  searchInput: string
  setSearchInput: (value: string) => void
  searchGame: SearchGameSlug | 'all'
  setSearchGame: (value: SearchGameSlug | 'all') => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  searchResults?: CardSummary[]
  isFetching: boolean
  selectedHref?: string | null
  onSelect: (href: string) => void
}) {
  return (
    <SectionCard className="overflow-hidden">
      <PanelHeader icon={Search} title="Card Scout" subtitle="Search Renaiss OS catalog by card, set, or character" />
      <div className="space-y-4 p-5">
        <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-[1fr_148px_112px]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--fg-muted)]" />
            <input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Charizard, Luffy, Pikachu…"
              className="h-12 w-full rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-base-opaque)] pl-10 pr-3 text-sm font-semibold outline-none transition focus:border-[var(--brand-100)] focus:ring-4 focus:ring-[var(--brand-10)]"
            />
          </div>
          <select
            value={searchGame}
            onChange={(event) => setSearchGame(event.target.value as SearchGameSlug | 'all')}
            className="h-12 rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-base-opaque)] px-3 text-sm font-bold outline-none transition focus:border-[var(--brand-100)] focus:ring-4 focus:ring-[var(--brand-10)]"
          >
            {SEARCH_GAMES.map((game) => <option key={game} value={game}>{game === 'all' ? 'All games' : gameLabel(game)}</option>)}
          </select>
          <button className="inline-flex h-12 items-center justify-center gap-2 rounded-2xl bg-[var(--brand-100)] px-4 text-sm font-black text-white shadow-lg shadow-pink-500/20 transition hover:brightness-105" type="submit">
            {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            Scout
          </button>
        </form>

        <div className="grid gap-3 lg:grid-cols-2">
          {(searchResults || []).map((card) => card.href && (
            <CardTile key={card.href} card={card} selected={selectedHref === card.href} compactView onSelect={() => onSelect(card.href!)} />
          ))}
        </div>
        {searchResults && searchResults.length === 0 && <p className="rounded-2xl bg-[var(--bg-subtle)] p-4 text-sm text-[var(--fg-subtle)]">No cards found. Try a broader name or remove the game filter.</p>}
      </div>
    </SectionCard>
  )
}

function CertLookup({
  certInput,
  setCertInput,
  onSubmit,
  lookup,
  isFetching,
}: {
  certInput: string
  setCertInput: (value: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  lookup?: GradedLookup
  isFetching: boolean
}) {
  return (
    <SectionCard className="overflow-hidden">
      <PanelHeader icon={BadgeCheck} title="Slab Cert Lookup" subtitle="PSA / CGC / BGS valuation by cert number" />
      <div className="space-y-4 p-5">
        <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-[1fr_120px]">
          <input
            value={certInput}
            onChange={(event) => setCertInput(event.target.value)}
            placeholder="PSA149595098"
            className="h-12 rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-base-opaque)] px-4 text-sm font-semibold outline-none transition focus:border-[var(--brand-100)] focus:ring-4 focus:ring-[var(--brand-10)]"
          />
          <button className="inline-flex h-12 items-center justify-center gap-2 rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-base-opaque)] px-4 text-sm font-black transition hover:border-[var(--brand-100)]" type="submit">
            {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
            Lookup
          </button>
        </form>
        {lookup && (
          <div className="rounded-3xl border border-[var(--border-strong)] bg-[var(--bg-base-opaque)] p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-black">
              {lookup.found ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <TrendingDown className="h-4 w-4 text-amber-500" />}
              {lookup.found ? 'Found graded card' : 'No exact cert match'}
            </div>
            {lookup.card ? (
              <div className="flex gap-3">
                <CardImage src={lookup.card.imageUrlThumb || lookup.card.imageUrl} alt={lookup.card.name} className="h-20 w-14 shrink-0 rounded-2xl" />
                <div className="min-w-0">
                  <p className="truncate font-black">{lookup.card.name}</p>
                  <p className="text-xs text-[var(--fg-subtle)]">{lookup.gradeLabel || lookup.card.gradeLabel || lookup.company}</p>
                  <p className="mt-1 text-xl font-black text-[var(--brand-100)]">{formatUsdCents(lookup.card.priceUsdCents)}</p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-[var(--fg-subtle)]">{lookup.reason || lookup.warning || 'The API did not return a priced card for this cert.'}</p>
            )}
          </div>
        )}
      </div>
    </SectionCard>
  )
}

function FeaturedMovers({ cards, selectedHref, onSelect, loading }: { cards?: CardSummary[]; selectedHref?: string | null; onSelect: (href: string) => void; loading: boolean }) {
  return (
    <SectionCard className="overflow-hidden">
      <PanelHeader icon={Star} title="Featured Movers" subtitle="Largest 7-day repricing across indexed slabs" />
      <div className="grid gap-3 p-5 lg:grid-cols-2">
        {loading && <div className="lg:col-span-2"><LoadingBlock /></div>}
        {!loading && (cards || []).map((card) => card.href && (
          <CardTile key={card.href} card={card} selected={selectedHref === card.href} onSelect={() => onSelect(card.href!)} />
        ))}
      </div>
    </SectionCard>
  )
}

function IndexExplorer({
  tiles,
  selectedGame,
  setSelectedGame,
  indexWindow,
  setIndexWindow,
  bundle,
  isLoading,
  onSelectCard,
}: {
  tiles?: IndexTile[]
  selectedGame: GameSlug
  setSelectedGame: (game: GameSlug) => void
  indexWindow: number
  setIndexWindow: (windowDays: number) => void
  bundle?: IndexBundle
  isLoading: boolean
  onSelectCard: (href: string) => void
}) {
  const detail = bundle?.detail
  const tileMap = new Map((tiles || []).map((tile) => [tile.game, tile]))
  const activeTile = detail || tileMap.get(selectedGame)

  return (
    <SectionCard className="overflow-hidden">
      <PanelHeader
        icon={BarChart3}
        title="Index Desk"
        subtitle="Game-level slab index, turnover, and constituent rotation"
        action={(
          <div className="flex rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-base-opaque)] p-1">
            {INDEX_WINDOWS.map((windowDays) => (
              <button
                key={windowDays}
                type="button"
                onClick={() => setIndexWindow(windowDays)}
                className={`rounded-xl px-3 py-1.5 text-xs font-black transition ${indexWindow === windowDays ? 'bg-[var(--brand-100)] text-white' : 'text-[var(--fg-subtle)] hover:bg-[var(--bg-subtle)]'}`}
              >
                {windowDays === 1095 ? '3Y' : `${windowDays}D`}
              </button>
            ))}
          </div>
        )}
      />
      <div className="space-y-5 p-5">
        <div className="grid gap-3 md:grid-cols-3">
          {GAME_ORDER.map((game) => {
            const tile = tileMap.get(game) || { game, label: GAME_LABELS[game] }
            return <IndexTileCard key={game} tile={tile as IndexTile} selected={selectedGame === game} onSelect={() => setSelectedGame(game)} />
          })}
        </div>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="rounded-3xl border border-[var(--border-strong)] bg-[var(--bg-base-opaque)] p-3">
            {isLoading ? <LoadingBlock label="Loading index chart…" /> : <IndexChart points={bundle?.series?.points} />}
          </div>
          <div className="space-y-3">
            <div className="rounded-3xl border border-[var(--border-strong)] bg-[var(--bg-base-opaque)] p-4">
              <p className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--fg-muted)]">Active basket</p>
              <div className="mt-2 flex items-end justify-between gap-3">
                <div>
                  <p className="text-3xl font-black">{formatIndexValue(activeTile?.value)}</p>
                  <p className="text-xs text-[var(--fg-subtle)]">Base {formatIndexValue(activeTile?.base || 10000)} · {activeTile?.constituentCount || detail?.constituentCount || '—'} cards</p>
                </div>
                <DeltaBadge value={activeTile?.deltas?.d365} />
              </div>
            </div>
            <div className="rounded-3xl border border-[var(--border-strong)] bg-[var(--bg-base-opaque)] p-4">
              <p className="mb-3 text-xs font-bold uppercase tracking-[0.2em] text-[var(--fg-muted)]">Top constituents</p>
              <div className="space-y-2">
                {(detail?.constituents || []).slice(0, 6).map((item) => (
                  <button key={`${item.rank}-${item.href || item.name}`} type="button" onClick={() => item.href && onSelectCard(item.href)} className="flex w-full items-center gap-3 rounded-2xl p-2 text-left transition hover:bg-[var(--bg-subtle)]">
                    <span className="w-6 text-xs font-black text-[var(--fg-muted)]">#{item.rank || '—'}</span>
                    <CardImage src={item.imageUrlThumb || item.imageUrl} alt={item.name} className="h-11 w-8 rounded-xl" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-black">{item.name}</p>
                      <p className="truncate text-xs text-[var(--fg-subtle)]">{item.setCode || '—'} · {item.grade || '—'}</p>
                    </div>
                    <span className="text-sm font-black">{formatCompactUsdCents(item.priceUsdCents)}</span>
                  </button>
                ))}
                {!detail?.constituents?.length && <p className="rounded-2xl bg-[var(--bg-subtle)] p-3 text-sm text-[var(--fg-subtle)]">Select an index to load constituents.</p>}
              </div>
            </div>
          </div>
        </div>
        {hasErrors(bundle?.errors) && <ErrorNotice message={`Partial index data unavailable: ${Object.values(bundle?.errors || {}).join('; ')}`} />}
      </div>
    </SectionCard>
  )
}

function SourceBreakdown({ sources }: { sources?: SourceBreakdownEntry[] }) {
  const topSources = (sources || []).filter((source) => source.count || source.medianUsdCents).slice(0, 6)
  if (!topSources.length) return <p className="rounded-2xl bg-[var(--bg-subtle)] p-4 text-sm text-[var(--fg-subtle)]">No source breakdown returned yet.</p>
  return (
    <div className="space-y-2">
      {topSources.map((source, index) => (
        <div key={`${source.source}-${index}`} className="rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-base-opaque)] p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="truncate text-sm font-black">{source.displayName || source.source || 'Source'}</p>
            <span className="rounded-full bg-[var(--bg-subtle)] px-2 py-1 text-xs font-bold text-[var(--fg-subtle)]">{source.count || 0} obs</span>
          </div>
          <div className="flex items-center justify-between text-xs text-[var(--fg-subtle)]">
            <span>{source.category || source.bucket || 'market'}</span>
            <span className="font-black text-[var(--fg-base)]">{formatUsdCents(source.medianUsdCents)}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

function TradeTape({ trades, onSelectCard, compactView = false }: { trades?: TradeRow[]; onSelectCard?: (href: string) => void; compactView?: boolean }) {
  const rows = trades || []
  if (!rows.length) return <p className="rounded-2xl bg-[var(--bg-subtle)] p-4 text-sm text-[var(--fg-subtle)]">No recent trades returned.</p>
  return (
    <div className="space-y-2">
      {rows.slice(0, compactView ? 8 : 12).map((trade, index) => {
        const href = trade.card?.href
        return (
          <button
            key={trade.id || `${trade.observedAt}-${index}`}
            type="button"
            onClick={() => href && onSelectCard?.(href)}
            className="flex w-full items-center gap-3 rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-base-opaque)] p-3 text-left transition hover:border-[var(--brand-100)] hover:bg-[var(--brand-10)]"
          >
            {!compactView && <CardImage src={trade.card?.imageUrl} alt={trade.card?.name || 'Card'} className="h-14 w-10 shrink-0 rounded-xl" />}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="truncate text-sm font-black">{trade.card?.name || trade.detail || 'Trade'}</p>
                <span className="rounded-full bg-[var(--bg-subtle)] px-2 py-0.5 text-[10px] font-bold uppercase text-[var(--fg-subtle)]">{trade.displayName || trade.source || 'source'}</span>
              </div>
              <p className="truncate text-xs text-[var(--fg-subtle)]">{trade.card?.setCode || '—'} · {trade.gradeLabel || trade.card?.gradeLabel || trade.company || '—'} · {timeAgo(trade.observedAt)}</p>
            </div>
            <div className="text-right">
              <p className="text-sm font-black">{formatUsdCents(trade.priceUsdCents)}</p>
              <p className="text-xs text-[var(--fg-subtle)]">{trade.currency || 'USD'}</p>
            </div>
          </button>
        )
      })}
    </div>
  )
}

function DetailMetric({ label, value, accent = false }: { label: string; value: ReactNode; accent?: boolean }) {
  return (
    <div className="rounded-3xl border border-[var(--border-strong)] bg-[var(--bg-base-opaque)] p-4">
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-[var(--fg-muted)]">{label}</p>
      <p className={`mt-2 text-2xl font-black ${accent ? 'text-[var(--brand-100)]' : 'text-[var(--fg-base)]'}`}>{value}</p>
    </div>
  )
}

function CardDetailPanel({
  bundle,
  selectedHref,
  loading,
  cardWindow,
  setCardWindow,
  onSelectCard,
}: {
  bundle?: CardDetailBundle
  selectedHref?: string | null
  loading: boolean
  cardWindow: number
  setCardWindow: (windowDays: number) => void
  onSelectCard: (href: string) => void
}) {
  const detail = bundle?.detail
  const image = detail?.imageUrlLg || detail?.imageUrl || detail?.imageUrlThumb

  return (
    <SectionCard className="overflow-hidden">
      <PanelHeader
        icon={LineChart}
        title="Card Valuation"
        subtitle={selectedHref ? 'FMV, methods, source quality, and recent sales' : 'Pick a card from search, movers, or index constituents'}
        action={(
          <div className="flex rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-base-opaque)] p-1">
            {CARD_WINDOWS.map((windowDays) => (
              <button
                key={windowDays}
                type="button"
                onClick={() => setCardWindow(windowDays)}
                className={`rounded-xl px-3 py-1.5 text-xs font-black transition ${cardWindow === windowDays ? 'bg-[var(--brand-100)] text-white' : 'text-[var(--fg-subtle)] hover:bg-[var(--bg-subtle)]'}`}
              >
                {windowDays}D
              </button>
            ))}
          </div>
        )}
      />

      {!selectedHref && <LoadingBlock label="Select a card to open valuation desk." />}
      {selectedHref && loading && <LoadingBlock label="Loading card valuation…" />}
      {selectedHref && !loading && detail && (
        <div className="grid gap-5 p-5 xl:grid-cols-[360px_minmax(0,1fr)]">
          <div className="space-y-4">
            <div className="overflow-hidden rounded-[28px] border border-[var(--border-strong)] bg-[var(--bg-base-opaque)]">
              <CardImage src={image} alt={detail.name} className="aspect-[3/4] w-full" />
              <div className="space-y-3 p-4">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--fg-muted)]">{gameLabel(detail.game)}</p>
                  <h3 className="mt-1 text-2xl font-black leading-tight">{detail.name}</h3>
                  <p className="mt-1 text-sm text-[var(--fg-subtle)]">{detail.setName || 'Unknown set'} · #{detail.cardNumber || '—'} · {detail.language || '—'}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-[var(--brand-10)] px-3 py-1 text-sm font-black text-[var(--brand-100)]">{detail.gradeLabel || detail.grade || 'Raw'}</span>
                  <span className={`rounded-full border px-3 py-1 text-xs font-bold uppercase ${confidenceTone(detail.confidence)}`}>{detail.confidence || 'confidence n/a'}</span>
                  {detail.href && <a href={detail.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-full border border-[var(--border-strong)] px-3 py-1 text-xs font-bold text-[var(--fg-subtle)] hover:text-[var(--brand-100)]">Open <ExternalLink className="h-3 w-3" /></a>}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <DetailMetric label="FMV" value={formatUsdCents(detail.priceUsdCents)} accent />
              <DetailMetric label="30D" value={<DeltaBadge value={detail.deltas?.d30 || detail.deltaPct} />} />
              <DetailMetric label="Sources" value={detail.sourceCount ?? detail.trackedSources?.length ?? '—'} />
              <DetailMetric label="Obs" value={detail.observationCount ?? detail.totalObservationCount ?? '—'} />
            </div>
          </div>

          <div className="space-y-5">
            <div className="rounded-[28px] border border-[var(--border-strong)] bg-[var(--bg-base-opaque)] p-3">
              <CardPriceChart bundle={bundle} />
            </div>
            <div className="grid gap-5 lg:grid-cols-3">
              <div className="lg:col-span-1">
                <h4 className="mb-3 text-sm font-black">Source Quality</h4>
                <SourceBreakdown sources={detail.sourceBreakdown || detail.sourceBreakdownAllTime} />
              </div>
              <div className="lg:col-span-2">
                <h4 className="mb-3 text-sm font-black">Recent Grade Sales</h4>
                <TradeTape trades={bundle?.trades} onSelectCard={onSelectCard} compactView />
              </div>
            </div>

            <div>
              <h4 className="mb-3 text-sm font-black">Other Grades</h4>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {(detail.otherGrades || []).slice(0, 8).map((grade, index) => (
                  <button
                    key={`${grade.gradeLabel}-${index}`}
                    type="button"
                    onClick={() => grade.href && onSelectCard(grade.href)}
                    className={`rounded-2xl border p-3 text-left transition hover:border-[var(--brand-100)] ${grade.current ? 'border-[var(--brand-100)] bg-[var(--brand-10)]' : 'border-[var(--border-strong)] bg-[var(--bg-base-opaque)]'}`}
                  >
                    <p className="text-xs font-bold text-[var(--fg-subtle)]">{grade.gradeLabel || grade.grade || 'Grade'}</p>
                    <p className="mt-1 text-lg font-black">{formatUsdCents(grade.priceUsdCents)}</p>
                    <DeltaBadge value={grade.deltaPct} compact />
                  </button>
                ))}
              </div>
            </div>

            {Boolean(bundle?.similar?.length) && (
              <div>
                <h4 className="mb-3 text-sm font-black">More From This Set</h4>
                <div className="grid gap-3 lg:grid-cols-2">
                  {bundle!.similar.slice(0, 4).map((card) => card.href && (
                    <CardTile key={card.href} card={card} compactView selected={card.href === selectedHref} onSelect={() => onSelectCard(card.href!)} />
                  ))}
                </div>
              </div>
            )}

            {hasErrors(bundle?.errors) && <ErrorNotice message={`Partial card data unavailable: ${Object.values(bundle?.errors || {}).join('; ')}`} />}
          </div>
        </div>
      )}
      {selectedHref && !loading && !detail && <div className="p-5"><ErrorNotice message="Card detail could not be loaded." /></div>}
    </SectionCard>
  )
}

export default function App() {
  const [selectedGame, setSelectedGame] = useState<GameSlug>('pokemon')
  const [indexWindow, setIndexWindow] = useState(365)
  const [searchInput, setSearchInput] = useState('charizard')
  const [activeSearch, setActiveSearch] = useState('')
  const [searchGame, setSearchGame] = useState<SearchGameSlug | 'all'>('all')
  const [selectedHref, setSelectedHref] = useState<string | null>(null)
  const [cardWindow, setCardWindow] = useState(90)
  const [certInput, setCertInput] = useState('')
  const [activeCert, setActiveCert] = useState('')

  const bootstrapQuery = useQuery({
    queryKey: ['renaiss-bootstrap'],
    queryFn: renaiss.bootstrap,
    refetchInterval: 60_000,
  })

  const healthQuery = useQuery({
    queryKey: ['renaiss-health'],
    queryFn: renaiss.health,
    refetchInterval: 120_000,
    retry: 1,
  })

  const indexQuery = useQuery({
    queryKey: ['renaiss-index', selectedGame, indexWindow],
    queryFn: () => renaiss.indexBundle(selectedGame, indexWindow),
  })

  const searchQuery = useQuery({
    queryKey: ['renaiss-search', activeSearch, searchGame],
    queryFn: () => renaiss.search(activeSearch, searchGame),
    enabled: activeSearch.trim().length >= 2,
  })

  const cardQuery = useQuery({
    queryKey: ['renaiss-card', selectedHref, cardWindow],
    queryFn: () => renaiss.cardByHref(selectedHref!, cardWindow),
    enabled: Boolean(selectedHref),
  })

  const certQuery = useQuery({
    queryKey: ['renaiss-cert', activeCert],
    queryFn: () => renaiss.graded(activeCert),
    enabled: activeCert.length > 0,
    retry: 1,
  })

  useEffect(() => {
    const firstHref = bootstrapQuery.data?.featured?.find((card) => card.href)?.href
    if (!selectedHref && firstHref) setSelectedHref(firstHref)
  }, [bootstrapQuery.data?.featured, selectedHref])

  const indexTiles = useMemo(() => bootstrapQuery.data?.indices || [], [bootstrapQuery.data?.indices])
  const heroStats = useMemo(() => {
    const cards = bootstrapQuery.data?.featured || []
    const trades = bootstrapQuery.data?.recentTrades || []
    const avgMove = cards.length ? cards.reduce((sum, card) => sum + Math.abs(card.deltaPct || 0), 0) / cards.length : 0
    const turnover = trades.reduce((sum, trade) => sum + (trade.priceUsdCents || 0), 0)
    return { avgMove, turnover, tradeCount: trades.length }
  }, [bootstrapQuery.data])

  const selectedCard = cardQuery.data?.detail
  const searchResults = searchQuery.data?.results
  const latestCards = bootstrapQuery.data?.featured || []
  const recentTrades = bootstrapQuery.data?.recentTrades || []

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = searchInput.trim()
    if (value.length >= 2) setActiveSearch(value)
  }

  function handleCert(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = certInput.trim().replace(/\s+/g, '')
    if (value) setActiveCert(value)
  }

  function selectCard(href: string) {
    setSelectedHref(href)
    setTimeout(() => {
      const target = document.getElementById('valuation-desk')
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 50)
  }

  return (
    <div className="min-h-screen bg-[var(--bg-chat)] text-[var(--fg-base)]">
      <header className="sticky top-0 z-20 border-b border-[var(--border-strong)] bg-[var(--bg-chat)]/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1500px] flex-col gap-4 px-4 py-4 md:flex-row md:items-center md:justify-between lg:px-8">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-[20px] bg-[var(--brand-100)] text-white shadow-lg shadow-pink-500/20">
              <WalletCards className="h-6 w-6" />
            </div>
            <div>
              <p className="text-xs font-black uppercase tracking-[0.28em] text-[var(--brand-100)]">SlabScout</p>
              <h1 className="text-2xl font-black leading-none md:text-3xl">Renaiss OS slab market desk</h1>
            </div>
          </div>
          <HeaderStatus bootstrap={bootstrapQuery.data} healthRateLimit={healthQuery.data?.rateLimit} />
        </div>
      </header>

      <main className="mx-auto max-w-[1500px] space-y-6 px-4 py-6 lg:px-8">
        <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
          <div className="overflow-hidden rounded-[32px] border border-[var(--border-strong)] bg-[radial-gradient(circle_at_top_left,rgba(255,40,130,0.20),transparent_34%),linear-gradient(135deg,var(--bg-base),var(--bg-base-opaque))] p-6 shadow-[0_24px_80px_rgba(0,0,0,0.05)] lg:p-8">
            <div className="mb-8 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-2 rounded-full bg-[var(--brand-10)] px-3 py-1.5 text-xs font-black text-[var(--brand-100)]"><Sparkles className="h-3.5 w-3.5" /> AI-ready collectibles intelligence</span>
              <span className="inline-flex items-center gap-2 rounded-full border border-[var(--border-strong)] bg-[var(--bg-base-opaque)] px-3 py-1.5 text-xs font-bold text-[var(--fg-subtle)]"><ShieldCheck className="h-3.5 w-3.5" /> Keys stay server-side</span>
            </div>
            <h2 className="max-w-4xl text-4xl font-black leading-[1.02] tracking-[-0.04em] md:text-6xl">
              Scout graded card mispricings before the tape catches up.
            </h2>
            <p className="mt-5 max-w-3xl text-base leading-7 text-[var(--fg-subtle)] md:text-lg">
              SlabScout turns the Renaiss OS Index API into a Surf Studio dashboard for index monitoring, card search, cert lookup, FMV history, source quality, and recent realized sales.
            </p>
            <div className="mt-8 grid gap-3 sm:grid-cols-3">
              <DetailMetric label="Avg featured move" value={formatPct(heroStats.avgMove)} accent />
              <DetailMetric label="Recent tape" value={formatUsdCents(heroStats.turnover)} />
              <DetailMetric label="Trades loaded" value={heroStats.tradeCount} />
            </div>
          </div>

          <div className="grid gap-4">
            <CertLookup certInput={certInput} setCertInput={setCertInput} onSubmit={handleCert} lookup={certQuery.data?.result} isFetching={certQuery.isFetching} />
            {certQuery.error && <ErrorNotice message={(certQuery.error as Error).message} />}
          </div>
        </section>

        {bootstrapQuery.error && <ErrorNotice message={(bootstrapQuery.error as Error).message} />}
        {hasErrors(bootstrapQuery.data?.errors) && <ErrorNotice message={`Some startup panels are partial: ${Object.values(bootstrapQuery.data?.errors || {}).join('; ')}`} />}

        <IndexExplorer
          tiles={indexTiles}
          selectedGame={selectedGame}
          setSelectedGame={setSelectedGame}
          indexWindow={indexWindow}
          setIndexWindow={setIndexWindow}
          bundle={indexQuery.data}
          isLoading={indexQuery.isLoading || indexQuery.isFetching && !indexQuery.data}
          onSelectCard={selectCard}
        />

        <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_520px]">
          <SearchPanel
            searchInput={searchInput}
            setSearchInput={setSearchInput}
            searchGame={searchGame}
            setSearchGame={setSearchGame}
            onSubmit={handleSearch}
            searchResults={searchResults}
            isFetching={searchQuery.isFetching}
            selectedHref={selectedHref}
            onSelect={selectCard}
          />
          <SectionCard className="overflow-hidden">
            <PanelHeader icon={Activity} title="Recent Trade Tape" subtitle="Latest completed sales and blockchain transactions" />
            <div className="p-5">
              {bootstrapQuery.isLoading ? <LoadingBlock /> : <TradeTape trades={recentTrades} onSelectCard={selectCard} />}
            </div>
          </SectionCard>
        </section>

        <FeaturedMovers cards={latestCards} selectedHref={selectedHref} onSelect={selectCard} loading={bootstrapQuery.isLoading} />

        <div id="valuation-desk">
          <CardDetailPanel
            bundle={cardQuery.data}
            selectedHref={selectedHref}
            loading={cardQuery.isLoading || cardQuery.isFetching && !cardQuery.data}
            cardWindow={cardWindow}
            setCardWindow={setCardWindow}
            onSelectCard={selectCard}
          />
        </div>

        <footer className="rounded-[28px] border border-[var(--border-strong)] bg-[var(--bg-base)] p-5 text-sm text-[var(--fg-subtle)]">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              Surf Studio-ready React + Express app. Upstream API credentials are read only by the backend proxy.
            </div>
            <div className="flex flex-wrap gap-2">
              <span className="rounded-full bg-[var(--bg-subtle)] px-3 py-1">Selected: {selectedCard?.name || selectedHref || '—'}</span>
              <span className="rounded-full bg-[var(--bg-subtle)] px-3 py-1">Health: {healthQuery.data?.ok ? 'ok' : healthQuery.isError ? 'error' : 'checking'}</span>
            </div>
          </div>
        </footer>
      </main>
    </div>
  )
}
