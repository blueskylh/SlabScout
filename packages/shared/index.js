const {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_USDC_ADDRESS,
  ZERO_ADDRESS,
  DEFAULT_MARKET_PROOF_PRICE_USDC,
  DEFAULT_ESCROW_DEPOSIT_USDC,
  DEMO_TARGET,
} = require('./constants')

const DEFAULT_AUTHORIZATION = Object.freeze({
  targetCard: DEMO_TARGET.targetCard,
  targetItemId: DEMO_TARGET.targetItemId,
  targetRenaissItemId: DEMO_TARGET.targetRenaissItemId,
  targetHref: DEMO_TARGET.targetHref,
  certNumber: DEMO_TARGET.certNumber,
  company: DEMO_TARGET.company,
  gradeLabel: DEMO_TARGET.gradeLabel,
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
})

const DEMO_CARD = Object.freeze({
  game: 'pokemon',
  set: 'tag-all-stars',
  card: '16-reshiram-charizard-gx-psa-10-japanese-6e7fdc9a',
  href: DEMO_TARGET.targetHref,
})

function makeDemoOffer(id, overrides) {
  return Object.freeze({
    id,
    title: overrides.title,
    card: DEMO_CARD,
    targetCard: DEMO_TARGET.targetCard,
    targetItemId: DEMO_TARGET.targetItemId,
    targetRenaissItemId: DEMO_TARGET.targetRenaissItemId,
    targetHref: DEMO_TARGET.targetHref,
    certNumber: DEMO_TARGET.certNumber,
    company: DEMO_TARGET.company,
    gradeLabel: DEMO_TARGET.gradeLabel,
    askUsd: overrides.askUsd,
    depositUsdc: DEFAULT_ESCROW_DEPOSIT_USDC,
    sellerAddress: overrides.sellerAddress,
    expiresAt: '2030-08-09T10:00:00.000Z',
    imageConfidence: overrides.imageConfidence,
    certFound: overrides.certFound,
    forceLowConfidence: overrides.forceLowConfidence || false,
    narrative: overrides.narrative,
  })
}

const DEMO_OFFERS = Object.freeze([
  makeDemoOffer('offer-reshizard-95', {
    title: 'Seller A · verified discount',
    askUsd: 95,
    sellerAddress: '0x5000000000000000000000000000000000000001',
    imageConfidence: 'high',
    certFound: true,
    narrative: '真实 PSA cert 80396943 对应 Reshiram & Charizard-GX PSA 10，报价低于授权阈值。',
  }),
  makeDemoOffer('offer-reshizard-120', {
    title: 'Seller B · overpriced branch',
    askUsd: 120,
    sellerAddress: '0x5000000000000000000000000000000000000002',
    imageConfidence: 'high',
    certFound: true,
    narrative: '报价高于授权价格上限，必须拒绝且不发生支付。',
  }),
  makeDemoOffer('offer-low-confidence', {
    title: 'Seller C · weak data branch',
    askUsd: 90,
    sellerAddress: '0x5000000000000000000000000000000000000003',
    imageConfidence: 'medium',
    certFound: true,
    forceLowConfidence: true,
    narrative: '数据质量被压低，即使价格便宜也不能自动锁订金。',
  }),
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
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_USDC_ADDRESS,
  ZERO_ADDRESS,
  DEFAULT_MARKET_PROOF_PRICE_USDC,
  DEFAULT_ESCROW_DEPOSIT_USDC,
  DEMO_TARGET,
}
