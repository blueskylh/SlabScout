const { DEMO_CARD, usdFromCents, round } = require('../shared')
const { replayCardDetail, replayFmvSeries, replayTrades, replayIndices } = require('../shared/demo-fixtures')

const DEFAULT_BASE_URL = 'https://api.renaissos.com'
const CACHE_TTL_MS = 5 * 60 * 1000
const REQUEST_TIMEOUT_MS = 8_000

const memoryCache = new Map()

function getConfig() {
  return {
    baseUrl: (process.env.RENAISS_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    apiKey: process.env.RENAISS_API_KEY || '',
    apiSecret: process.env.RENAISS_API_SECRET || '',
  }
}

function withTimeout(ms) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), ms)
  return { signal: controller.signal, cancel: () => clearTimeout(timeout) }
}

async function fetchJson(path, { retries = 1 } = {}) {
  const config = getConfig()
  const url = `${config.baseUrl}${path}`
  const cacheKey = url
  const cached = memoryCache.get(cacheKey)
  if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) {
    return { body: cached.body, meta: { cached: true, url, rateLimit: cached.rateLimit || null } }
  }

  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const guard = withTimeout(REQUEST_TIMEOUT_MS)
    try {
      const headers = { Accept: 'application/json', 'User-Agent': 'SlabScout/0.1' }
      if (config.apiKey && config.apiSecret) {
        headers['X-Api-Key'] = config.apiKey
        headers['X-Api-Secret'] = config.apiSecret
      }
      const response = await fetch(url, { headers, signal: guard.signal })
      const text = await response.text()
      if (!response.ok) {
        throw new Error(`Renaiss ${response.status}: ${text.slice(0, 160)}`)
      }
      const body = text ? JSON.parse(text) : {}
      const rateLimit = {
        limit: response.headers.get('X-RateLimit-Limit'),
        remaining: response.headers.get('X-RateLimit-Remaining'),
        reset: response.headers.get('X-RateLimit-Reset'),
      }
      memoryCache.set(cacheKey, { body, savedAt: Date.now(), rateLimit })
      return { body, meta: { cached: false, url, rateLimit } }
    } catch (error) {
      lastError = error
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)))
    } finally {
      guard.cancel()
    }
  }
  throw lastError
}

function methodPrice(methods, name, fallbackCents) {
  const method = Array.isArray(methods) ? methods.find((item) => item.method === name) : null
  return usdFromCents(method ? method.priceUsdCents : fallbackCents)
}

function normalizeSeries(fmv) {
  const series = Array.isArray(fmv.series) ? fmv.series : []
  return series.map((line) => ({
    method: line.method,
    label: line.label || line.method,
    points: Array.isArray(line.points)
      ? line.points.map((point) => ({ t: point.t, usd: usdFromCents(point.usdCents) })).filter((point) => point.usd !== null)
      : [],
  }))
}

function normalizeTrades(trades) {
  const rows = Array.isArray(trades.trades) ? trades.trades : []
  return rows.map((trade) => ({
    kind: trade.kind || 'unknown',
    source: trade.source || trade.sourceName || 'unknown',
    priceUsd: usdFromCents(trade.priceUsdCents),
    soldAt: trade.soldAt || trade.occurredAt || trade.createdAt || null,
  }))
}

