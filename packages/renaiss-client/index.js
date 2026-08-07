const { DEMO_CARD, DEMO_TARGET, usdFromCents, round } = require('../shared')
const { identityMatches } = require('../shared/validation')
const { replayCardDetail, replayFmvSeries, replayTrades, replayCertLookup, replayIndices } = require('../shared/demo-fixtures')

const DEFAULT_BASE_URL = 'https://api.renaissos.com'
const CACHE_TTL_MS = 5 * 60 * 1000
const REQUEST_TIMEOUT_MS = 12_000

const memoryCache = new Map()

class RenaissHttpError extends Error {
  constructor(message, { status, body, url } = {}) {
    super(message)
    this.name = 'RenaissHttpError'
    this.status = status
    this.body = body
    this.url = url
  }
}

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

async function fetchJson(path, { retries = 1, cache = true } = {}) {
  const config = getConfig()
  const url = `${config.baseUrl}${path}`
  const cacheKey = url
  const cached = cache ? memoryCache.get(cacheKey) : null
  if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) {
    return { body: cached.body, meta: { cached: true, url, rateLimit: cached.rateLimit || null } }
  }

  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const guard = withTimeout(REQUEST_TIMEOUT_MS)
    try {
      const headers = { Accept: 'application/json', 'User-Agent': 'SlabScout/0.2' }
      if (config.apiKey && config.apiSecret) {
        headers['X-Api-Key'] = config.apiKey
        headers['X-Api-Secret'] = config.apiSecret
      }
      const response = await fetch(url, { headers, signal: guard.signal })
      const text = await response.text()
      const rateLimit = {
        limit: response.headers.get('X-RateLimit-Limit'),
        remaining: response.headers.get('X-RateLimit-Remaining'),
        reset: response.headers.get('X-RateLimit-Reset'),
      }
      if (!response.ok) {
        throw new RenaissHttpError(`Renaiss ${response.status}: ${text.slice(0, 160)}`, {
          status: response.status,
          body: text,
          url,
        })
      }
      const body = text ? JSON.parse(text) : {}
      if (cache) memoryCache.set(cacheKey, { body, savedAt: Date.now(), rateLimit })
      return { body, meta: { cached: false, url, rateLimit } }
    } catch (error) {
      lastError = error
      if (error instanceof RenaissHttpError && [400, 401, 404].includes(error.status)) break
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)))
    } finally {
      guard.cancel()
    }
  }
  throw lastError
}

function isCertTerminal(error) {
  return error instanceof RenaissHttpError && [400, 401, 404].includes(error.status)
}

function slugFromHref(href) {
  if (typeof href !== 'string' || !href.startsWith('/card/')) return null
  return `/v1/cards/${href.slice('/card/'.length)}`
}

function methodPrice(methods, name, fallbackCents) {
  const method = Array.isArray(methods) ? methods.find((item) => item.method === name) : null
  return usdFromCents(method ? method.priceUsdCents : fallbackCents)
}

function normalizeSeries(fmv = {}) {
  const series = Array.isArray(fmv.series)
    ? fmv.series
    : [{ method: 'fmv', label: 'FMV', points: Array.isArray(fmv.points) ? fmv.points : [] }]
  return series.map((line) => ({
    method: line.method,
    label: line.label || line.method,
    points: Array.isArray(line.points)
      ? line.points.map((point) => ({ t: point.t, usd: usdFromCents(point.usdCents) })).filter((point) => point.usd !== null)
      : [],
  }))
}

function normalizeSource(source, displayName) {
  if (source === 'site_s' || displayName === 'Site S') return 'snkrdunk'
  return source || displayName || 'unknown'
}

function normalizeTrades(trades = {}) {
  const rows = Array.isArray(trades.trades) ? trades.trades : []
  return rows.map((trade) => ({
    kind: trade.kind || 'unknown',
    source: normalizeSource(trade.source || trade.sourceName, trade.displayName),
    displayName: trade.displayName || normalizeSource(trade.source || trade.sourceName, trade.displayName),
    category: trade.category || null,
    priceUsd: usdFromCents(trade.priceUsdCents),
    priceMinor: trade.priceMinor ?? null,
    currency: trade.currency || 'USD',
    detail: trade.detail || null,
    sourceUrl: trade.sourceUrl || null,
    observedAt: trade.observedAt || trade.soldAt || trade.occurredAt || trade.createdAt || null,
  }))
}

