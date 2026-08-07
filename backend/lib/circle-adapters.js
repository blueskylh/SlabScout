const crypto = require('node:crypto')
const { stableJson, round } = require('../../packages/shared')

function deterministicHash(prefix, payload) {
  return `${prefix}${crypto.createHash('sha256').update(stableJson(payload)).digest('hex')}`
}

function positiveNumber(value, fallback = null) {
  const parsed = Number(value)
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  return fallback
}

async function payForMarketProof({ runId, offer, authorization }) {
  const amountUsdc = positiveNumber(process.env.MARKET_PROOF_PRICE_USDC, positiveNumber(authorization.intelFeeUsdc, 0.001))
  const maxIntelFeeUsdc = positiveNumber(authorization.maxIntelFeeUsdc)
  if (!amountUsdc || !maxIntelFeeUsdc) {
    throw new Error('Invalid MarketProof fee authorization')
  }
  if (amountUsdc > maxIntelFeeUsdc) {
    throw new Error('MarketProof fee exceeds authorization')
  }

  const mode = process.env.CIRCLE_MODE || 'mock'
  const receiptPayload = {
    runId,
    offerId: offer.id,
    amountUsdc,
    network: 'Arc Testnet',
    asset: 'USDC',
    paidAt: new Date().toISOString(),
    mode,
  }

  if (mode !== 'mock') {
    return {
      ...receiptPayload,
      status: 'requires-live-circle-cli',
      receiptId: deterministicHash('pay_', receiptPayload).slice(0, 28),
      note: 'Live Circle CLI execution is gated by deployment secrets; mock receipt used unless CIRCLE_MODE=live is wired on the server.',
    }
  }

  return {
    ...receiptPayload,
    status: 'paid',
    receiptId: deterministicHash('pay_', receiptPayload).slice(0, 28),
    command: `circle services pay --amount ${round(amountUsdc, 6)} --asset USDC --network arc-testnet`,
  }
}

async function reserveEscrow({ runId, offer, proof, authorization }) {
  const amountUsdc = positiveNumber(offer.depositUsdc)
  const maxDepositUsdc = positiveNumber(authorization.maxDepositUsdc)
  if (!amountUsdc || !maxDepositUsdc) {
    throw new Error('Invalid deposit authorization')
  }
  if (!proof?.proofHash || !proof.proofHash.startsWith('0x')) {
    throw new Error('Valid proof hash is required before escrow reservation')
  }
  if (amountUsdc > maxDepositUsdc) {
    throw new Error('Deposit exceeds authorization')
  }

  const mode = process.env.ARC_EXECUTION_MODE || 'mock'
  const payload = {
    runId,
    offerId: offer.id,
    seller: offer.sellerAddress || process.env.SELLER_WALLET_ADDRESS,
    buyer: process.env.AGENT_WALLET_ADDRESS || '0xA9E0000000000000000000000000000000000001',
    escrow: process.env.RESERVATION_ESCROW_ADDRESS || '0x0000000000000000000000000000000000000000',
    chainId: positiveNumber(process.env.ARC_CHAIN_ID, 50420),
    amountUsdc,
    proofHash: proof.proofHash,
    reservedAt: new Date().toISOString(),
    mode,
  }

  const txHash = deterministicHash('0x', payload)
  const offerHash = deterministicHash('0x', { offerId: offer.id }).slice(0, 66)

  if (mode !== 'mock') {
    return {
      ...payload,
      offerHash,
      txHash,
      status: 'requires-live-circle-wallet-execute',
      note: 'Live Agent Wallet execution is gated by Circle wallet envs. The deterministic mock tx is used for the Surf Studio demo unless ARC_EXECUTION_MODE=live is wired.',
    }
  }

  return {
    ...payload,
    offerHash,
    txHash,
    status: 'reserved',
    event: 'Reserved(bytes32 offerId,address buyer,address seller,uint256 amount,bytes32 proofHash,uint64 refundAfter)',
  }
}

module.exports = {
  payForMarketProof,
  reserveEscrow,
}