function normalizeSignal({ detail, fmv, trades, indices, mode, offer }) {
  const medianUsd = methodPrice(detail.methods, 'median', detail.priceUsdCents)
  const meanUsd = methodPrice(detail.methods, 'mean', detail.priceUsdCents)
  const vwapUsd = methodPrice(detail.methods, 'vwap', detail.priceUsdCents)
  const completedTrades = normalizeTrades(trades).filter((trade) => trade.kind === 'transaction')
  const identityConfidence = offer?.imageConfidence || (offer?.certFound ? 'high' : 'medium')

  return {
    dataMode: mode,
    dataAsOf: new Date().toISOString(),
    card: {
      id: detail.id,
      game: detail.game,
      name: detail.name,
      setName: detail.setName,
      setCode: detail.setCode,
      cardNumber: detail.cardNumber,
      variation: detail.variation,
      language: detail.language,
      gradeLabel: detail.gradeLabel,
      company: detail.company,
      imageUrl: detail.imageUrlLg || detail.imageUrl,
      href: detail.href || DEMO_CARD.href,
      pageUrl: detail.pageUrl || `https://index.renaissos.com${detail.href || DEMO_CARD.href}`,
    },
    identity: {
      imageConfidence: identityConfidence,
      certFound: Boolean(offer?.certFound),
      forcedLowConfidence: Boolean(offer?.forceLowConfidence),
    },
    valuation: {
      priceUsd: usdFromCents(detail.priceUsdCents),
      medianUsd,
      meanUsd,
      vwapUsd,
      methods: Array.isArray(detail.methods) ? detail.methods.map((method) => ({
        method: method.method,
        label: method.label,
        priceUsd: usdFromCents(method.priceUsdCents),
        confidence: method.confidence,
        sourceCount: method.sourceCount,
        observationCount: method.observationCount,
      })) : [],
      deltas: detail.deltas || {},
    },
    quality: {
      confidence: offer?.forceLowConfidence ? 'medium' : detail.confidence,
      sourceCount: offer?.forceLowConfidence ? 1 : detail.sourceCount,
      observationCount: offer?.forceLowConfidence ? 3 : detail.observationCount,
      observationWindowDays: detail.observationWindowDays,
      totalObservationCount: detail.totalObservationCount,
      lastSaleAt: offer?.forceLowConfidence ? '2026-06-15T00:00:00.000Z' : detail.lastSaleAt,
      refreshing: Boolean(detail.refreshing),
      updatedAt: detail.updatedAt,
      sourceBreakdown: Array.isArray(detail.sourceBreakdown) ? detail.sourceBreakdown.map((source) => ({
        displayName: source.displayName || source.source,
        category: source.category,
        count: source.count,
        medianUsd: usdFromCents(source.medianUsdCents),
      })) : [],
    },
    trades: {
      completedCount: completedTrades.length,
      listingCount: normalizeTrades(trades).filter((trade) => trade.kind === 'listing').length,
      recent: normalizeTrades(trades).slice(0, 8),
    },
    trend: normalizeSeries(fmv),
    marketBackdrop: (Array.isArray(indices.indices) ? indices.indices : []).slice(0, 3).map((index) => ({
      game: index.game,
      label: index.label,
      value: index.value,
      deltas: index.deltas,
      updatedAt: index.updatedAt,
    })),
    notes: [
      `Renaiss ${detail.gradeLabel || ''} ${detail.confidence || 'unknown'} confidence`,
      `${detail.sourceCount || 0} sources / ${detail.observationCount || 0} observations in ${detail.observationWindowDays || 7}d window`,
      completedTrades.length > 0
        ? `${completedTrades.length} completed transactions retained for MarketProof sample view`
        : 'No completed transaction rows exposed in recent-trades response; policy uses Renaiss observation counters instead',
    ],
    derived: {
      maxAuthorizedAskUsd: medianUsd ? round(medianUsd * 0.9, 2) : null,
    },
  }
}

async function getReplaySignal({ offer } = {}) {
  return normalizeSignal({
    detail: replayCardDetail,
    fmv: replayFmvSeries,
    trades: replayTrades,
    indices: replayIndices,
    mode: 'replay',
    offer,
  })
}

async function getLiveSignal({ card = DEMO_CARD, offer } = {}) {
  const slug = `/v1/cards/${card.game}/${card.set}/${card.card}`
  const [detailResult, fmvResult, tradesResult, indicesResult] = await Promise.all([
    fetchJson(slug),
    fetchJson(`${slug}/fmv-series?window=30`),
    fetchJson(`${slug}/trades?window=7&scope=completed&limit=16`),
    fetchJson('/v1/indices'),
  ])

  const signal = normalizeSignal({
    detail: detailResult.body,
    fmv: fmvResult.body,
    trades: tradesResult.body,
    indices: indicesResult.body,
    mode: detailResult.meta.cached ? 'live-cache' : 'live',
    offer,
  })
  signal.rateLimit = detailResult.meta.rateLimit
  return signal
}

async function getCardSignal({ mode = process.env.SLABSCOUT_DEFAULT_MODE || 'replay', card = DEMO_CARD, offer } = {}) {
  if (mode === 'replay') return getReplaySignal({ offer })
  try {
    return await getLiveSignal({ card, offer })
  } catch (error) {
    const fallback = await getReplaySignal({ offer })
    fallback.dataMode = 'replay-fallback'
    fallback.liveError = error.message
    return fallback
  }
}

module.exports = {
  getCardSignal,
  getLiveSignal,
  getReplaySignal,
  normalizeSignal,
}