function normalizeCertLookup(certLookup = {}, offer = {}) {
  const body = certLookup || {}
  const card = body.card || body.summary || body.item || {}
  const certNumber = String(body.certNumber || body.certificateNumber || body.cert || offer?.certNumber || '').replace(/^PSA/i, '') || null
  const gradeLabel = body.gradeLabel || card.gradeLabel || normalizeGradeLabel(body.company || card.company, body.grade || card.grade) || null
  const href = body.href || card.href || null
  const itemId = body.itemId || body.renaissItemId || card.id || card.itemId || null
  const found = Boolean(body.found === true || (body.found !== false && (itemId || href)))
  return {
    cert: body.cert || (certNumber ? `PSA${certNumber}` : null),
    certNumber,
    found,
    name: body.name || card.name || body.cardName || null,
    setName: body.setName || card.setName || null,
    itemId,
    renaissItemId: body.renaissItemId || body.collectible?.renaissItemId || null,
    href,
    grade: body.grade || card.grade || null,
    gradeLabel,
    company: body.company || card.company || null,
    card: {
      id: itemId,
      href,
      name: body.name || card.name || null,
      setName: body.setName || card.setName || null,
      company: body.company || card.company || null,
      gradeLabel,
    },
    observedAt: body.observedAt || body.updatedAt || body.checkedAt || new Date().toISOString(),
    rawFound: body.found ?? null,
  }
}

function normalizeGradeLabel(company, grade) {
  if (!company || !grade) return null
  const gradeText = String(grade)
  const gradeNumber = gradeText.match(/\d+(?:\.\d+)?/)?.[0]
  return gradeNumber ? `${company} ${gradeNumber}` : `${company} ${gradeText}`
}

function maxIso(...values) {
  const valid = values
    .flat()
    .filter(Boolean)
    .map((value) => ({ value, t: new Date(value).getTime() }))
    .filter((item) => Number.isFinite(item.t))
    .sort((a, b) => b.t - a.t)
  return valid[0]?.value || null
}

function normalizeSignal({ detail = {}, fmv = {}, trades = {}, certLookup = {}, indices = {}, mode, offer, authorization, liveMeta = {} }) {
  const medianUsd = methodPrice(detail.methods, 'median', detail.priceUsdCents)
  const meanUsd = methodPrice(detail.methods, 'mean', detail.priceUsdCents)
  const vwapUsd = methodPrice(detail.methods, 'vwap', detail.priceUsdCents)
  const allTrades = normalizeTrades(trades)
  const completedTrades = allTrades.filter((trade) => trade.kind === 'transaction')
  const listingTrades = allTrades.filter((trade) => trade.kind === 'listing')
  const cert = normalizeCertLookup(certLookup, offer)
  const cardHref = detail.href || cert.href || offer?.targetHref || DEMO_TARGET.targetHref
  const cardDetail = {
    id: detail.id || cert.itemId || offer?.targetItemId || null,
    game: detail.game || offer?.card?.game || DEMO_CARD.game,
    name: detail.name || cert.name || null,
    setName: detail.setName || cert.setName || null,
    setCode: detail.setCode || null,
    cardNumber: detail.cardNumber || null,
    variation: detail.variation || null,
    language: detail.language || null,
    gradeLabel: detail.gradeLabel || cert.gradeLabel || offer?.gradeLabel || null,
    company: detail.company || cert.company || offer?.company || null,
    imageUrl: detail.imageUrlLg || detail.imageUrl || null,
    href: cardHref,
    pageUrl: detail.pageUrl || (cardHref ? `https://index.renaissos.com${cardHref}` : null),
  }
  const matchesIdentity = identityMatches({ authorization, offer, certLookup: cert, cardDetail })
  const identityConfidence = offer?.forceLowConfidence
    ? 'medium'
    : (offer?.imageConfidence || (matchesIdentity ? 'high' : 'low'))
  const sourceUpdatedAt = maxIso(
    detail.updatedAt,
    cert.observedAt,
    allTrades.map((trade) => trade.observedAt),
    Array.isArray(fmv.points) ? fmv.points.map((point) => point.t) : [],
  )
  const tradeSampleMode = completedTrades.length > 0 ? 'transaction' : 'aggregate-only'

  return {
    dataMode: mode,
    fetchedAt: new Date().toISOString(),
    dataAsOf: sourceUpdatedAt || new Date().toISOString(),
    sourceUpdatedAt,
    lastSaleAt: offer?.forceLowConfidence ? '2026-06-15T00:00:00.000Z' : detail.lastSaleAt || maxIso(completedTrades.map((trade) => trade.observedAt)),
    liveMeta,
    card: cardDetail,
    identity: {
      imageConfidence: identityConfidence,
      certNumber: offer?.certNumber || cert.certNumber || null,
      certFound: cert.found,
      certMatchesOffer: matchesIdentity,
      certLookup: cert,
      targetItemId: offer?.targetItemId || authorization?.targetItemId || null,
      targetHref: offer?.targetHref || authorization?.targetHref || null,
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
      confidence: offer?.forceLowConfidence ? 'medium' : detail.confidence || 'none',
      sourceCount: offer?.forceLowConfidence ? 1 : detail.sourceCount || 0,
      observationCount: offer?.forceLowConfidence ? 3 : detail.observationCount || 0,
      observationWindowDays: detail.observationWindowDays || null,
      totalObservationCount: detail.totalObservationCount || 0,
      lastSaleAt: offer?.forceLowConfidence ? '2026-06-15T00:00:00.000Z' : detail.lastSaleAt || null,
      refreshing: Boolean(detail.refreshing),
      updatedAt: detail.updatedAt || null,
      sourceBreakdown: Array.isArray(detail.sourceBreakdown) ? detail.sourceBreakdown.map((source) => ({
        source: normalizeSource(source.source, source.displayName),
        displayName: source.displayName === 'Site S' ? 'SNKRDUNK' : (source.displayName || source.source),
        category: source.category,
        count: source.count,
        medianUsd: usdFromCents(source.medianUsdCents),
      })) : [],
    },
    trades: {
      completedCount: completedTrades.length,
      listingCount: listingTrades.length,
      sampleMode: tradeSampleMode,
      recent: completedTrades.length > 0 ? completedTrades.slice(0, 8) : [],
      aggregateRows: completedTrades.length > 0 ? [] : allTrades.slice(0, 8),
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
      `Renaiss ${cardDetail.gradeLabel || ''} ${detail.confidence || 'unknown'} confidence`,
      `${detail.sourceCount || 0} sources / ${detail.observationCount || 0} observations in ${detail.observationWindowDays || 'n/a'}d window`,
      tradeSampleMode === 'transaction'
        ? `${completedTrades.length} completed source transaction rows retained for MarketProof sample view`
        : 'Recent-trades response exposed no transaction rows; source sample is explicitly aggregate-only',
    ],
    derived: { maxAuthorizedAskUsd: medianUsd ? round(medianUsd * 0.9, 2) : null },
  }
}

