const routerModule = require('express').Router
const { buildMarketProof, verifyMarketProof, assertLiveSigningSecret } = require('../../packages/market-proof')
const { DEMO_OFFERS, ARC_TESTNET_CHAIN_ID, ARC_TESTNET_USDC_ADDRESS, ARC_TESTNET_NAME } = require('../../packages/shared')
const { validateAuthorization, validateOffer, unknownAuthorizationFields, nonZeroAddress } = require('../../packages/shared/validation')
const { getCardSignal } = require('../../packages/renaiss-client')
const { mergeAuthorization } = require('../lib/scout-agent')
const { resolveEffectiveMode } = require('../lib/mode')
const { rateLimit } = require('../lib/rate-limit')

const BODY_FIELDS = Object.freeze(['offerId', 'runId', 'idempotencyKey', 'mode', 'authorization'])
const MAX_IDENTIFIER_LENGTH = 160

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function requestError(message, statusCode = 400) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function assertIdentifier(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw requestError(`${field} must be a non-empty string`)
  if (value.length > MAX_IDENTIFIER_LENGTH) throw requestError(`${field} exceeds ${MAX_IDENTIFIER_LENGTH} characters`)
  return value
}

function assertResult(label, result) {
  if (!result.ok) throw requestError(`${label}: ${result.errors.join('; ')}`)
}

function assertServerReady(authorization) {
  try {
    assertLiveSigningSecret('live')
  } catch (error) {
    throw requestError(error.message, 503)
  }
  if (!process.env.RENAISS_API_KEY || !process.env.RENAISS_API_SECRET) throw requestError('Renaiss credentials are required before paid MarketProof generation', 503)
  if (!nonZeroAddress(process.env.MARKET_PROOF_SELLER_ADDRESS)) throw requestError('MARKET_PROOF_SELLER_ADDRESS must be a valid non-zero EVM address', 503)
  const priceUsdc = Number(process.env.MARKET_PROOF_PRICE_USDC || 0.001)
  if (!Number.isFinite(priceUsdc) || priceUsdc <= 0) throw requestError('MARKET_PROOF_PRICE_USDC must be a positive number')
  if (priceUsdc > Number(authorization.maxIntelFeeUsdc)) throw requestError('MARKET_PROOF_PRICE_USDC exceeds authorization.maxIntelFeeUsdc')
}

function assertAuthorizationMatchesOffer(authorization, offer) {
  for (const field of ['targetCard', 'targetItemId', 'targetHref', 'certNumber', 'company', 'gradeLabel']) {
    if (authorization[field] !== offer[field]) throw requestError(`authorization ${field} does not match trusted offer`)
  }
}

function validateProofRequestBody(body = {}, { offers = DEMO_OFFERS, now = new Date() } = {}) {
  if (!isPlainObject(body)) throw requestError('proof request body must be a JSON object')
  const extras = Object.keys(body).filter((key) => !BODY_FIELDS.includes(key))
  if (extras.length > 0) throw requestError(`unsupported proof request fields: ${extras.join(', ')}`)
  if (body.mode !== 'live') throw requestError('mode: "live" is required for paid MarketProof generation')
  const mode = resolveEffectiveMode(body.mode, process.env.SLABSCOUT_DEFAULT_MODE || 'replay')
  if (mode !== 'live') throw requestError('mode: "live" is required for paid MarketProof generation')
  const offerId = assertIdentifier(body.offerId, 'offerId')
  const runId = assertIdentifier(body.runId, 'runId')
  const idempotencyKey = assertIdentifier(body.idempotencyKey, 'idempotencyKey')
  const offer = offers.find((item) => item.id === offerId)
  if (!offer) throw requestError('known offerId is required')
  assertResult('offer', validateOffer(offer, now))
  if (!isPlainObject(body.authorization)) throw requestError('authorization must be a JSON object')
  const unknownAuth = unknownAuthorizationFields(body.authorization)
  if (unknownAuth.length > 0) throw requestError(`unsupported authorization fields: ${unknownAuth.join(', ')}`)
  const authorization = mergeAuthorization(body.authorization)
  assertResult('authorization', validateAuthorization(authorization))
  assertAuthorizationMatchesOffer(authorization, offer)
  assertServerReady(authorization)
  return { mode, offer, authorization, runId, idempotencyKey }
}

function strictProofRequest(req, _res, next, options = {}) {
  try {
    if (req.body?.signal || req.body?.valuation || req.body?.trades) throw requestError('client-submitted signal/valuation/trades are not accepted')
    req.validatedProofRequest = validateProofRequestBody(req.body, options)
    req.effectiveMode = req.validatedProofRequest.mode
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
      next(requestError(`MarketProof x402 seller config missing: ${missing.join(', ')}`, 503))
    }
  }
  let createGatewayMiddlewareFn
  try {
    ;({ createGatewayMiddleware: createGatewayMiddlewareFn } = require('@circle-fin/x402-batching/server'))
  } catch (error) {
    return (_req, _res, next) => {
      next(requestError(`@circle-fin/x402-batching seller middleware unavailable: ${error.message}`, 503))
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
    providerNetwork: payment.network || null,
    chainId: payment.network === `eip155:${ARC_TESTNET_CHAIN_ID}` ? ARC_TESTNET_CHAIN_ID : null,
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

async function buildSellerProofResponse({ request, body, payment }) {
  const validated = request || validateProofRequestBody(body)
  const { mode, offer, authorization, runId, idempotencyKey } = validated
  const proofSignal = await getCardSignal({ mode, card: offer.card, offer, authorization })
  if (proofSignal.dataMode === 'REPLAY_FALLBACK') throw requestError('Renaiss fallback blocks paid proof generation', 503)
  if (proofSignal.identity?.certFound !== true || proofSignal.identity?.certMatchesOffer !== true) throw requestError('cert/card/offer identity mismatch', 422)
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
    const error = requestError('MarketProof self-verification failed', 422)
    error.verification = verification
    throw error
  }
  return { payment, proof: verification.proof, verification, authorization }
}

function createProofRouter({ gatewayMiddlewareFactory = createGatewayMiddleware, offers = DEMO_OFFERS } = {}) {
  const router = routerModule()
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

  router.post('/prove', rateLimit({ windowMs: 60_000, max: 30 }), (req, res, next) => strictProofRequest(req, res, next, { offers }), (req, res, next) => {
    gatewayMiddlewareFactory()(req, res, next)
  }, async (req, res, next) => {
    try {
      const validated = req.validatedProofRequest
      const payload = await buildSellerProofResponse({
        request: validated,
        payment: paidRequestToPayment(req, validated),
      })
      res.json(payload)
    } catch (error) {
      if (error.statusCode) {
        res.status(error.statusCode).json({ error: error.message, verification: error.verification || undefined })
        return
      }
      next(error)
    }
  })

  router.use((error, _req, res, _next) => {
    res.status(error.statusCode || 400).json({ error: 'MarketProof failed', message: error.message })
  })
  return router
}

const defaultRouter = createProofRouter()
defaultRouter.createProofRouter = createProofRouter
defaultRouter._internals = { strictProofRequest, paidRequestToPayment, buildSellerProofResponse, createGatewayMiddleware, validateProofRequestBody, assertAuthorizationMatchesOffer }

module.exports = defaultRouter
