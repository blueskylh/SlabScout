const crypto = require('node:crypto')
const {
  stableJson,
  round,
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_USDC_ADDRESS,
  ARC_TESTNET_NAME,
  DEFAULT_MARKET_PROOF_PRICE_USDC,
} = require('../../packages/shared')
const { nonZeroAddress, validProofHash, validateRuntimeConfig, assertValid } = require('../../packages/shared/validation')
const { verifyMarketProof, verifyPolicyProof, verifyPaymentReceipt } = require('../../packages/market-proof')
const { persistentStoreConfigured } = require('./state-store')

function deterministicHash(prefix, payload) {
  return `${prefix}${crypto.createHash('sha256').update(stableJson(payload)).digest('hex')}`
}

function positiveNumber(value, fallback = null) {
  const parsed = Number(value)
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  return fallback
}

function assertBaseRuntimeConfig({ live = false } = {}) {
  assertValid('runtime config', validateRuntimeConfig(process.env, { live }))
}

function missingLivePaymentEnv() {
  const required = ['CIRCLE_API_KEY', 'CIRCLE_AGENT_WALLET_ADDRESS', 'MARKET_PROOF_SERVICE_URL', 'MARKET_PROOF_PAYEE']
  if (!persistentStoreConfigured()) required.push('SLABSCOUT_STATE_FILE or DATABASE_URL')
  return required.filter((key) => {
    if (key.includes(' or ')) return !persistentStoreConfigured()
    return !process.env[key]
  })
}

function missingLiveEscrowEnv() {
  const required = ['RESERVATION_ESCROW_ADDRESS', 'AGENT_WALLET_ADDRESS']
  if (!persistentStoreConfigured()) required.push('SLABSCOUT_STATE_FILE or DATABASE_URL')
  return required.filter((key) => {
    if (key.includes(' or ')) return !persistentStoreConfigured()
    return !process.env[key]
  })
}

async function payForMarketProof({ runId, idempotencyKey, offer, authorization, dataMode = 'live' }) {
  assertBaseRuntimeConfig()
  const amountUsdc = positiveNumber(process.env.MARKET_PROOF_PRICE_USDC, positiveNumber(authorization.intelFeeUsdc, DEFAULT_MARKET_PROOF_PRICE_USDC))
  const maxIntelFeeUsdc = positiveNumber(authorization.maxIntelFeeUsdc)
  if (!amountUsdc || !maxIntelFeeUsdc) throw new Error('Invalid MarketProof fee authorization')
  if (amountUsdc > maxIntelFeeUsdc) throw new Error('MarketProof fee exceeds authorization')
  if (dataMode === 'REPLAY_FALLBACK') throw new Error('Live Renaiss failure entered REPLAY_FALLBACK; real payment is prohibited')

  const mode = process.env.CIRCLE_MODE || 'mock'
  const receiptPayload = {
    paymentKind: 'MarketProofPayment',
    runId,
    idempotencyKey: idempotencyKey || null,
    offerId: offer.id,
    targetItemId: offer.targetItemId,
    targetHref: offer.targetHref,
    certNumber: offer.certNumber,
    payerWallet: process.env.CIRCLE_AGENT_WALLET_ADDRESS || process.env.AGENT_WALLET_ADDRESS || null,
    payeeService: process.env.MARKET_PROOF_PAYEE || 'slabscout-market-proof-replay-service',
    amountUsdc,
    network: ARC_TESTNET_NAME,
    chainId: ARC_TESTNET_CHAIN_ID,
    asset: 'USDC',
    usdcAddress: ARC_TESTNET_USDC_ADDRESS,
    paidAt: new Date().toISOString(),
    mode,
    dataMode,
  }

  if (dataMode === 'replay') {
    const payment = {
      ...receiptPayload,
      status: 'replay-payment-simulated',
      providerStatus: 'simulated',
      confirmed: false,
      simulated: true,
      replayAccepted: true,
      receiptId: deterministicHash('replay_pay_', receiptPayload).slice(0, 35),
      circlePaymentId: null,
      txHash: null,
      explorerUrl: null,
      note: 'Replay simulation only: not a live Circle payment receipt and no wallet was called.',
    }
    const verification = verifyPaymentReceipt({ payment, runId, idempotencyKey: idempotencyKey || null, offer, authorization, expectedMode: 'replay' })
    return { ...payment, verification }
  }

  if (mode !== 'live') {
    return {
      ...receiptPayload,
      status: 'mock-payment-required',
      providerStatus: 'not-submitted',
      confirmed: false,
      simulated: false,
      replayAccepted: false,
      receiptId: null,
      circlePaymentId: null,
      txHash: null,
      explorerUrl: null,
      verification: { ok: false, errors: ['mock mode does not create a verified Circle receipt'] },
      note: `Mock mode only quotes Circle payment. Official CLI pattern: circle services pay <x402-service-url> --address <agent-wallet-address> --chain <chain> --max-amount ${round(amountUsdc, 6)}`,
    }
  }

  const missingEnv = missingLivePaymentEnv()
  if (missingEnv.length > 0) {
    return {
      ...receiptPayload,
      status: 'live-unavailable/config-missing',
      providerStatus: 'not-submitted',
      confirmed: false,
      simulated: false,
      replayAccepted: false,
      receiptId: null,
      circlePaymentId: null,
      txHash: null,
      explorerUrl: null,
      missingEnv,
      verification: { ok: false, errors: [`Missing live Circle config: ${missingEnv.join(', ')}`] },
      note: 'Live Circle/x402 payment is disabled until server-side Circle wallet, x402 service, and persistent state configuration are provided.',
    }
  }

  return {
    ...receiptPayload,
    status: 'live-unavailable/not-implemented',
    providerStatus: 'not-submitted',
    confirmed: false,
    simulated: false,
    replayAccepted: false,
    receiptId: null,
    circlePaymentId: null,
    txHash: null,
    explorerUrl: null,
    verification: { ok: false, errors: ['Circle Agent Wallet/x402 live adapter requires deployment credentials and must be completed against Circle production docs before spending funds'] },
    note: 'Fail-closed live placeholder: no success is returned without a re-confirmed Circle payment receipt or transaction hash.',
  }
}

