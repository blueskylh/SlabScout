const express = require('express')

const router = express.Router()

const API_BASE_URL = String(process.env.RENAISS_API_BASE_URL || 'https://api.renaissos.com').replace(/\/+$/, '')
const API_KEY = process.env.RENAISS_API_KEY || process.env.X_API_KEY || ''
const API_SECRET = process.env.RENAISS_API_SECRET || process.env.RENAISS_API_SECRE || process.env.X_API_SECRET || ''
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.RENAISS_API_TIMEOUT_MS || '15000', 10)
const CACHE_MAX_ITEMS = 240
const cache = new Map()

const VALID_GAMES = new Set(['pokemon', 'one-piece', 'sports'])
const VALID_SEARCH_GAMES = new Set(['pokemon', 'one-piece', 'sports', 'digimon', 'riftbound', 'mtg', 'yugioh', 'lorcana', 'gundam', 'others'])
const SERIES_WINDOWS = new Set(['7', '30', '90', '365'])
const INDEX_WINDOWS = new Set(['30', '90', '365', '1095', '36500'])

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function pickWindow(value, allowed, fallback) {
  const raw = String(value ?? fallback)
  return allowed.has(raw) ? raw : fallback
}

function rateLimitFromHeaders(headers) {
  return {
    limit: headers.get('x-ratelimit-limit'),
    remaining: headers.get('x-ratelimit-remaining'),
    reset: headers.get('x-ratelimit-reset'),
    retryAfter: headers.get('retry-after'),
  }
}

function cacheGet(key) {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() > hit.expiresAt) {
    cache.delete(key)
    return null
  }
  return { ...hit.payload, cached: true }
}

function cacheSet(key, payload, ttlMs) {
  if (!ttlMs || ttlMs <= 0) return
  cache.set(key, { expiresAt: Date.now() + ttlMs, payload })
  if (cache.size > CACHE_MAX_ITEMS) {
    const oldestKey = cache.keys().next().value
    if (oldestKey) cache.delete(oldestKey)
  }
}

function safeString(value, max = 160) {
  return String(value ?? '').trim().slice(0, max)
}

function buildUpstreamUrl(pathname, params = {}) {
  if (!String(pathname).startsWith('/v1/') && pathname !== '/health') {
    throw Object.assign(new Error('Unsupported upstream path'), { status: 400 })
  }

  const url = new URL(`${API_BASE_URL}${pathname}`)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value))
    }
  }
  return url
}

