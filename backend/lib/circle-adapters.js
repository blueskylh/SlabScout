const crypto = require('node:crypto')
const {
  stableJson,
  round,
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_USDC_ADDRESS,
  ARC_TESTNET_NAME,
  DEFAULT_MARKET_PROOF_PRICE_USDC,
} = require('../../packages/shared')
const { nonZeroAddress, validProofHash, validateRuntimeConfig, assertValid, pickAuthorizationFields } = require('../../packages/shared/validation')
const { verifyMarketProof, verifyPolicyProof, verifyPaymentReceipt } = require('../../packages/market-proof')
const { persistentStoreConfigured } = require('./state-store')
const { circleServicesPay, circleWalletExecute, normalizeServicesPayResult, extractTxHash, extractCircleTransactionId } = require('./circle-cli')
const defaultArcOps = require('./arc-rpc')
const { assertEscrowExecutionPreflight } = require('./live-spend-preflight')
const { RPC_URL } = defaultArcOps

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

function authorizationSnapshot(authorization) {
  return { ...pickAuthorizationFields(authorization), spentTodayUsdc: 0 }
}

function missingLivePaymentEnv() {
  const required = ['CIRCLE_AGENT_WALLET_ADDRESS', 'MARKET_PROOF_SERVICE_URL', 'MARKET_PROOF_SELLER_ADDRESS']
  if (!persistentStoreConfigured()) required.push('SLABSCOUT_STATE_FILE')
  return required.filter((key) => !process.env[key])
}

function missingLiveEscrowEnv() {
  const required = ['RESERVATION_ESCROW_ADDRESS', 'AGENT_WALLET_ADDRESS']
  if (!persistentStoreConfigured()) required.push('SLABSCOUT_STATE_FILE')
  return required.filter((key) => !process.env[key])
}

function reconciliationSubmission(source = {}) {
  if (!source || typeof source !== 'object') return null
  const txHash = source.txHash || source.submission?.txHash || source.result?.txHash || extractTxHash(source.parsed || source.result || source)
  const circleTransactionId = source.circleTransactionId || source.submission?.circleTransactionId || source.result?.circleTransactionId || extractCircleTransactionId(source.parsed || source.result || source)
  const submitted = Boolean(txHash || circleTransactionId || source.operationSubmitted === true || source.submission?.operationSubmitted === true || source.code === 'circle-cli-timeout')
  return submitted ? {
    submitted,
    txHash: txHash || null,
    circleTransactionId: circleTransactionId || null,
    operation: source.operation || source.submission?.operation || null,
    offerHash: source.offerHash || source.submission?.offerHash || null,
    externalIdempotencyKey: source.externalIdempotencyKey || source.submission?.externalIdempotencyKey || null,
  } : null
}

function isReconciliationError(error) {
  return Boolean(reconciliationSubmission(error))
}

function reconciliationPayment({ receiptPayload, reason, operation = 'services-pay', circleTransactionId = null, txHash = null }) {
  return {
    ...receiptPayload,
    status: 'reconciliation_required',
    providerStatus: 'unknown',
    confirmed: false,
    simulated: false,
    replayAccepted: false,
    receiptId: circleTransactionId || txHash || null,
    circlePaymentId: circleTransactionId,
    txHash,
    explorerUrl: null,
    operation,
    verification: { ok: false, errors: [reason] },
    note: 'Payment state is unknown. Do not retry automatically; reconcile with Circle CLI/Gateway status first.',
  }
}

