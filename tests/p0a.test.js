const test = require('node:test')
const assert = require('node:assert/strict')

const {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_USDC_ADDRESS,
  DEFAULT_AUTHORIZATION,
  DEMO_OFFERS,
} = require('../packages/shared')
const { validateAuthorization, validateOffer } = require('../packages/shared/validation')
const { getReplaySignal } = require('../packages/renaiss-client')
const { evaluateSignal } = require('../packages/policy-engine')
const { assertLiveSigningSecret, DEFAULT_SIGNING_SECRET } = require('../packages/market-proof')
const { runScout } = require('../backend/lib/scout-agent')

test('P0-A constants use Arc Testnet production values', () => {
  assert.equal(ARC_TESTNET_CHAIN_ID, 5042002)
  assert.equal(ARC_TESTNET_USDC_ADDRESS, '0x3600000000000000000000000000000000000000')
})

test('P0-A validates target card, expiry, amounts, enums, and seller address', () => {
  assert.equal(validateAuthorization(DEFAULT_AUTHORIZATION).ok, true)
  assert.equal(validateOffer(DEMO_OFFERS[0], new Date('2026-08-07T00:00:00.000Z')).ok, true)

  const invalid = { ...DEMO_OFFERS[0], sellerAddress: '0x123', expiresAt: '2020-01-01T00:00:00.000Z', askUsd: -1 }
  const result = validateOffer(invalid, new Date('2026-08-07T00:00:00.000Z'))
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /sellerAddress/)
  assert.match(result.errors.join('\n'), /expired/)
  assert.match(result.errors.join('\n'), /askUsd/)
})

test('P0-A replay Renaiss signal includes cert lookup and transaction-only observedAt trades', async () => {
  const signal = await getReplaySignal({ offer: DEMO_OFFERS[0] })
  assert.equal(signal.dataMode, 'replay')
  assert.equal(signal.identity.certFound, true)
  assert.equal(signal.identity.certMatchesOffer, true)
  assert.ok(signal.trades.recent.length >= 3)
  assert.ok(signal.trades.recent.every((trade) => trade.kind === 'transaction'))
  assert.ok(signal.trades.recent.every((trade) => trade.observedAt))
  assert.equal(signal.trades.listingCount, 2)
})

test('P0-A policy rejects missing valuation instead of passing price checks', () => {
  const signal = {
    identity: { certFound: true, certMatchesOffer: true, imageConfidence: 'high', certNumber: 'CERT' },
    valuation: { medianUsd: null, meanUsd: null, vwapUsd: null },
    quality: { confidence: 'prime', sourceCount: 2, observationCount: 10, lastSaleAt: '2026-08-06T00:00:00.000Z', refreshing: false },
  }
  const decision = evaluateSignal({ signal, offer: DEMO_OFFERS[0], authorization: DEFAULT_AUTHORIZATION, now: new Date('2026-08-07T00:00:00.000Z') })
  assert.equal(decision.action, 'REJECT')
  assert.ok(decision.hardFails.some((item) => item.id === 'valuation-present'))
})

test('P0-A live mode refuses default MarketProof signing secret', () => {
  const prev = process.env.MARKET_PROOF_SIGNING_SECRET
  delete process.env.MARKET_PROOF_SIGNING_SECRET
  assert.throws(() => assertLiveSigningSecret('live'), /MARKET_PROOF_SIGNING_SECRET/)
  process.env.MARKET_PROOF_SIGNING_SECRET = DEFAULT_SIGNING_SECRET
  assert.throws(() => assertLiveSigningSecret('live'), /MARKET_PROOF_SIGNING_SECRET/)
  process.env.MARKET_PROOF_SIGNING_SECRET = 'not-default-for-test'
  assert.doesNotThrow(() => assertLiveSigningSecret('live'))
  if (prev === undefined) delete process.env.MARKET_PROOF_SIGNING_SECRET
  else process.env.MARKET_PROOF_SIGNING_SECRET = prev
})

test('P0-A replay preserves success and rejection branches without fake live tx hash', async () => {
  const success = await runScout({ mode: 'replay', offerId: 'offer-charizard-350' })
  assert.equal(success.finalDecision.action, 'RESERVE')
  assert.equal(success.payment.confirmed, true)
  assert.equal(success.payment.status, 'replay-payment-confirmed')
  assert.equal(success.escrow.chainConfirmed, true)
  assert.equal(success.escrow.status, 'replay-escrow-confirmed')
  assert.equal(success.escrow.txHash, null)

  const priceReject = await runScout({ mode: 'replay', offerId: 'offer-charizard-430' })
  assert.equal(priceReject.finalDecision.action, 'REJECT')
  assert.equal(priceReject.payment, null)
  assert.equal(priceReject.escrow, null)

  const confidenceReject = await runScout({ mode: 'replay', offerId: 'offer-low-confidence' })
  assert.equal(confidenceReject.finalDecision.action, 'REJECT')
  assert.equal(confidenceReject.payment, null)
  assert.equal(confidenceReject.escrow, null)
})
