const router = require('express').Router()
const { buildMarketProof, verifyMarketProof } = require('../../packages/market-proof')
const { payForMarketProof } = require('../lib/circle-adapters')
const { DEFAULT_AUTHORIZATION, DEMO_OFFERS } = require('../../packages/shared')
const { getCardSignal } = require('../../packages/renaiss-client')
const { requireOperatorForLive } = require('../lib/operator-auth')

router.get('/quote', (_req, res) => {
  res.json({
    service: 'MarketProof',
    network: 'Arc Testnet',
    chainId: 5042002,
    asset: 'USDC',
    usdcAddress: '0x3600000000000000000000000000000000000000',
    priceUsdc: Number(process.env.MARKET_PROOF_PRICE_USDC || 0.001),
    paymentRail: 'Circle/x402-compatible server-side adapter',
    note: 'Proof generation never signs client-submitted signal/valuation/trades.',
  })
})

router.post('/prove', requireOperatorForLive, async (req, res, next) => {
  try {
    if (req.body.signal || req.body.valuation || req.body.trades) throw new Error('client-submitted signal/valuation/trades are not accepted')
    const mode = req.body.mode || 'replay'
    const authorization = { ...DEFAULT_AUTHORIZATION, ...(req.body.authorization || {}), spentTodayUsdc: 0 }
    const offer = req.body.offerId ? DEMO_OFFERS.find((item) => item.id === req.body.offerId) : null
    if (!offer) throw new Error('known offerId is required')
    const runId = req.body.runId || `adhoc_${Date.now()}`
    const idempotencyKey = req.body.idempotencyKey || `adhoc_${offer.id}`

    const prePaymentSignal = await getCardSignal({ mode, card: offer.card, offer, authorization })
    if (prePaymentSignal.dataMode === 'REPLAY_FALLBACK') {
      res.status(503).json({ error: 'Renaiss live fallback blocks payment', signal: prePaymentSignal })
      return
    }

    const payment = await payForMarketProof({ runId, idempotencyKey, offer, authorization, dataMode: prePaymentSignal.dataMode })
    if (!payment.verification?.ok) {
      res.status(402).json({ payment, error: 'MarketProof payment not completed or not verifiable' })
      return
    }

    const proofSignal = await getCardSignal({ mode, card: offer.card, offer, authorization })
    if (proofSignal.dataMode === 'REPLAY_FALLBACK') {
      res.status(503).json({ error: 'Renaiss fallback after payment blocks proof generation', payment, signal: proofSignal })
      return
    }
    const proof = buildMarketProof({ signal: proofSignal, offer, authorization, payment, runId, idempotencyKey })
    const verification = verifyMarketProof({ proof, offer, authorization, payment, runId, idempotencyKey, expectedMode: mode })
    if (!verification.ok) {
      res.status(422).json({ error: 'MarketProof self-verification failed', verification })
      return
    }
    res.json({ payment, proof: verification.proof, verification })
  } catch (error) {
    next(error)
  }
})

router.use((error, _req, res, _next) => {
  res.status(error.statusCode || 400).json({ error: 'MarketProof failed', message: error.message })
})

module.exports = router