async function reserveEscrow({ runId, idempotencyKey, offer, proof, authorization, dataMode = 'live', payment = null, decision = null }) {
  assertBaseRuntimeConfig({ live: dataMode !== 'replay' && process.env.ARC_EXECUTION_MODE === 'live' })
  const amountUsdc = positiveNumber(offer.depositUsdc)
  const maxDepositUsdc = positiveNumber(authorization.maxDepositUsdc)
  if (!amountUsdc || !maxDepositUsdc) throw new Error('Invalid deposit authorization')
  if (!validProofHash(proof?.proofHash)) throw new Error('Valid 32-byte proofHash is required before escrow reservation')
  if (amountUsdc > maxDepositUsdc) throw new Error('Deposit exceeds authorization')
  if (dataMode === 'REPLAY_FALLBACK') throw new Error('Live Renaiss failure entered REPLAY_FALLBACK; escrow reservation is prohibited')

  const verification = authorization.requireMarketProof
    ? verifyMarketProof({ proof, offer, authorization, payment, runId, idempotencyKey: idempotencyKey || null, expectedMode: dataMode })
    : verifyPolicyProof({ proof, offer, authorization, decision, runId, idempotencyKey: idempotencyKey || null, expectedMode: dataMode })
  if (!verification.ok) throw new Error(`${verification.proofKind} verification failed before escrow: ${verification.errors.join('; ')}`)

  const mode = process.env.ARC_EXECUTION_MODE || 'mock'
  const payload = {
    runId,
    idempotencyKey: idempotencyKey || null,
    offerId: offer.id,
    targetItemId: offer.targetItemId,
    targetHref: offer.targetHref,
    certNumber: offer.certNumber,
    seller: offer.sellerAddress || process.env.SELLER_WALLET_ADDRESS,
    buyer: process.env.AGENT_WALLET_ADDRESS || '0xA9E0000000000000000000000000000000000001',
    escrow: process.env.RESERVATION_ESCROW_ADDRESS || null,
    usdc: process.env.ARC_USDC_ADDRESS || ARC_TESTNET_USDC_ADDRESS,
    chainId: positiveNumber(process.env.ARC_CHAIN_ID, ARC_TESTNET_CHAIN_ID),
    amountUsdc,
    proofHash: proof.proofHash,
    reservedAt: new Date().toISOString(),
    mode,
    dataMode,
    proofKind: proof.proofKind,
  }
  const offerHash = deterministicHash('0x', { offerId: offer.id, targetItemId: offer.targetItemId }).slice(0, 66)

  if (dataMode === 'replay') {
    return {
      ...payload,
      offerHash,
      txHash: null,
      blockNumber: null,
      arcscanUrl: null,
      status: 'replay-escrow-simulated',
      chainConfirmed: false,
      simulated: true,
      replayAccepted: true,
      event: null,
      note: 'Replay simulation only: not a live Arc Testnet transaction and no wallet was called.',
      verification,
    }
  }

  if (mode !== 'live') {
    return {
      ...payload,
      offerHash,
      txHash: null,
      blockNumber: null,
      arcscanUrl: null,
      status: 'mock-reservation-required',
      chainConfirmed: false,
      simulated: false,
      replayAccepted: false,
      event: null,
      note: 'Mock mode does not generate fake transaction hashes. Use a live Circle Agent Wallet adapter to approve USDC and call reserve on Arc Testnet.',
      verification,
    }
  }

  const missingEnv = missingLiveEscrowEnv()
  if (missingEnv.length > 0) {
    return {
      ...payload,
      offerHash,
      txHash: null,
      blockNumber: null,
      arcscanUrl: null,
      status: 'live-unavailable/config-missing',
      chainConfirmed: false,
      simulated: false,
      replayAccepted: false,
      event: null,
      missingEnv,
      note: `Live Arc escrow unavailable; missing ${missingEnv.join(', ')}.`,
      verification,
    }
  }

  if (!nonZeroAddress(payload.seller) || !nonZeroAddress(payload.buyer) || !nonZeroAddress(payload.escrow)) throw new Error('Live escrow requires non-zero seller, buyer, and escrow EVM addresses')
  return {
    ...payload,
    offerHash,
    txHash: null,
    blockNumber: null,
    arcscanUrl: null,
    status: 'live-unavailable/not-implemented',
    chainConfirmed: false,
    simulated: false,
    replayAccepted: false,
    event: null,
    note: 'Fail-closed live placeholder: no chain-confirmed status is returned without a real tx receipt and matching Reserved event.',
    verification,
  }
}

module.exports = {
  payForMarketProof,
  reserveEscrow,
  verifyPaymentReceipt,
  assertBaseRuntimeConfig,
  missingLivePaymentEnv,
  missingLiveEscrowEnv,
}
