const crypto = require('node:crypto')
const { stableJson, ARC_TESTNET_USDC_ADDRESS } = require('../../packages/shared')
const { nonZeroAddress } = require('../../packages/shared/validation')
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

function circlePaymasterAvailable(walletStatus) {
  const normalized = walletStatus?.normalized || circleCli.normalizeWalletStatus(walletStatus?.parsed || walletStatus)
  const testnet = normalized?.data?.testnet || {}
  return testnet.paymasterStatus === 'AVAILABLE' || testnet.paymasterAvailable === true || testnet.gasSponsorStatus === 'AVAILABLE'
}

function bigintValue(value) {
  return typeof value === 'bigint' ? value : BigInt(value || 0)
}

async function assertLiveSpendPreflight({ offer, authorization, owner = 'operator:live', circle = circleCli, arc = arcRpc, state = stateStore } = {}) {
  const checks = []
  assertCheck(checks, 'circle-mode-live', process.env.CIRCLE_MODE === 'live', process.env.CIRCLE_MODE || 'mock', 'CIRCLE_MODE=live is required before live x402 payment', { statusCode: 503 })
  assertCheck(checks, 'arc-execution-mode-live', process.env.ARC_EXECUTION_MODE === 'live', process.env.ARC_EXECUTION_MODE || 'mock', 'ARC_EXECUTION_MODE=live is required before live x402 payment', { statusCode: 503 })
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

  const unresolved = await state.listUnresolvedReconciliations({ owner })
  assertCheck(checks, 'unresolved-reconciliation', unresolved.length === 0, unresolved.length, 'Unresolved live reconciliation exists; reconcile Circle/Arc state before starting another live spend', { unresolved })

  const walletStatus = await circle.circleWalletStatus()
  assertCheck(checks, 'circle-testnet-session', circleCli.circleTestnetSessionOk(walletStatus), walletStatus.normalized?.data?.testnet?.tokenStatus || null, 'Circle CLI testnet tokenStatus must be VALID before live x402 payment', { statusCode: 503 })
  assertCheck(checks, 'circle-wallet-controls-address', circleCli.circleWalletControlsAddress(walletStatus, wallet), wallet, 'Circle CLI session does not control the configured Agent Wallet used for Arc execution', { statusCode: 503 })

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
  const nativeBalance = arc.getNativeBalance ? bigintValue(await arc.getNativeBalance({ address: wallet, rpcUrl })) : 0n
  const nativeGasRequired = process.env.ARC_NATIVE_GAS_REQUIRED === 'true'
  const paymasterOk = circlePaymasterAvailable(walletStatus)
  const gasOk = nativeGasRequired ? nativeBalance > 0n : (nativeBalance > 0n || paymasterOk)
  assertCheck(checks, 'gas-or-paymaster', gasOk, { nativeBalanceWei: nativeBalance.toString(), paymasterOk }, 'No native gas balance or Circle paymaster signal is available for Arc wallet execution', { statusCode: 503 })

  return { ok: true, offerHash, amountMinor: amountMinor.toString(), checks }
}

module.exports = {
  assertLiveSpendPreflight,
  deterministicOfferHash,
  amountMinorUsdc,
  circlePaymasterAvailable,
}
