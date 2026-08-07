const router = require('express').Router()
const { buildMarketProof } = require('../../packages/market-proof')
const { payForMarketProof } = require('../lib/circle-adapters')
const { DEFAULT_AUTHORIZATION, DEMO_OFFERS } = require('../../packages/shared')

router.get('/quote', (_req, res) => {
  res.json({
    service: 'MarketProof',
    network: 'Arc Testnet',
    asset: 'USDC',
    priceUsdc: Number(process.env.MARKET_PROOF_PRICE_USDC || 0.001),
    paymentRail: 'Circle Gateway Nanopayments / x402-compatible demo adapter',
  })
})

router.post('/prove', async (req, res, next) => {
  try {
    const authorization = { ...DEFAULT_AUTHORIZATION, ...(req.body.authorization || {}) }
    const offer = req.body.offer || (req.body.offerId ? DEMO_OFFERS.find((item) => item.id === req.body.offerId) : null)
    if (!offer) throw new Error('offer or known offerId is required')
    const signal = req.body.signal
    if (!signal) throw new Error('signal is required')
    const payment = await payForMarketProof({ runId: req.body.runId || 'adhoc', offer, authorization, dataMode: 'live' })
    if (!payment.confirmed) {
      res.status(402).json({ payment, error: 'MarketProof payment not completed' })
      return
    }
    const proof = buildMarketProof({ signal, offer, authorization, payment })
    res.json({ payment, proof })
  } catch (error) {
    next(error)
  }
})

router.use((error, _req, res, _next) => {
  res.status(400).json({ error: 'MarketProof failed', message: error.message })
})

module.exports = router
