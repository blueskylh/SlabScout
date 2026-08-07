const router = require('express').Router()
const { buildMarketProof, verifyMarketProof } = require('../../packages/market-proof')
const { DEFAULT_AUTHORIZATION, DEMO_OFFERS, ARC_TESTNET_CHAIN_ID, ARC_TESTNET_USDC_ADDRESS, ARC_TESTNET_NAME } = require('../../packages/shared')
const { getCardSignal } = require('../../packages/renaiss-client')
const { resolveEffectiveMode } = require('../lib/mode')
const { rateLimit } = require('../lib/rate-limit')

function strictProofRequest(req, _res, next) {
  try {
    req.effectiveMode = resolveEffectiveMode(req.body?.mode, process.env.SLABSCOUT_DEFAULT_MODE || 'replay')
    if (req.body.signal || req.body.valuation || req.body.trades) throw new Error('client-submitted signal/valuation/trades are not accepted')
    const allowed = ['offerId', 'runId', 'idempotencyKey', 'mode', 'authorization']
    const extras = Object.keys(req.body || {}).filter((key) => !allowed.includes(key))
    if (extras.length > 0) throw new Error(`unsupported proof request fields: ${extras.join(', ')}`)
    if (!req.body.offerId || !req.body.runId || !req.body.idempotencyKey) throw new Error('offerId, runId, and idempotencyKey are required')
    next()
  } catch (error) {
    error.statusCode = error.statusCode || 400
    next(error)
  }
}

function missingSellerEnv() {
  return ['MARKET_PROOF_SELLER_ADDRESS'].filter((key) => !process.env[key])
}

function createGatewayMiddleware() {
  const missing = missingSellerEnv()
  if (missing.length > 0) {
    return (_req, _res, next) => {
      const error = new Error(`MarketProof x402 seller config missing: ${missing.join(', ')}`)
      error.statusCode = 503
      next(error)
    }
  }
  let createGatewayMiddlewareFn
  try {
    ;({ createGatewayMiddleware: createGatewayMiddlewareFn } = require('@circle-fin/x402-batching/server'))
  } catch (error) {
    return (_req, _res, next) => {
      const err = new Error(`@circle-fin/x402-batching seller middleware unavailable: ${error.message}`)
      err.statusCode = 503
      next(err)
    }
  }
  const gateway = createGatewayMiddlewareFn({
    sellerAddress: process.env.MARKET_PROOF_SELLER_ADDRESS,
    networks: [`eip155:${ARC_TESTNET_CHAIN_ID}`],
    facilitatorUrl: process.env.CIRCLE_GATEWAY_FACILITATOR_URL || 'https://gateway-api-testnet.circle.com',
  })
  return gateway.require(`$${Number(process.env.MARKET_PROOF_PRICE_USDC || 0.001)}`)
}

function paidRequestToPayment(req, { offer, runId, idempotencyKey }) {
  const payment = req.payment || {}
  const amountMinor = payment.amount !== undefined ? BigInt(payment.amount) : 0n
  const providerNetwork = payment.network || null
  const providerChainId = providerNetwork === `eip155:${ARC_TESTNET_CHAIN_ID}` ? ARC_TESTNET_CHAIN_ID : null

  return {
    paymentKind: 'MarketProofPayment',
    runId,
    idempotencyKey,
    offerId: offer.id,
    targetItemId: offer.targetItemId,
    targetHref: offer.targetHref,
    payerWallet: payment.payer || payment.from || null,
    payeeService: 'circle-gateway-x402',
    payeeAddress: process.env.MARKET_PROOF_SELLER_ADDRESS,
    network: ARC_TESTNET_NAME,
    providerNetwork,
    chainId: providerChainId,
    asset: 'USDC',
    usdcAddress: ARC_TESTNET_USDC_ADDRESS,
    amountUsdc: Number(amountMinor) / 1_000_000,
    receiptId: payment.settlementId || payment.transaction || payment.paymentId || null,
    circlePaymentId: payment.settlementId || payment.paymentId || null,
    txHash: payment.transaction || null,
    paidAt: new Date().toISOString(),
    providerStatus: payment.verified === true ? 'settled' : 'unverified',
    confirmed: payment.verified === true,
    simulated: false,
    replayAccepted: false,
    middleware: 'createGatewayMiddleware(@circle-fin/x402-batching)',
  }
}

router.get('/quote', (_req, res) => {
  res.json({
    service: 'MarketProof',
    network: ARC_TESTNET_NAME,
    chainId: ARC_TESTNET_CHAIN_ID,
    asset: 'USDC',
    usdcAddress: ARC_TESTNET_USDC_ADDRESS,
    priceUsdc: Number(process.env.MARKET_PROOF_PRICE_USDC || 0.001),
    paymentRail: 'Circle Gateway nanopayments / x402 seller middleware',
    sellerAddressConfigured: Boolean(process.env.MARKET_PROOF_SELLER_ADDRESS),
    note: 'Proof generation never signs client-submitted signal/valuation/trades.',
  })
})

router.post('/prove', rateLimit({ windowMs: 60_000, max: 30 }), strictProofRequest, (req, res, next) => {
  if (req.effectiveMode !== 'live') {
    const error = new Error('/api/market-proof/prove is the live x402 seller endpoint; replay runs use internal simulation')
    error.statusCode = 400
    next(error)
    return
  }
  createGatewayMiddleware()(req, res, next)
}, async (req, res, next) => {
  try {
    const mode = req.effectiveMode
    const authorization = { ...DEFAULT_AUTHORIZATION, ...(req.body.authorization || {}), spentTodayUsdc: 0 }
    const offer = DEMO_OFFERS.find((item) => item.id === req.body.offerId)
    if (!offer) throw new Error('known offerId is required')
    const runId = req.body.runId
    const idempotencyKey = req.body.idempotencyKey
    const payment = paidRequestToPayment(req, { offer, runId, idempotencyKey })

    const proofSignal = await getCardSignal({ mode, card: offer.card, offer, authorization })
    if (proofSignal.dataMode === 'REPLAY_FALLBACK') {
      res.status(503).json({ error: 'Renaiss fallback blocks paid proof generation' })
      return
    }
    if (proofSignal.identity?.certFound !== true || proofSignal.identity?.certMatchesOffer !== true) {
      res.status(422).json({ error: 'cert/card/offer identity mismatch' })
      return
    }
    const proof = buildMarketProof({ signal: proofSignal, offer, authorization, payment, runId, idempotencyKey })
    const verification = await verifyMarketProof({
      proof,
      offer,
      authorization,
      payment,
      runId,
      idempotencyKey,
      expectedMode: mode,
      expectedPayerWallet: payment.payerWallet,
      expectedPayeeAddress: process.env.MARKET_PROOF_SELLER_ADDRESS,
    })
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
