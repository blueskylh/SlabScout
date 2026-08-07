import { api } from './api'

export type GameSlug = 'pokemon' | 'one-piece' | 'sports'
export type SearchGameSlug = GameSlug | 'digimon' | 'riftbound' | 'mtg' | 'yugioh' | 'lorcana' | 'gundam' | 'others'

export interface RateLimit {
  limit?: string | null
  remaining?: string | null
  reset?: string | null
  retryAfter?: string | null
}

export interface Deltas {
  d7?: number | null
  d30?: number | null
  d365?: number | null
}

export interface SparkPoint {
  t?: string
  usdCents?: number | null
}

export interface IndexMover {
  name: string
  setCode?: string | null
  cardNumber?: string | null
  grade?: string | null
  href: string
  deltaPct?: number | null
}

export interface IndexTile {
  game: GameSlug
  label: string
  value?: number | null
  base?: number | null
  deltas?: Deltas | null
  constituentCount?: number | null
  rebalance?: string | null
  sparkline?: SparkPoint[]
  topMovers?: IndexMover[]
  updatedAt?: string | null
}

export interface IndexConstituent {
  rank?: number | null
  name: string
  setName?: string | null
  setCode?: string | null
  cardNumber?: string | null
  grade?: string | null
  imageUrl?: string | null
  imageUrlThumb?: string | null
  priceUsdCents?: number | null
  deltaPct?: number | null
  lastSaleAt?: string | null
  tradeCountWindow?: number | null
  href?: string | null
}

export interface IndexDetail extends IndexTile {
  windowDays?: number | null
  baseDate?: string | null
  constituents?: IndexConstituent[]
  sourceBreakdown?: SourceBreakdownEntry[]
}

export interface IndexSeriesPoint {
  t: string
  value?: number | null
  volUsdCents?: number | null
  n?: number | null
  rebalanced?: boolean
  membersAdded?: number | null
  membersRemoved?: number | null
}

export interface IndexSeriesResponse {
  windowDays?: number | null
  base?: number | null
  points?: IndexSeriesPoint[]
}

export interface CardSummary {
  id?: string
  game: SearchGameSlug
  type?: string | null
  name: string
  setName?: string | null
  setCode?: string | null
  cardNumber?: string | null
  variation?: string | null
  rarity?: string | null
  language?: string | null
  imageUrl?: string | null
  imageUrlThumb?: string | null
  company?: string | null
  grade?: string | null
  gradeLabel?: string | null
  priceUsdCents?: number | null
  deltaPct?: number | null
  confidence?: string | null
  lastSaleAt?: string | null
  spark?: number[]
  href?: string | null
}

export interface GradeRow {
  company?: string | null
  grade?: string | null
  gradeLabel?: string | null
  priceUsdCents?: number | null
  deltaPct?: number | null
  confidence?: string | null
  lastSaleAt?: string | null
  href?: string | null
  current?: boolean
}

export interface SourceBreakdownEntry {
  source?: string | null
  bucket?: string | null
  category?: string | null
  displayName?: string | null
  count?: number | null
  medianUsdCents?: number | null
  overviewUrl?: string | null
}

export interface FmvMethodValue {
  method?: string | null
  scorerVersion?: string | null
  label?: string | null
  priceUsdCents?: number | null
  confidence?: string | null
  sourceCount?: number | null
  observationCount?: number | null
}

export interface CardDetail extends CardSummary {
  id?: string
  imageUrlLg?: string | null
  priceUsdCents?: number | null
  deltas?: Deltas | null
  sourceCount?: number | null
  observationCount?: number | null
  observationWindowDays?: number | null
  totalObservationCount?: number | null
  updatedAt?: string | null
  refreshing?: boolean | null
  sourceBreakdown?: SourceBreakdownEntry[]
  sourceBreakdownAllTime?: SourceBreakdownEntry[]
  trackedSources?: string[]
  methods?: FmvMethodValue[]
  otherGrades?: GradeRow[]
}

export interface SeriesPoint {
  t: string
  usdCents?: number | null
  source?: string | null
  bucket?: string | null
  category?: string | null
  n?: number | null
  kind?: string | null
  company?: string | null
  grade?: string | null
  gradeLabel?: string | null
}

export interface SeriesResponse {
  windowDays?: number | null
  points?: SeriesPoint[]
}

export interface FmvSourcePoint {
  source?: string | null
  bucket?: string | null
  category?: string | null
  displayName?: string | null
  usdCents?: number | null
  n?: number | null
}

