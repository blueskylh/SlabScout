const crypto = require('node:crypto')
const { stableJson, ARC_TESTNET_USDC_ADDRESS, DEFAULT_MARKET_PROOF_PRICE_USDC } = require('../packages/shared')
const { nonZeroAddress } = require('../packages/shared/validation')
const circleCli = require('./circle-cli')
const arcRpc = require('./arc-rpc')
const stateStore = require('./state-store')

function deterministicOfferHash(offer) {
  return `0x${crypto.createHash('sha256').update(stableJson({ offerId: offer.id, targetItemId: offer.targetItemId })).digest('hex')}`
}

function amountMinorUsdc(amountUsdc) {
  return BigInt(Math.round(Number(amountUsdc) * 1_000_000))
}

function preflightError(label, message, extra = {}) {
  const error = new Error(message)
  error.statusCode = extra.statusCode || 409
  error.code = 'live-spend-preflight-failed'
  error.check = label
  Object.assign(error, extra)
  return error
}

function assertCheck(checks, label, ok, value, message, extra = {}) {
  const check = { label, ok: Boolean(ok), value: value ?? null, error: ok ? null : message }
  checks.push(check)
  if (!ok) throw preflightError(label, message, { ...extra, checks })
  return check
}

function normalizeAddress(value) {
  return String(value || '').toLowerCase()
}

function sameAddress(a, b) {
  return normalizeAddress(a) === normalizeAddress(b)
}

function bigintValue(value) {
  return typeof value === 'bigint' ? value : BigInt(value || 0)
}

function paymentAmountUsdc(authorization) {
  const configured = Number(process.env.MARKET_PROOF_PRICE_USDC || DEFAULT_MARKET_PROOF_PRICE_USDC)
  if (!Number.isFinite(configured) || configured <= 0) throw preflightError('payment-amount', 'MARKET_PROOF_PRICE_USDC must be positive', { statusCode: 400 })
  if (configured > Number(authorization.maxIntelFeeUsdc)) throw preflightError('payment-amount', 'MARKET_PROOF_PRICE_USDC exceeds authorization.maxIntelFeeUsdc', { statusCode: 400 })
  return configured
}

async function assertCircleSessionAndWallet({ checks, circle, wallet }) {
  const status = await circle.circleWalletStatus()
  assertCheck(checks, 'circle-testnet-session', circleCli.circleTestnetSessionOk(status), status.normalized?.data?.testnet?.tokenStatus || null, 'Circle CLI testnet tokenStatus must be VALID', { statusCode: 503 })
  const walletList = await circle.circleWalletList({ chain: 'ARC-TESTNET', type: 'agent' })
  assertCheck(checks, 'circle-wallet-list-ownership', circleCli.circleWalletListHasAddress(walletList, wallet), wallet, 'circle wallet list does not contain the configured CIRCLE_AGENT_WALLET_ADDRESS', { statusCode: 503 })
  return { status, walletList }
}

async function assertCircleEstimate({ checks, estimate, operation }) {
  const ok = estimate?.normalized?.ok === true && estimate.normalized.estimated === true
  assertCheck(checks, `wallet-execute-estimate-${operation}`, ok, estimate?.normalized?.data || null, `Circle wallet execute --estimate did not return a valid 0.0.6 fee estimate for ${operation}`, { statusCode: 503 })
  return { ok: true, source: 'circle-wallet-execute-estimate', operation }
}

async function assertPaymentPreflight({ authorization, owner = 'operator:live', circle = circleCli, state = stateStore } = {}) {
  const checks = []
  assertCheck(checks, 'circle-mode-live', process.env.CIRCLE_MODE === 'live', process.env.CIRCLE_MODE || 'mock', 'CIRCLE_MODE=live is required before live x402 payment', { statusCode: 503 })
  const wallet = process.env.CIRCLE_AGENT_WALLET_ADDRESS || null
  assertCheck(checks, 'circle-wallet-configured', nonZeroAddress(wallet), wallet, 'CIRCLE_AGENT_WALLET_ADDRESS must be a non-zero EVM address', { statusCode: 503 })
  const amountUsdc = paymentAmountUsdc(authorization)
  assertCheck(checks, 'payment-amount-cap', amountUsdc <= Number(authorization.maxIntelFeeUsdc), amountUsdc, 'MarketProof fee exceeds authorization.maxIntelFeeUsdc', { statusCode: 400 })
  const unresolved = await state.listUnresolvedReconciliations({ owner, operations: ['services-pay'] })
  assertCheck(checks, 'unresolved-payment-reconciliation', unresolved.length === 0, unresolved.length, 'Unresolved services-pay reconciliation exists; resolve it before another x402 payment', { unresolved })
  await assertCircleSessionAndWallet({ checks, circle, wallet })
  return { ok: true, amountUsdc, wallet, checks }
}

