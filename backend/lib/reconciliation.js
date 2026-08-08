const { ARC_TESTNET_USDC_ADDRESS } = require('../packages/shared')
const { nonZeroAddress } = require('../packages/shared/validation')
const arcRpc = require('./arc-rpc')
const circleCli = require('./circle-cli')
const stateStore = require('./state-store')

function sameAddress(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase()
}

function latestStage(run) {
  return (run?.stages || []).slice().reverse().find((stage) => stage.txHash || stage.circleTransactionId || stage.offerHash || stage.operation) || null
}

function inferOperation(context, requestedOperation = null) {
  if (requestedOperation) return requestedOperation
  const stage = latestStage(context.run) || {}
  if (stage.operation) return stage.operation
  if (context.reservation?.operation) return context.reservation.operation
  if (context.paymentIntent?.payment?.operation) return context.paymentIntent.payment.operation
  if (context.paymentIntent?.status === 'reconciliation_required') return 'services-pay'
  return 'reserve'
}

function submissionFromContext(context, requestedOperation = null) {
  const operation = inferOperation(context, requestedOperation)
  const stage = latestStage(context.run) || {}
  const payment = context.paymentIntent?.payment || {}
  const reservation = context.reservation || {}
  const source = operation === 'services-pay' ? payment : reservation
  return {
    operation,
    offerHash: source.offerHash || stage.offerHash || null,
    txHash: source.txHash || stage.txHash || null,
    circleTransactionId: operation === 'services-pay' ? null : (source.circleTransactionId || stage.circleTransactionId || null),
    servicesPaymentId: operation === 'services-pay' ? (payment.circlePaymentId || payment.receiptId || null) : null,
    externalIdempotencyKey: source.externalIdempotencyKey || stage.externalIdempotencyKey || null,
    escrow: source.escrow || process.env.RESERVATION_ESCROW_ADDRESS || null,
    usdc: source.usdc || process.env.ARC_USDC_ADDRESS || ARC_TESTNET_USDC_ADDRESS,
    buyer: source.buyer || process.env.AGENT_WALLET_ADDRESS || process.env.CIRCLE_AGENT_WALLET_ADDRESS || null,
    seller: source.seller || null,
    amountMinor: source.amountMinor || null,
    proofHash: source.proofHash || null,
    refundAfter: source.refundAfter || null,
    payment,
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

function classifyServicesPayment(payment = {}) {
  const provider = String(payment.providerStatus || payment.status || '').toLowerCase()
  if (payment.confirmed === true && ['confirmed', 'settled', 'success', 'succeeded'].includes(provider)) return { outcome: 'confirmed', provider }
  if (['not-submitted', 'live-unavailable/config-missing', 'live-unavailable/circle-cli-missing', 'failed'].includes(provider)) return { outcome: 'not-submitted', provider }
  return { outcome: 'ambiguous', provider }
}

function assertArcToken(usdc) {
  if (!sameAddress(usdc, ARC_TESTNET_USDC_ADDRESS)) {
    const error = new Error(`Reconciliation token mismatch: expected ${ARC_TESTNET_USDC_ADDRESS}`)
    error.statusCode = 409
    error.code = 'reconciliation-wrong-token'
    throw error
  }
}

function reservationReleasedState(onchain) {
  if (Number(onchain?.status) === 2) return 'released'
  if (Number(onchain?.status) === 3) return 'refunded'
  return null
}

function onchainReservationMatchesExpected(onchain, submission) {
  if (!onchain || Number(onchain.status) !== 1) return false
  if (submission.buyer && !sameAddress(onchain.buyer, submission.buyer)) return false
  if (submission.seller && !sameAddress(onchain.seller, submission.seller)) return false
  if (submission.amountMinor && BigInt(onchain.amount) !== BigInt(submission.amountMinor)) return false
  if (submission.proofHash && String(onchain.proofHash).toLowerCase() !== String(submission.proofHash).toLowerCase()) return false
  if (submission.refundAfter && BigInt(onchain.refundAfter) !== BigInt(submission.refundAfter)) return false
  return true
}

async function resolveServicesPay({ runId, submission, circle, state }) {
  if (circle.circleServicesPaymentStatus && submission.servicesPaymentId) {
    const status = await circle.circleServicesPaymentStatus({ paymentId: submission.servicesPaymentId })
    const classified = classifyCircleStatus(status)
    return state.resolveOperationReconciliationState({ runId, operation: 'services-pay', outcome: classified.outcome, details: serializable({ operation: 'services-pay', source: 'circle-services-payment-status', submission, status: classified }) })
  }
  const classified = classifyServicesPayment(submission.payment)
  return state.resolveOperationReconciliationState({ runId, operation: 'services-pay', outcome: classified.outcome, details: serializable({ operation: 'services-pay', source: 'stored-services-payment-receipt', submission, status: classified }) })
}

async function resolveExecuteTransaction({ submission, circle }) {
  if (submission.txHash) return { txHash: submission.txHash, found: true, source: 'stored-tx-hash' }
  if (!submission.circleTransactionId) return { txHash: null, found: false, source: 'missing-circle-transaction-id' }
  const found = await circle.findCircleExecuteTransaction({ address: submission.buyer, transactionId: submission.circleTransactionId, chain: 'ARC-TESTNET', limit: 50 })
  return { txHash: found.txHash, found: found.found, source: 'circle-transaction-list', pages: found.pages, transaction: found.transaction }
}

async function resolveApprove({ runId, submission, arc, circle, state, rpcUrl }) {
  const tx = await resolveExecuteTransaction({ submission, circle })
  if (!tx.found) return state.resolveOperationReconciliationState({ runId, operation: 'approve', outcome: 'not-submitted', details: serializable({ operation: 'approve', source: tx.source, submission, tx }) })
  if (!tx.txHash) return state.resolveOperationReconciliationState({ runId, operation: 'approve', outcome: 'ambiguous', details: serializable({ operation: 'approve', source: tx.source, submission, tx }) })
  const receipt = arc.getTransactionReceipt ? await arc.getTransactionReceipt(tx.txHash, { rpcUrl }) : null
  if (!receipt) return state.resolveOperationReconciliationState({ runId, operation: 'approve', outcome: 'ambiguous', details: serializable({ operation: 'approve', source: 'arc-receipt-missing', submission, tx }) })
  if (receipt.status === '0x0') return state.resolveOperationReconciliationState({ runId, operation: 'approve', outcome: 'reverted', details: serializable({ operation: 'approve', source: 'arc-receipt', submission, tx, receipt }) })
  if (receipt.status === '0x1') return state.resolveOperationReconciliationState({ runId, operation: 'approve', outcome: 'confirmed', details: serializable({ operation: 'approve', source: 'arc-receipt', submission, tx, receipt }) })
  return state.resolveOperationReconciliationState({ runId, operation: 'approve', outcome: 'ambiguous', details: serializable({ operation: 'approve', source: 'arc-receipt-status-unknown', submission, tx, receipt }) })
}

async function resolveReserve({ runId, submission, arc, circle, state, rpcUrl }) {
  if (!submission.escrow || !submission.offerHash || !nonZeroAddress(submission.escrow)) return state.resolveOperationReconciliationState({ runId, operation: 'reserve', outcome: 'ambiguous', details: serializable({ operation: 'reserve', source: 'missing-escrow-or-offerHash', submission }) })
  await arc.assertArcChain({ rpcUrl })
  if (arc.getEscrowUsdc) assertArcToken(await arc.getEscrowUsdc({ escrow: submission.escrow, rpcUrl }))
  const tx = await resolveExecuteTransaction({ submission, circle })
  if (!tx.found) return state.resolveOperationReconciliationState({ runId, operation: 'reserve', outcome: 'not-submitted', details: serializable({ operation: 'reserve', source: tx.source, submission, tx }) })
  if (!tx.txHash) return state.resolveOperationReconciliationState({ runId, operation: 'reserve', outcome: 'ambiguous', details: serializable({ operation: 'reserve', source: tx.source, submission, tx }) })
  const receipt = arc.getTransactionReceipt ? await arc.getTransactionReceipt(tx.txHash, { rpcUrl }) : null
  if (!receipt) return state.resolveOperationReconciliationState({ runId, operation: 'reserve', outcome: 'ambiguous', details: serializable({ operation: 'reserve', source: 'arc-receipt-missing', submission, tx }) })
  if (receipt.transactionHash && String(receipt.transactionHash).toLowerCase() !== String(tx.txHash).toLowerCase()) return state.resolveOperationReconciliationState({ runId, operation: 'reserve', outcome: 'ambiguous', details: serializable({ operation: 'reserve', source: 'arc-receipt-txhash-mismatch', submission, tx, receipt }) })
  if (receipt.status === '0x0') return state.resolveOperationReconciliationState({ runId, operation: 'reserve', outcome: 'reverted', details: serializable({ operation: 'reserve', source: 'arc-receipt', submission, tx, receipt }) })
  if (receipt.status !== '0x1') return state.resolveOperationReconciliationState({ runId, operation: 'reserve', outcome: 'ambiguous', details: serializable({ operation: 'reserve', source: 'arc-receipt-status-unknown', submission, tx, receipt }) })
  try {
    arc.validateReservedEvent({ receipt, offerHash: submission.offerHash, buyer: submission.buyer, seller: submission.seller, amountMinor: BigInt(submission.amountMinor), proofHash: submission.proofHash, refundAfter: BigInt(submission.refundAfter) })
  } catch (error) {
    return state.resolveOperationReconciliationState({ runId, operation: 'reserve', outcome: 'ambiguous', details: serializable({ operation: 'reserve', source: 'reserved-event-mismatch', submission, tx, receipt, error: error.message }) })
  }
  const onchain = await arc.getReservation({ escrow: submission.escrow, offerHash: submission.offerHash, rpcUrl })
  const released = reservationReleasedState(onchain)
  if (released) return state.resolveOperationReconciliationState({ runId, operation: 'reserve', outcome: released, details: serializable({ operation: 'reserve', source: 'arc-reservations', submission, tx, onchain }) })
  if (!onchainReservationMatchesExpected(onchain, submission)) return state.resolveOperationReconciliationState({ runId, operation: 'reserve', outcome: 'ambiguous', details: serializable({ operation: 'reserve', source: 'onchain-reservation-mismatch', submission, tx, onchain }) })
  return state.resolveOperationReconciliationState({ runId, operation: 'reserve', outcome: 'confirmed', details: serializable({ operation: 'reserve', source: 'arc-receipt-event-and-reservations', submission, tx, onchain }) })
}

async function resolveReconciliation({ runId, operation = null, arc = arcRpc, circle = circleCli, state = stateStore } = {}) {
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

  const submission = submissionFromContext(context, operation)
  if (!['services-pay', 'approve', 'reserve'].includes(submission.operation)) {
    const error = new Error(`unsupported reconciliation operation: ${submission.operation}`)
    error.statusCode = 400
    throw error
  }
  assertArcToken(submission.usdc)
  const rpcUrl = process.env.ARC_RPC_URL || arc.RPC_URL

  if (submission.operation === 'services-pay') return resolveServicesPay({ runId, submission, circle, state })
  if (submission.operation === 'approve') return resolveApprove({ runId, submission, arc, circle, state, rpcUrl })
  return resolveReserve({ runId, submission, arc, circle, state, rpcUrl })
}

module.exports = {
  resolveReconciliation,
  classifyCircleStatus,
  classifyServicesPayment,
  submissionFromContext,
  onchainReservationMatchesExpected,
}