export interface FmvSeriesPoint {
  t: string
  usdCents?: number | null
  n?: number | null
  bySource?: FmvSourcePoint[]
}

export interface FmvMethodLinePoint {
  t: string
  usdCents?: number | null
}

export interface FmvMethodSeries {
  method?: string | null
  scorerVersion?: string | null
  label?: string | null
  points?: FmvMethodLinePoint[]
}

export interface FmvSeriesResponse {
  windowDays?: number | null
  fmvWindowDays?: number | null
  gradeLabel?: string | null
  points?: FmvSeriesPoint[]
  series?: FmvMethodSeries[]
}

export interface TradeCardRef {
  game?: SearchGameSlug
  name?: string
  grade?: string | null
  gradeLabel?: string | null
  setCode?: string | null
  cardNumber?: string | null
  href?: string | null
  imageUrl?: string | null
}

export interface TradeRow {
  id?: string
  source?: string | null
  bucket?: string | null
  category?: string | null
  displayName?: string | null
  observedAt?: string | null
  kind?: string | null
  priceUsdCents?: number | null
  priceMinor?: number | null
  currency?: string | null
  detail?: string | null
  sourceUrl?: string | null
  company?: string | null
  grade?: string | null
  gradeLabel?: string | null
  card?: TradeCardRef
}

export interface SearchResponse {
  query?: string
  results: CardSummary[]
  rateLimit?: RateLimit
  fetchedAt?: string
  cached?: boolean
}

export interface BootstrapResponse {
  fetchedAt?: string
  authenticated?: boolean
  indices: IndexTile[]
  featured: CardSummary[]
  recentTrades: TradeRow[]
  rateLimits?: Record<string, RateLimit | undefined>
  errors?: Record<string, string>
}

export interface IndexBundle {
  game: GameSlug
  detail?: IndexDetail | null
  series?: IndexSeriesResponse | null
  errors?: Record<string, string>
  fetchedAt?: string
}

export interface CardDetailBundle {
  href: string
  detail?: CardDetail | null
  priceSeries?: SeriesResponse | null
  fmvSeries?: FmvSeriesResponse | null
  trades: TradeRow[]
  tradeTotal?: number
  sourceCounts?: Record<string, number>
  similar: CardSummary[]
  errors?: Record<string, string>
  fetchedAt?: string
}

export interface GradedLookup {
  cert?: string
  certNumber?: string
  company?: string | null
  found?: boolean
  grade?: string | null
  gradeLabel?: string | null
  card?: CardDetail | null
  certImages?: string[]
  collectible?: CardSummary | null
  reason?: string | null
  warning?: string | null
}

export interface GradedResponse {
  result: GradedLookup
  rateLimit?: RateLimit
  fetchedAt?: string
  cached?: boolean
}

export interface HealthResponse {
  ok: boolean
  authenticated?: boolean
  upstream?: unknown
  rateLimit?: RateLimit
  fetchedAt?: string
  cached?: boolean
}

function queryString(params: Record<string, string | number | boolean | null | undefined>) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
  }
  const value = search.toString()
  return value ? `?${value}` : ''
}

async function readError(response: Response) {
  try {
    const payload = await response.json()
    return payload?.detail || payload?.error || payload?.message || response.statusText
  } catch {
    return response.statusText || `HTTP ${response.status}`
  }
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(api(path), {
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw new Error(await readError(response))
  return response.json() as Promise<T>
}

export const renaiss = {
  health: () => getJson<HealthResponse>('renaiss/health'),
  bootstrap: () => getJson<BootstrapResponse>('renaiss/bootstrap?featuredLimit=12&tradeLimit=12'),
  indexBundle: (game: GameSlug, windowDays: number) => getJson<IndexBundle>(`renaiss/indices/${game}${queryString({ window: windowDays })}`),
  search: (q: string, game?: SearchGameSlug | 'all') => getJson<SearchResponse>(`renaiss/search${queryString({ q, limit: 12, game: game === 'all' ? undefined : game })}`),
  cardByHref: (href: string, windowDays: number) => getJson<CardDetailBundle>(`renaiss/card${queryString({ href, window: windowDays, tradeWindow: 365, tradeLimit: 80 })}`),
  graded: (cert: string) => getJson<GradedResponse>(`renaiss/graded/${encodeURIComponent(cert)}`),
}