async function assertEscrowExecutionPreflight({ offer, proofHash, refundAfter, owner = 'operator:live', circle = circleCli, arc = arcRpc, state = stateStore } = {}) {
  const checks = []
  assertCheck(checks, 'arc-execution-mode-live', process.env.ARC_EXECUTION_MODE === 'live', process.env.ARC_EXECUTION_MODE || 'mock', 'ARC_EXECUTION_MODE=live is required before live escrow execution', { statusCode: 503 })
  const wallet = process.env.AGENT_WALLET_ADDRESS || process.env.CIRCLE_AGENT_WALLET_ADDRESS || null
  const circleWallet = process.env.CIRCLE_AGENT_WALLET_ADDRESS || null
  const escrow = process.env.RESERVATION_ESCROW_ADDRESS || null
  const usdc = process.env.ARC_USDC_ADDRESS || ARC_TESTNET_USDC_ADDRESS
  const amountMinor = amountMinorUsdc(offer.depositUsdc)
  const offerHash = deterministicOfferHash(offer)

  assertCheck(checks, 'agent-wallet-configured', nonZeroAddress(wallet), wallet, 'AGENT_WALLET_ADDRESS/CIRCLE_AGENT_WALLET_ADDRESS must be a non-zero EVM address', { statusCode: 503 })
  assertCheck(checks, 'circle-wallet-configured', nonZeroAddress(circleWallet), circleWallet, 'CIRCLE_AGENT_WALLET_ADDRESS must be a non-zero EVM address', { statusCode: 503 })
  assertCheck(checks, 'escrow-configured', nonZeroAddress(escrow), escrow, 'RESERVATION_ESCROW_ADDRESS must be a non-zero EVM address', { statusCode: 503 })
  assertCheck(checks, 'usdc-configured', sameAddress(usdc, ARC_TESTNET_USDC_ADDRESS), usdc, `ARC_USDC_ADDRESS must be ${ARC_TESTNET_USDC_ADDRESS}`, { statusCode: 503 })
  assertCheck(checks, 'proof-hash', /^0x[a-fA-F0-9]{64}$/.test(String(proofHash || '')), proofHash || null, 'A valid proofHash is required before estimating reserve', { statusCode: 400 })
  assertCheck(checks, 'refund-after', /^\d+$/.test(String(refundAfter || '')) && BigInt(refundAfter) > BigInt(Math.floor(Date.now() / 1000)), refundAfter || null, 'refundAfter must be a future uint64 timestamp before estimating reserve', { statusCode: 400 })

  const unresolved = await state.listUnresolvedReconciliations({ owner, operations: ['approve', 'reserve'] })
  assertCheck(checks, 'unresolved-escrow-reconciliation', unresolved.length === 0, unresolved.length, 'Unresolved approve/reserve reconciliation exists; resolve it before live escrow execution', { unresolved })
  await assertCircleSessionAndWallet({ checks, circle, wallet })

  const rpcUrl = process.env.ARC_RPC_URL || arc.RPC_URL
  const chainId = await arc.assertArcChain({ rpcUrl })
  assertCheck(checks, 'arc-chain-id', true, chainId, null)
  const code = await arc.getCode({ address: escrow, rpcUrl })
  assertCheck(checks, 'escrow-bytecode', Boolean(code && code !== '0x'), escrow, 'ReservationEscrow bytecode missing on Arc Testnet')
  const escrowUsdc = await arc.getEscrowUsdc({ escrow, rpcUrl })
  assertCheck(checks, 'escrow-usdc', sameAddress(escrowUsdc, ARC_TESTNET_USDC_ADDRESS), escrowUsdc, `ReservationEscrow usdc() must equal ${ARC_TESTNET_USDC_ADDRESS}`)
  const maxReservationAmount = bigintValue(await arc.getEscrowMaxReservationAmount({ escrow, rpcUrl }))
  assertCheck(checks, 'escrow-max-reservation-amount', maxReservationAmount >= amountMinor, maxReservationAmount.toString(), 'ReservationEscrow maxReservationAmount is below this deposit')
  const existing = await arc.getReservation({ escrow, offerHash, rpcUrl })
  assertCheck(checks, 'escrow-existing-reservation', Number(existing.status) === 0, existing.status, 'Reservation already exists for this offerHash; reconcile before spending')
  const tokenBalance = bigintValue(await arc.getTokenBalance({ owner: wallet, token: ARC_TESTNET_USDC_ADDRESS, rpcUrl }))
  assertCheck(checks, 'agent-wallet-usdc-balance', tokenBalance >= amountMinor, tokenBalance.toString(), 'Agent wallet Arc Testnet USDC balance is below this deposit')
  const allowance = bigintValue(await arc.getAllowance({ owner: wallet, spender: escrow, token: ARC_TESTNET_USDC_ADDRESS, rpcUrl }))
  assertCheck(checks, 'agent-wallet-usdc-allowance-read', true, allowance.toString(), null)

  const estimateCalls = []
  if (allowance < amountMinor) {
    const approveEstimate = await circle.circleWalletExecuteEstimate({ signature: 'approve(address,uint256)', params: [escrow, amountMinor.toString()], contract: ARC_TESTNET_USDC_ADDRESS, address: wallet, chain: 'ARC-TESTNET', rpcUrl })
    estimateCalls.push('approve')
    await assertCircleEstimate({ checks, estimate: approveEstimate, operation: 'approve' })
  }
  const reserveEstimate = await circle.circleWalletExecuteEstimate({ signature: 'reserve(bytes32,address,uint256,bytes32,uint64)', params: [offerHash, offer.sellerAddress, amountMinor.toString(), proofHash, String(refundAfter)], contract: escrow, address: wallet, chain: 'ARC-TESTNET', rpcUrl })
  estimateCalls.push('reserve')
  await assertCircleEstimate({ checks, estimate: reserveEstimate, operation: 'reserve' })

  return { ok: true, offerHash, amountMinor: amountMinor.toString(), wallet, escrow, allowance: allowance.toString(), estimateCalls, checks }
}

async function assertLiveSpendPreflight(args = {}) {
  return assertEscrowExecutionPreflight(args)
}

module.exports = {
  assertPaymentPreflight,
  assertEscrowExecutionPreflight,
  assertLiveSpendPreflight,
  deterministicOfferHash,
  amountMinorUsdc,
}