function invalidCertSignal({ offer, authorization, error }) {
  const now = new Date().toISOString()
  return normalizeSignal({
    detail: {
      id: offer?.targetItemId || authorization?.targetItemId,
      href: offer?.targetHref || authorization?.targetHref,
      company: offer?.company || authorization?.company,
      gradeLabel: offer?.gradeLabel || authorization?.gradeLabel,
      confidence: 'none',
      sourceCount: 0,
      observationCount: 0,
      updatedAt: now,
    },
    fmv: { series: [] },
    trades: { trades: [] },
    certLookup: { found: false, certNumber: offer?.certNumber || authorization?.certNumber, observedAt: now },
    indices: { indices: [] },
    mode: 'live',
    offer,
    authorization,
    liveMeta: { certTerminalError: true, status: error?.status || null, error: error instanceof Error ? error.message : String(error) },
  })
}

async function getReplaySignal({ offer, authorization } = {}) {
  return normalizeSignal({
    detail: replayCardDetail,
    fmv: replayFmvSeries,
    trades: replayTrades,
    certLookup: replayCertLookup,
    indices: replayIndices,
    mode: 'replay',
    offer,
    authorization,
  })
}

async function getLiveSignal({ card = DEMO_CARD, offer, authorization } = {}) {
  const certNumber = offer?.certNumber || authorization?.certNumber
  let certResult
  try {
    certResult = certNumber ? await fetchJson(`/v1/graded/${encodeURIComponent(certNumber)}`, { retries: 0 }) : { body: { found: false }, meta: {} }
  } catch (error) {
    if (isCertTerminal(error)) return invalidCertSignal({ offer, authorization, error })
    throw error
  }
  const cert = normalizeCertLookup(certResult.body, offer)
  const slug = slugFromHref(cert.href) || slugFromHref(offer?.targetHref) || `/v1/cards/${card.game}/${card.set}/${card.card}`
  const [detailResult, fmvResult, tradesResult, indicesResult] = await Promise.all([
    fetchJson(slug),
    fetchJson(`${slug}/fmv-series?window=30`),
    fetchJson(`${slug}/trades?window=30&scope=grade&source=snkrdunk&limit=16`, { cache: false }),
    fetchJson('/v1/indices'),
  ])

  const signal = normalizeSignal({
    detail: detailResult.body,
    fmv: fmvResult.body,
    trades: tradesResult.body,
    certLookup: certResult.body,
    indices: indicesResult.body,
    mode: detailResult.meta.cached ? 'live-cache' : 'live',
    offer,
    authorization,
    liveMeta: { detailUrl: detailResult.meta.url, certUrl: certResult.meta.url, tradesUrl: tradesResult.meta.url },
  })
  signal.rateLimit = detailResult.meta.rateLimit
  return signal
}

async function getCardSignal({ mode = process.env.SLABSCOUT_DEFAULT_MODE || 'replay', card = DEMO_CARD, offer, authorization } = {}) {
  if (mode === 'replay') return getReplaySignal({ offer, authorization })
  try {
    return await getLiveSignal({ card, offer, authorization })
  } catch (error) {
    const fallback = await getReplaySignal({ offer, authorization })
    fallback.dataMode = 'REPLAY_FALLBACK'
    fallback.liveError = error instanceof Error ? error.message : String(error)
    fallback.disablesPayment = true
    fallback.notes = [...fallback.notes, 'Live Renaiss fetch failed; this is replay fallback and cannot authorize real payment.']
    return fallback
  }
}

module.exports = {
  RenaissHttpError,
  getCardSignal,
  getLiveSignal,
  getReplaySignal,
  normalizeSignal,
  normalizeCertLookup,
  normalizeTrades,
  slugFromHref,
}