async function requestUpstream(pathname, { params, method = 'GET', body, cacheTtlMs = 60_000, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const url = buildUpstreamUrl(pathname, params)
  const cacheKey = method === 'GET' ? `${method}:${url.toString()}` : null
  if (cacheKey) {
    const cached = cacheGet(cacheKey)
    if (cached) return cached
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const headers = new Headers({ Accept: 'application/json' })

  if (API_KEY) headers.set('X-Api-Key', API_KEY)
  if (API_SECRET) headers.set('X-Api-Secret', API_SECRET)
  if (body !== undefined) headers.set('Content-Type', 'application/json')

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await response.text()
    let data = null

    if (text) {
      try {
        data = JSON.parse(text)
      } catch (_) {
        data = { raw: text }
      }
    }

    const payload = {
      data,
      status: response.status,
      rateLimit: rateLimitFromHeaders(response.headers),
      cached: false,
      fetchedAt: new Date().toISOString(),
    }

    if (!response.ok) {
      const message = data?.error || data?.detail || data?.message || response.statusText || 'Renaiss OS upstream error'
      throw Object.assign(new Error(String(message)), {
        status: response.status,
        upstream: data,
        rateLimit: payload.rateLimit,
      })
    }

    if (cacheKey) cacheSet(cacheKey, payload, cacheTtlMs)
    return payload
  } catch (error) {
    if (error.name === 'AbortError') {
      throw Object.assign(new Error('Renaiss OS API request timed out'), { status: 504 })
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function asyncRoute(handler) {
  return (req, res) => Promise.resolve(handler(req, res)).catch((error) => sendError(res, error))
}

function sendError(res, error) {
  const status = Number.isInteger(error.status) ? error.status : 500
  res.status(status).json({
    error: 'Renaiss OS request failed',
    detail: error.message || 'Unknown error',
    upstream: error.upstream,
    rateLimit: error.rateLimit,
  })
}

function parseCardHref(href) {
  const cleanHref = safeString(href, 600)
  const pathOnly = cleanHref.split('?')[0]
  const parts = pathOnly.split('/').filter(Boolean)
  if (parts.length !== 4 || parts[0] !== 'card') {
    throw Object.assign(new Error('Expected card href shaped like /card/{game}/{set}/{card}'), { status: 400 })
  }

  const [, game, set, card] = parts
  if (!VALID_GAMES.has(game)) throw Object.assign(new Error('Unsupported game slug'), { status: 400 })
  if (!set || !card) throw Object.assign(new Error('Missing set or card slug'), { status: 400 })
  return { game, set, card }
}

async function settleObject(tasks) {
  const entries = await Promise.all(Object.entries(tasks).map(async ([key, promise]) => {
    const result = await Promise.resolve(promise).then(
      (value) => ({ key, value, error: null }),
      (error) => ({ key, value: null, error: error?.message || String(error) })
    )
    return result
  }))

  return entries.reduce((acc, entry) => {
    acc.values[entry.key] = entry.value
    if (entry.error) acc.errors[entry.key] = entry.error
    return acc
  }, { values: {}, errors: {} })
}

router.get('/health', asyncRoute(async (_req, res) => {
  const health = await requestUpstream('/v1/health', { cacheTtlMs: 15_000 })
  res.json({
    ok: true,
    authenticated: Boolean(API_KEY && API_SECRET),
    upstream: health.data,
    rateLimit: health.rateLimit,
    fetchedAt: health.fetchedAt,
    cached: health.cached,
  })
}))

router.get('/bootstrap', asyncRoute(async (req, res) => {
  const featuredLimit = clampInt(req.query.featuredLimit, 12, 1, 48)
  const tradeLimit = clampInt(req.query.tradeLimit, 12, 1, 50)
  const { values, errors } = await settleObject({
    indices: requestUpstream('/v1/indices', { cacheTtlMs: 45_000 }),
    featured: requestUpstream('/v1/cards/featured', { params: { limit: featuredLimit }, cacheTtlMs: 45_000 }),
    recentTrades: requestUpstream('/v1/trades/recent', { params: { limit: tradeLimit }, cacheTtlMs: 25_000 }),
  })

  res.json({
    fetchedAt: new Date().toISOString(),
    authenticated: Boolean(API_KEY && API_SECRET),
    indices: values.indices?.data?.indices || [],
    featured: values.featured?.data?.cards || [],
    recentTrades: values.recentTrades?.data?.trades || [],
    rateLimits: {
      indices: values.indices?.rateLimit,
      featured: values.featured?.rateLimit,
      recentTrades: values.recentTrades?.rateLimit,
    },
    errors,
  })
}))

router.get('/indices', asyncRoute(async (_req, res) => {
  const result = await requestUpstream('/v1/indices', { cacheTtlMs: 45_000 })
  res.json({
    indices: result.data?.indices || [],
    rateLimit: result.rateLimit,
    fetchedAt: result.fetchedAt,
    cached: result.cached,
  })
}))

router.get('/indices/:game', asyncRoute(async (req, res) => {
  const game = safeString(req.params.game, 40)
  if (!VALID_GAMES.has(game)) throw Object.assign(new Error('Unsupported index game'), { status: 400 })
  const window = pickWindow(req.query.window, INDEX_WINDOWS, '365')

  const { values, errors } = await settleObject({
    detail: requestUpstream(`/v1/indices/${encodeURIComponent(game)}`, { cacheTtlMs: 60_000 }),
    series: requestUpstream(`/v1/indices/${encodeURIComponent(game)}/series`, { params: { window }, cacheTtlMs: 60_000 }),
  })

  res.json({
    game,
    detail: values.detail?.data || null,
    series: values.series?.data || null,
    rateLimits: {
      detail: values.detail?.rateLimit,
      series: values.series?.rateLimit,
    },
    errors,
    fetchedAt: new Date().toISOString(),
  })
}))

router.get('/featured', asyncRoute(async (req, res) => {
  const limit = clampInt(req.query.limit, 24, 1, 48)
  const result = await requestUpstream('/v1/cards/featured', { params: { limit }, cacheTtlMs: 45_000 })
  res.json({ cards: result.data?.cards || [], rateLimit: result.rateLimit, fetchedAt: result.fetchedAt, cached: result.cached })
}))

router.get('/recent-trades', asyncRoute(async (req, res) => {
  const limit = clampInt(req.query.limit, 24, 1, 50)
  const result = await requestUpstream('/v1/trades/recent', { params: { limit }, cacheTtlMs: 25_000 })
  res.json({ trades: result.data?.trades || [], rateLimit: result.rateLimit, fetchedAt: result.fetchedAt, cached: result.cached })
}))

router.get('/search', asyncRoute(async (req, res) => {
  const q = safeString(req.query.q, 80)
  const character = safeString(req.query.character, 120)
  const limit = clampInt(req.query.limit, 12, 1, 30)
  const game = safeString(req.query.game, 40)
  const params = { q, character, limit }
  if (game && VALID_SEARCH_GAMES.has(game)) params.game = game
  const result = await requestUpstream('/v1/search', { params, cacheTtlMs: 45_000 })
  res.json({ query: result.data?.query || q || character, results: result.data?.results || [], rateLimit: result.rateLimit, fetchedAt: result.fetchedAt, cached: result.cached })
}))

router.get('/card', asyncRoute(async (req, res) => {
  const { game, set, card } = parseCardHref(req.query.href)
  const window = pickWindow(req.query.window, SERIES_WINDOWS, '90')
  const tradeWindow = clampInt(req.query.tradeWindow, 365, 1, 3650)
  const tradeLimit = clampInt(req.query.tradeLimit, 80, 1, 200)
  const cardPath = `/v1/cards/${encodeURIComponent(game)}/${encodeURIComponent(set)}/${encodeURIComponent(card)}`

  const { values, errors } = await settleObject({
    detail: requestUpstream(cardPath, { cacheTtlMs: 60_000 }),
    priceSeries: requestUpstream(`${cardPath}/series`, { params: { window }, cacheTtlMs: 60_000 }),
    fmvSeries: requestUpstream(`${cardPath}/fmv-series`, { params: { window }, cacheTtlMs: 60_000 }),
    trades: requestUpstream(`${cardPath}/trades`, { params: { window: tradeWindow, scope: 'grade', limit: tradeLimit }, cacheTtlMs: 45_000 }),
    similar: requestUpstream(`${cardPath}/similar`, { cacheTtlMs: 90_000 }),
  })

  res.json({
    href: `/card/${game}/${set}/${card}`,
    detail: values.detail?.data || null,
    priceSeries: values.priceSeries?.data || null,
    fmvSeries: values.fmvSeries?.data || null,
    trades: values.trades?.data?.trades || [],
    tradeTotal: values.trades?.data?.total || 0,
    sourceCounts: values.trades?.data?.sourceCounts || {},
    similar: values.similar?.data?.similar || [],
    errors,
    fetchedAt: new Date().toISOString(),
  })
}))

router.get('/graded/:cert', asyncRoute(async (req, res) => {
  const cert = safeString(req.params.cert, 80).replace(/\s+/g, '')
  if (!cert) throw Object.assign(new Error('Missing certification number'), { status: 400 })
  const result = await requestUpstream(`/v1/graded/${encodeURIComponent(cert)}`, { cacheTtlMs: 90_000, timeoutMs: 30_000 })
  res.json({ result: result.data, rateLimit: result.rateLimit, fetchedAt: result.fetchedAt, cached: result.cached })
}))

module.exports = router