function normalizeSellerPayment({ sellerResponse, receiptPayload }) {
  const source = sellerResponse?.payment || {}
  return {
    paymentKind: source.paymentKind || 'MarketProofPayment',
    runId: source.runId,
    idempotencyKey: source.idempotencyKey,
    offerId: source.offerId,
    targetItemId: source.targetItemId,
    targetHref: source.targetHref,
    payerWallet: source.payerWallet || source.payer || null,
    payeeService: source.payeeService || source.service || 'x402-marketproof',
    payeeAddress: source.payeeAddress || source.sellerAddress || process.env.MARKET_PROOF_SELLER_ADDRESS || null,
    amountUsdc: source.amountUsdc,
    network: source.network,
    providerNetwork: source.providerNetwork || source.networkId || null,
    chainId: source.chainId,
    asset: source.asset,
    usdcAddress: source.usdcAddress,
    paidAt: source.paidAt,
    mode: receiptPayload.mode,
    dataMode: receiptPayload.dataMode,
    status: source.status || 'x402-payment-confirmed',
    providerStatus: source.providerStatus || (source.verified ? 'confirmed' : null),
    confirmed: source.confirmed === true || source.verified === true,
    simulated: false,
    replayAccepted: false,
    receiptId: source.receiptId || source.settlementId || source.transaction || null,
    circlePaymentId: source.circlePaymentId || source.settlementId || null,
    txHash: source.txHash || source.transaction || null,
    explorerUrl: source.explorerUrl || null,
    proof: sellerResponse?.proof || null,
    sellerResponse: { proofHash: sellerResponse?.proof?.proofHash || null, verification: sellerResponse?.verification || null },
  }
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
    payeeService: process.env.MARKET_PROOF_SERVICE_URL || 'slabscout-market-proof-replay-service',
    payeeAddress: process.env.MARKET_PROOF_SELLER_ADDRESS || null,
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
    const verification = await verifyPaymentReceipt({ payment, runId, idempotencyKey: idempotencyKey || null, offer, authorization, expectedMode: 'replay' })
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
      note: `Mock mode only quotes Circle payment. Official CLI pattern: circle services pay <x402-service-url> --address <agent-wallet-address> --chain ARC-TESTNET --max-amount ${round(amountUsdc, 6)}`,
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
      verification: { ok: false, errors: [`Missing live Circle CLI/x402 config: ${missingEnv.join(', ')}`] },
      note: 'Live Circle/x402 payment is disabled until Circle CLI session, wallet, x402 service URL, seller address, and persistent state file are configured.',
    }
  }

  let paid
  try {
    paid = await circleServicesPay({
      url: process.env.MARKET_PROOF_SERVICE_URL,
      address: process.env.CIRCLE_AGENT_WALLET_ADDRESS,
      chain: 'ARC-TESTNET',
      maxAmountUsdc: amountUsdc,
      method: 'POST',
      data: { mode: 'live', offerId: offer.id, runId, idempotencyKey, authorization: authorizationSnapshot(authorization) },
      timeoutSeconds: Number(process.env.CIRCLE_CLI_TIMEOUT_SECONDS || 60),
    })
  } catch (error) {
    if (error.code === 'circle-cli-missing') {
      return {
        ...receiptPayload,
        status: 'live-unavailable/circle-cli-missing',
        providerStatus: 'not-submitted',
        confirmed: false,
        simulated: false,
        replayAccepted: false,
        receiptId: null,
        circlePaymentId: null,
        txHash: null,
        explorerUrl: null,
        verification: { ok: false, errors: [error.message] },
        note: 'Install and login Circle CLI testnet agent wallet before live payment.',
      }
    }
    const submitted = reconciliationSubmission(error)
    return reconciliationPayment({ receiptPayload, reason: error.message, operation: submitted?.operation || 'services-pay', circleTransactionId: submitted?.circleTransactionId || null, txHash: submitted?.txHash || null })
  }

  const servicesPay = paid.servicesPay || normalizeServicesPayResult(paid)
  if (!servicesPay.ok || !servicesPay.sellerResponse?.payment || !servicesPay.sellerResponse?.proof) return reconciliationPayment({ receiptPayload, reason: 'Circle services pay did not return parseable seller payment/proof response' })
  const payment = normalizeSellerPayment({ sellerResponse: servicesPay.sellerResponse, receiptPayload })
  const verification = await verifyPaymentReceipt({
    payment,
    runId,
    idempotencyKey: idempotencyKey || null,
    offer,
    authorization,
    expectedMode: 'live',
    expectedPayerWallet: process.env.CIRCLE_AGENT_WALLET_ADDRESS,
    expectedPayeeAddress: process.env.MARKET_PROOF_SELLER_ADDRESS,
  })
  return { ...payment, verification }
}

function amountMinorUsdc(amountUsdc) {
  return BigInt(Math.round(Number(amountUsdc) * 1_000_000))
}

