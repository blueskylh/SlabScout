const { ARC_TESTNET_USDC_ADDRESS } = require('../../packages/shared')
const { nonZeroAddress } = require('../../packages/shared/validation')
const arcRpc = require('./arc-rpc')
const circleCli = require('./circle-cli')
const stateStore = require('./state-store')

function sameAddress(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase()
}

function latestStage(run) {
  return (run?.stages || []).slice().reverse().find((stage) => stage.txHash || stage.circleTransactionId || stage.offerHash || stage.operation) || null
}

function submissionFromContext(context) {
  const stage = latestStage(context.run) || {}
  const payment = context.paymentIntent?.payment || {}
  const reservation = context.reservation || {}
  return {
    operation: reservation.operation || payment.operation || stage.operation || null,
    offerHash: reservation.offerHash || payment.offerHash || stage.offerHash || null,
    txHash: reservation.txHash || payment.txHash || stage.txHash || null,
    circleTransactionId: reservation.circleTransactionId || payment.circleTransactionId || payment.circlePaymentId || stage.circleTransactionId || null,
    externalIdempotencyKey: reservation.externalIdempotencyKey || stage.externalIdempotencyKey || null,
    escrow: reservation.escrow || process.env.RESERVATION_ESCROW_ADDRESS || null,
    usdc: reservation.usdc || process.env.ARC_USDC_ADDRESS || ARC_TESTNET_USDC_ADDRESS,
    buyer: reservation.buyer || process.env.AGENT_WALLET_ADDRESS || process.env.CIRCLE_AGENT_WALLET_ADDRESS || null,
    seller: reservation.seller || null,
    amountMinor: reservation.amountMinor || null,
    proofHash: reservation.proofHash || null,
  }
}

function serializable(details = {}) {
  return JSON.parse(JSON.stringify(details, (_key, value) => typeof value === 'bigint' ? value.toString() : value))
}

function classifyCircleStatus(status) {
  const normalized = status?.normalized || circleCli.normalizeCircleEnvelope(status?.parsed || status)
  const data = normalized?.data || {}
  const raw = String(data.status || data.state || data.transactionStatus || data.result || '').toUpperCase()
  if (['CONFIRMED', 'COMPLETE', 'COMPLETED', 'SUCCESS', 'SUCCEEDED', 'SETTLED'].includes(raw)) return { outcome: 'confirmed', raw }
  if (['FAILED', 'REVERTED', 'CANCELLED', 'CANCELED', 'EXPIRED'].includes(raw)) return { outcome: 'reverted', raw }
  if (['NOT_SUBMITTED', 'NOT_SUBMITTED_TO_CHAIN', 'NOT_FOUND', 'UNKNOWN_ID'].includes(raw)) return { outcome: 'not-submitted', raw }
  return { outcome: 'ambiguous', raw: raw || null }
}

function assertArcToken(usdc) {
  if (!sameAddress(usdc, ARC_TESTNET_USDC_ADDRESS)) {
    const error = new Error(`Reconciliation token mismatch: expected ${ARC_TESTNET_USDC_ADDRESS}`)
    error.statusCode = 409
    error.code = 'reconciliation-wrong-token'
    throw error
  }
}

function onchainReservationMatchesExpected(onchain, submission) {
  if (!onchain || Number(onchain.status) === 0) return false
  if (submission.buyer && !sameAddress(onchain.buyer, submission.buyer)) return false
  if (submission.seller && !sameAddress(onchain.seller, submission.seller)) return false
  if (submission.amountMinor && BigInt(onchain.amount) !== BigInt(submission.amountMinor)) return false
  if (submission.proofHash && String(onchain.proofHash).toLowerCase() !== String(submission.proofHash).toLowerCase()) return false
  return true
}

async function resolveReconciliation({ runId, arc = arcRpc, circle = circleCli, state = stateStore } = {}) {
  if (!runId || typeof runId !== 'string') {
    const error = new Error('runId is required')
    error.statusCode = 400
    throw error
  }
  const context = await state.getReconciliationContext(runId)
  if (!context.run) {
    const error = new Error('run not found')
    error.statusCode = 404
    throw error
  }
  if (!context.unresolved) return { runId, status: 'already_resolved', unresolved: false, outcome: context.run.status }

  const submission = submissionFromContext(context)
  assertArcToken(submission.usdc)
  const rpcUrl = process.env.ARC_RPC_URL || arc.RPC_URL

  if (submission.escrow && submission.offerHash && nonZeroAddress(submission.escrow)) {
    await arc.assertArcChain({ rpcUrl })
    if (arc.getEscrowUsdc) assertArcToken(await arc.getEscrowUsdc({ escrow: submission.escrow, rpcUrl }))
    const onchain = await arc.getReservation({ escrow: submission.escrow, offerHash: submission.offerHash, rpcUrl })
    if (onchainReservationMatchesExpected(onchain, submission)) {
      return state.resolveReconciliationState({ runId, outcome: 'confirmed', details: serializable({ source: 'arc-reservations', submission, onchain }) })
    }
  }

  if (submission.txHash && arc.getTransactionReceipt) {
    try {
      const receipt = await arc.getTransactionReceipt(submission.txHash, { rpcUrl })
      if (receipt?.status === '0x0') return state.resolveReconciliationState({ runId, outcome: 'reverted', details: serializable({ source: 'arc-receipt', submission, receipt }) })
      if (receipt?.status === '0x1') return state.resolveReconciliationState({ runId, outcome: 'ambiguous', details: serializable({ source: 'arc-receipt-no-matching-reservation', submission, receipt }) })
    } catch (error) {
      return state.resolveReconciliationState({ runId, outcome: 'ambiguous', details: serializable({ source: 'arc-receipt-error', submission, error: error.message }) })
    }
  }

  if (submission.circleTransactionId && circle.circleTransactionStatus) {
    const circleStatus = await circle.circleTransactionStatus({ transactionId: submission.circleTransactionId })
    const classified = classifyCircleStatus(circleStatus)
    return state.resolveReconciliationState({ runId, outcome: classified.outcome, details: serializable({ source: 'circle-transaction-status', submission, circleStatus: classified }) })
  }

  return state.resolveReconciliationState({ runId, outcome: 'ambiguous', details: serializable({ source: 'insufficient-authoritative-evidence', submission }) })
}

module.exports = {
  resolveReconciliation,
  classifyCircleStatus,
  submissionFromContext,
  onchainReservationMatchesExpected,
}
