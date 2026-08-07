const crypto = require('node:crypto')
const { stableJson, round, ARC_TESTNET_CHAIN_ID, ARC_TESTNET_USDC_ADDRESS } = require('../../packages/shared')
const { nonZeroAddress, validProofHash, validateRuntimeConfig, assertValid } = require('../../packages/shared/validation')

function deterministicHash(prefix, payload) {
  return `${prefix}${crypto.createHash('sha256').update(stableJson(payload)).digest('hex')}`
}

function positiveNumber(value, fallback = null) {
  const parsed = Number(value)
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  return fallback
}

function assertBaseRuntimeConfig() {
  assertValid('runtime config', validateRuntimeConfig(process.env))
}

async function payForMarketProof({ runId, offer, authorization, dataMode = 'live' }) {
  assertBaseRuntimeConfig()
  const amountUsdc = positiveNumber(process.env.MARKET_PROOF_PRICE_USDC, positiveNumber(authorization.intelFeeUsdc, 0.001))
  const maxIntelFeeUsdc = positiveNumber(authorization.maxIntelFeeUsdc)
  if (!amountUsdc || !maxIntelFeeUsdc) throw new Error('Invalid MarketProof fee authorization')
  if (amountUsdc > maxIntelFeeUsdc) throw new Error('MarketProof fee exceeds authorization')
  if (dataMode === 'REPLAY_FALLBACK') throw new Error('Live Renaiss failure entered REPLAY_FALLBACK; real payment is prohibited')

  const mode = process.env.CIRCLE_MODE || 'mock'
  const receiptPayload = {
    runId,
    offerId: offer.id,
    targetItemId: offer.targetItemId,
    targetHref: offer.targetHref,
    certNumber: offer.certNumber,
    amountUsdc,
    network: 'Arc Testnet',
    chainId: ARC_TESTNET_CHAIN_ID,
    asset: 'USDC',
    paidAt: new Date().toISOString(),
    mode,
    dataMode,
  }

  if (dataMode === 'replay') {
    return {
      ...receiptPayload,
      status: 'replay-payment-confirmed',
      confirmed: true,
      receiptId: deterministicHash('replay_pay_', receiptPayload).slice(0, 35),
      note: 'Replay fixture: not a live Circle payment receipt and no wallet was called.',
    }
  }

  if (mode !== 'mock') {
    return {
      ...receiptPayload,
      status: 'requires-live-circle-cli',
      confirmed: false,
      receiptId: deterministicHash('pending_pay_', receiptPayload).slice(0, 35),
      note: 'Live Circle CLI execution is gated; no payment is marked confirmed until a real Circle receipt is verified.',
    }
  }

  return {
    ...receiptPayload,
    status: 'mock-payment-required',
    confirmed: false,
    receiptId: null,
    note: `Mock mode only quotes Circle payment. Official CLI pattern: circle services pay <x402-service-url> --address <agent-wallet-address> --chain <chain> --max-amount ${round(amountUsdc, 6)}`,
  }
}

async function reserveEscrow({ runId, offer, proof, authorization, dataMode = 'live' }) {
  assertBaseRuntimeConfig()
  const amountUsdc = positiveNumber(offer.depositUsdc)
  const maxDepositUsdc = positiveNumber(authorization.maxDepositUsdc)
  if (!amountUsdc || !maxDepositUsdc) throw new Error('Invalid deposit authorization')
  if (!validProofHash(proof?.proofHash)) throw new Error('Valid 32-byte proofHash is required before escrow reservation')
  if (!proof?.verified && proof?.verification?.ok !== true) throw new Error('Verified MarketProof is required before escrow reservation')
  if (amountUsdc > maxDepositUsdc) throw new Error('Deposit exceeds authorization')
  if (dataMode === 'REPLAY_FALLBACK') throw new Error('Live Renaiss failure entered REPLAY_FALLBACK; escrow reservation is prohibited')

  const mode = process.env.ARC_EXECUTION_MODE || 'mock'
  const payload = {
    runId,
    offerId: offer.id,
    targetItemId: offer.targetItemId,
    targetHref: offer.targetHref,
    certNumber: offer.certNumber,
    seller: offer.sellerAddress || process.env.SELLER_WALLET_ADDRESS,
    buyer: process.env.AGENT_WALLET_ADDRESS || '0xA9E0000000000000000000000000000000000001',
    escrow: process.env.RESERVATION_ESCROW_ADDRESS || '0x0000000000000000000000000000000000000000',
    usdc: process.env.ARC_USDC_ADDRESS || ARC_TESTNET_USDC_ADDRESS,
    chainId: positiveNumber(process.env.ARC_CHAIN_ID, ARC_TESTNET_CHAIN_ID),
    amountUsdc,
    proofHash: proof.proofHash,
    reservedAt: new Date().toISOString(),
    mode,
    dataMode,
  }
  const offerHash = deterministicHash('0x', { offerId: offer.id, targetItemId: offer.targetItemId }).slice(0, 66)

  if (dataMode === 'replay') {
    return {
      ...payload,
      offerHash,
      txHash: null,
      blockNumber: null,
      arcscanUrl: null,
      status: 'replay-escrow-confirmed',
      chainConfirmed: true,
      event: 'Reserved(bytes32 offerId,address buyer,address seller,uint256 amount,bytes32 proofHash,uint64 refundAfter)',
      note: 'Replay fixture: not a live Arc Testnet transaction and no wallet was called.',
    }
  }

  if (mode !== 'mock') {
    if (!nonZeroAddress(payload.seller) || !nonZeroAddress(payload.buyer) || !nonZeroAddress(payload.escrow)) {
      throw new Error('Live escrow requires non-zero seller, buyer, and escrow EVM addresses')
    }
    return {
      ...payload,
      offerHash,
      txHash: null,
      blockNumber: null,
      arcscanUrl: null,
      status: 'requires-live-circle-wallet-execute',
      chainConfirmed: false,
      note: 'Live Agent Wallet execution must approve USDC and call reserve; no tx hash is returned until a real transaction is confirmed.',
    }
  }

  return {
    ...payload,
    offerHash,
    txHash: null,
    blockNumber: null,
    arcscanUrl: null,
    status: 'mock-reservation-required',
    chainConfirmed: false,
    note: 'Mock mode does not generate fake transaction hashes. Use Circle Agent Wallet to approve USDC and call reserve on Arc Testnet.',
  }
}

module.exports = { payForMarketProof, reserveEscrow, assertBaseRuntimeConfig }