function reconciliationReservation({ payload, offerHash, verification, operation, reason, txHash = null, circleTransactionId = null, externalIdempotencyKey = null }) {
  return {
    ...payload,
    offerHash,
    txHash,
    circleTransactionId,
    operation,
    externalIdempotencyKey,
    blockNumber: null,
    arcscanUrl: null,
    status: 'reconciliation_required',
    chainConfirmed: false,
    simulated: false,
    replayAccepted: false,
    event: null,
    note: `${operation} transaction state is unknown: ${reason}. Do not retry automatically; reconcile Circle and Arc state first.`,
    verification,
  }
}

async function reserveEscrow({ runId, idempotencyKey, offer, proof, authorization, dataMode = 'live', payment = null, decision = null, walletExecute = circleWalletExecute, arcOps = defaultArcOps, preflight = assertEscrowExecutionPreflight }) {
  assertBaseRuntimeConfig({ live: dataMode !== 'replay' && process.env.ARC_EXECUTION_MODE === 'live' })
  const amountUsdc = positiveNumber(offer.depositUsdc)
  const maxDepositUsdc = positiveNumber(authorization.maxDepositUsdc)
  if (!amountUsdc || !maxDepositUsdc) throw new Error('Invalid deposit authorization')
  if (!validProofHash(proof?.proofHash)) throw new Error('Valid 32-byte proofHash is required before escrow reservation')
  if (amountUsdc > maxDepositUsdc) throw new Error('Deposit exceeds authorization')
  if (dataMode === 'REPLAY_FALLBACK') throw new Error('Live Renaiss failure entered REPLAY_FALLBACK; escrow reservation is prohibited')

  const verification = authorization.requireMarketProof
    ? await verifyMarketProof({ proof, offer, authorization, payment, runId, idempotencyKey: idempotencyKey || null, expectedMode: dataMode })
    : verifyPolicyProof({ proof, offer, authorization, decision, runId, idempotencyKey: idempotencyKey || null, expectedMode: dataMode })
  if (!verification.ok) throw new Error(`${verification.proofKind} verification failed before escrow: ${verification.errors.join('; ')}`)

  const mode = process.env.ARC_EXECUTION_MODE || 'mock'
  const amountMinor = amountMinorUsdc(amountUsdc)
  const payload = {
    runId,
    idempotencyKey: idempotencyKey || null,
    offerId: offer.id,
    targetItemId: offer.targetItemId,
    targetHref: offer.targetHref,
    certNumber: offer.certNumber,
    seller: offer.sellerAddress || process.env.SELLER_WALLET_ADDRESS,
    buyer: process.env.AGENT_WALLET_ADDRESS || process.env.CIRCLE_AGENT_WALLET_ADDRESS || '0xA9E0000000000000000000000000000000000001',
    escrow: process.env.RESERVATION_ESCROW_ADDRESS || null,
    usdc: process.env.ARC_USDC_ADDRESS || ARC_TESTNET_USDC_ADDRESS,
    chainId: positiveNumber(process.env.ARC_CHAIN_ID, ARC_TESTNET_CHAIN_ID),
    amountUsdc,
    amountMinor: amountMinor.toString(),
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
  const preflightResult = await preflight({ offer, authorization, owner: 'operator:live', arc: arcOps })
  payload.preflight = { offerHash: preflightResult.offerHash, checks: preflightResult.checks }
  await arcOps.assertArcChain({ rpcUrl: process.env.ARC_RPC_URL || RPC_URL })
  const existing = await arcOps.getReservation({ escrow: payload.escrow, offerHash, rpcUrl: process.env.ARC_RPC_URL || RPC_URL })
  if (existing.status !== 0) {
    return {
      ...payload,
      offerHash,
      txHash: null,
      blockNumber: null,
      arcscanUrl: null,
      status: 'reconciliation_required',
      chainConfirmed: false,
      simulated: false,
      replayAccepted: false,
      event: null,
      note: 'Escrow reservation already exists for this offerHash; do not send another reserve transaction. Reconcile existing on-chain state.',
      verification,
    }
  }

  const allowance = await arcOps.getAllowance({ owner: payload.buyer, spender: payload.escrow, token: payload.usdc, rpcUrl: process.env.ARC_RPC_URL || RPC_URL })
  const approveIdempotencyKey = `${runId}:approve:${offerHash}`
  const reserveIdempotencyKey = `${runId}:reserve:${offerHash}`
  if (allowance < amountMinor) {
    let approval
    try {
      approval = await walletExecute({
        signature: 'approve(address,uint256)',
        params: [payload.escrow, amountMinor.toString()],
        contract: payload.usdc,
        address: payload.buyer,
        chain: 'ARC-TESTNET',
        rpcUrl: process.env.ARC_RPC_URL || RPC_URL,
        idempotencyKey: approveIdempotencyKey,
      })
      if (!approval.txHash) throw new Error('Circle CLI approve did not return a transaction hash')
      const approvalReceipt = await arcOps.waitForReceipt(approval.txHash, { rpcUrl: process.env.ARC_RPC_URL || RPC_URL })
      if (approvalReceipt.status !== '0x1') throw new Error('USDC approve transaction failed')
    } catch (error) {
      const submitted = reconciliationSubmission(approval) || reconciliationSubmission(error)
      if (submitted) {
        return reconciliationReservation({ payload, offerHash, verification, operation: 'approve', reason: error.message, txHash: submitted.txHash, circleTransactionId: submitted.circleTransactionId, externalIdempotencyKey: approveIdempotencyKey })
      }
      throw error
    }
  }

  const refundAfter = BigInt(Math.floor(Date.now() / 1000) + Number(process.env.ESCROW_REFUND_AFTER_SECONDS || 7 * 24 * 60 * 60))
  payload.refundAfter = refundAfter.toString()
  let reserve
  try {
    reserve = await walletExecute({
      signature: 'reserve(bytes32,address,uint256,bytes32,uint64)',
      params: [offerHash, payload.seller, amountMinor.toString(), proof.proofHash, refundAfter.toString()],
      contract: payload.escrow,
      address: payload.buyer,
      chain: 'ARC-TESTNET',
      rpcUrl: process.env.ARC_RPC_URL || RPC_URL,
      idempotencyKey: reserveIdempotencyKey,
    })
    if (!reserve.txHash) throw new Error('Circle CLI reserve did not return a transaction hash')
    const receipt = await arcOps.waitForReceipt(reserve.txHash, { rpcUrl: process.env.ARC_RPC_URL || RPC_URL })
    const event = arcOps.validateReservedEvent({ receipt, offerHash, buyer: payload.buyer, seller: payload.seller, amountMinor, proofHash: proof.proofHash, refundAfter })
    const blockNumber = Number(BigInt(receipt.blockNumber))
    return {
      ...payload,
      offerHash,
      txHash: reserve.txHash,
      circleTransactionId: reserve.circleTransactionId || null,
      operation: 'reserve',
      externalIdempotencyKey: reserveIdempotencyKey,
      blockNumber,
      arcscanUrl: `https://testnet.arcscan.app/tx/${reserve.txHash}`,
      status: 'chain-confirmed',
      chainConfirmed: true,
      simulated: false,
      replayAccepted: false,
      event: { name: 'Reserved', args: { offerId: offerHash, buyer: payload.buyer, seller: payload.seller, amount: amountMinor.toString(), proofHash: proof.proofHash, refundAfter: refundAfter.toString() }, logIndex: event.logIndex },
      note: 'Arc Testnet escrow reserve confirmed and Reserved event matched.',
      verification,
    }
  } catch (error) {
    const submitted = reconciliationSubmission(reserve) || reconciliationSubmission(error)
    if (submitted) {
      return reconciliationReservation({ payload, offerHash, verification, operation: 'reserve', reason: error.message, txHash: submitted.txHash, circleTransactionId: submitted.circleTransactionId, externalIdempotencyKey: reserveIdempotencyKey })
    }
    throw error
  }
}

module.exports = {
  payForMarketProof,
  reserveEscrow,
  verifyPaymentReceipt,
  assertBaseRuntimeConfig,
  missingLivePaymentEnv,
  missingLiveEscrowEnv,
  reconciliationSubmission,
  isReconciliationError,
}
