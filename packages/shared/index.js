const DEFAULT_AUTHORIZATION = Object.freeze({
  targetCard: 'Charizard · Japanese CLL Classic · PSA 10',
  maxOfferUsd: 360,
  maxPriceVsMedianPct: 90,
  minConfidence: 'high',
  minSourceCount: 2,
  minObservationCount: 5,
  maxLastSaleAgeDays: 14,
  maxMethodDeviationPct: 15,
  maxIntelFeeUsdc: 0.01,
  maxDepositUsdc: 0.5,
  dailyBudgetUsdc: 1,
  spentTodayUsdc: 0,
  requireMarketProof: true,
})

const DEMO_CARD = Object.freeze({
  game: 'pokemon',
  set: 'pokemon-japanese-cll-trading-card-game-classic-charizard-ho-oh-ex-deck',
  card: '003-charizard-psa-10-japanese-2800094f',
  href: '/card/pokemon/pokemon-japanese-cll-trading-card-game-classic-charizard-ho-oh-ex-deck/003-charizard-psa-10-japanese-2800094f',
})

const DEMO_OFFERS = Object.freeze([
  {
    id: 'offer-charizard-350',
    title: 'Seller A · clean discount',
    card: DEMO_CARD,
    askUsd: 350,
    depositUsdc: 0.1,
    sellerAddress: '0x5000000000000000000000000000000000000001',
    expiresAt: '2026-08-09T10:00:00.000Z',
    imageConfidence: 'high',
    certFound: true,
    narrative: '报价约低于 7 日中位价 11%，用于展示自动付费深查 + Arc 订金锁定。',
  },
  {
    id: 'offer-charizard-430',
    title: 'Seller B · overpriced branch',
    card: DEMO_CARD,
    askUsd: 430,
    depositUsdc: 0.1,
    sellerAddress: '0x5000000000000000000000000000000000000002',
    expiresAt: '2026-08-09T10:00:00.000Z',
    imageConfidence: 'high',
    certFound: true,
    narrative: '报价高于 7 日中位价 90% 的授权阈值，必须拒绝且不发生支付。',
  },
  {
    id: 'offer-low-confidence',
    title: 'Seller C · weak data branch',
    card: DEMO_CARD,
    askUsd: 340,
    depositUsdc: 0.1,
    sellerAddress: '0x5000000000000000000000000000000000000003',
    expiresAt: '2026-08-09T10:00:00.000Z',
    imageConfidence: 'medium',
    certFound: false,
    forceLowConfidence: true,
    narrative: '身份/数据质量不足，即使价格便宜也不能自动锁订金。',
  },
])

const CONFIDENCE_RANK = Object.freeze({
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  prime: 4,
})

function usdFromCents(cents) {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return null
  return Math.round(cents) / 100
}

function centsFromUsd(usd) {
  if (typeof usd !== 'number' || !Number.isFinite(usd)) return null
  return Math.round(usd * 100)
}

function round(value, digits = 2) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function pctDiff(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number' || b === 0) return null
  return Math.abs((a - b) / b) * 100
}

function confidenceMeets(value, minimum) {
  return (CONFIDENCE_RANK[value] || 0) >= (CONFIDENCE_RANK[minimum] || 0)
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

module.exports = {
  DEFAULT_AUTHORIZATION,
  DEMO_CARD,
  DEMO_OFFERS,
  CONFIDENCE_RANK,
  usdFromCents,
  centsFromUsd,
  round,
  pctDiff,
  confidenceMeets,
  stableJson,
}
