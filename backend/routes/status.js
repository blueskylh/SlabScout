const routerModule = require('express').Router
const { ARC_TESTNET_CHAIN_ID, ARC_TESTNET_USDC_ADDRESS } = require('../../packages/shared')
const { missingLivePaymentEnv, missingLiveEscrowEnv } = require('../lib/circle-adapters')
const { persistenceBackend, persistentStoreConfigured, stateFile, stateFileWritable, listUnresolvedReconciliations } = require('../lib/state-store')
const circleCli = require('../lib/circle-cli')
const arcRpc = require('../lib/arc-rpc')
const { tokenFromRequest, safeEqualString } = require('../lib/operator-auth')
const { DEFAULT_SIGNING_SECRET, DEFAULT_POLICY_SIGNING_SECRET } = require('../../packages/market-proof')

const MIN_GATEWAY_BALANCE_USDC = 0.001

function commandConfigured() {
  return process.env.CIRCLE_CLI_BIN || 'circle'
}

function signingSecretConfigured() {
  return Boolean(process.env.MARKET_PROOF_SIGNING_SECRET && process.env.MARKET_PROOF_SIGNING_SECRET !== DEFAULT_SIGNING_SECRET)
}

function policySigningSecretConfigured() {
  return Boolean(process.env.POLICY_PROOF_SIGNING_SECRET && process.env.POLICY_PROOF_SIGNING_SECRET !== DEFAULT_POLICY_SIGNING_SECRET)
}

function liveConfigSummary() {
  const paymentMissing = missingLivePaymentEnv()
  const escrowMissing = missingLiveEscrowEnv()
  const required = []
  if (!process.env.SLABSCOUT_OPERATOR_TOKEN) required.push('SLABSCOUT_OPERATOR_TOKEN')
  if (!process.env.RENAISS_API_KEY) required.push('RENAISS_API_KEY')
  if (!process.env.RENAISS_API_SECRET) required.push('RENAISS_API_SECRET')
  if (!signingSecretConfigured()) required.push('MARKET_PROOF_SIGNING_SECRET(non-default)')
  if (!policySigningSecretConfigured()) required.push('POLICY_PROOF_SIGNING_SECRET(non-default)')
  if (process.env.CIRCLE_MODE !== 'live') required.push('CIRCLE_MODE=live')
  if (process.env.ARC_EXECUTION_MODE !== 'live') required.push('ARC_EXECUTION_MODE=live')
  const liveMissing = [...new Set([...paymentMissing, ...escrowMissing, ...required])]
  return { paymentMissing, escrowMissing, liveMissing, liveConfigComplete: liveMissing.length === 0 }
}

function assertReadinessOperator(req) {
  if (!process.env.SLABSCOUT_OPERATOR_TOKEN) {
    const error = new Error('SLABSCOUT_OPERATOR_TOKEN is required for live readiness')
    error.statusCode = 503
    throw error
  }
  const token = tokenFromRequest(req)
  if (!token) {
    const error = new Error('Live readiness requires an operator token')
    error.statusCode = 401
    throw error
  }
  if (!safeEqualString(token, process.env.SLABSCOUT_OPERATOR_TOKEN)) {
    const error = new Error('Invalid operator token')
    error.statusCode = 403
    throw error
  }
}

async function checkReadOnly(label, fn) {
  try {
    const value = await fn()
    if (value && typeof value === 'object' && value.ok === false) return { label, ok: false, value, error: value.error || value.reason || 'readiness check returned ok=false' }
    return { label, ok: true, value }
  } catch (error) {
    return { label, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function parseGatewayBalanceUsdc(normalized) {
  const data = normalized?.data || normalized?.envelope?.data || {}
  const total = data.total ?? data.totalUsdc ?? data.balance ?? data.amount
  const parsed = Number(total)
  return Number.isFinite(parsed) ? parsed : 0
}

function walletSessionOk(status) {
  return circleCli.circleTestnetSessionOk(status)
}

function walletControlsAddress(status, walletAddress) {
  return circleCli.circleWalletControlsAddress(status, walletAddress)
}

async function collectLiveReadiness({ circle = circleCli, arc = arcRpc, state = { listUnresolvedReconciliations } } = {}) {
  const walletAddress = process.env.CIRCLE_AGENT_WALLET_ADDRESS || process.env.AGENT_WALLET_ADDRESS || null
  const rpcUrl = process.env.ARC_RPC_URL || arc.RPC_URL
  const escrow = process.env.RESERVATION_ESCROW_ADDRESS || null
  const checks = []
  const config = liveConfigSummary()
  checks.push({ label: 'live-config', ok: config.liveConfigComplete, value: { liveMissing: config.liveMissing }, error: config.liveConfigComplete ? null : `Missing live config: ${config.liveMissing.join(', ')}` })
  checks.push({ label: 'state-file-writable', ok: Boolean(stateFile() && stateFileWritable()), value: stateFile() || null })
  checks.push({ label: 'wallet-address-configured', ok: Boolean(walletAddress), value: walletAddress })
  checks.push(await checkReadOnly('circle-cli-version', async () => {
    const version = await circle.circleCliVersion()
    return version.supported ? { ok: true, version: version.version } : { ok: false, version: version.version, error: `unsupported Circle CLI version ${version.version || 'unknown'}` }
  }))
  checks.push(await checkReadOnly('circle-cli-status', async () => {
    const status = await circle.circleWalletStatus()
    if (!walletSessionOk(status)) return { ok: false, error: 'Circle CLI testnet tokenStatus is not VALID', normalized: status.normalized || null }
    if (walletAddress && !walletControlsAddress(status, walletAddress)) return { ok: false, error: 'Circle CLI session does not control configured wallet', normalized: status.normalized || null }
    return { ok: true, session: true, testnet: status.normalized?.data?.testnet || null }
  }))
  checks.push(await checkReadOnly('circle-gateway-balance', async () => {
    if (!walletAddress) throw new Error('wallet address missing')
    const balance = await circle.circleGatewayBalance({ address: walletAddress, chain: 'ARC-TESTNET' })
    const totalUsdc = parseGatewayBalanceUsdc(balance.normalized)
    return totalUsdc >= MIN_GATEWAY_BALANCE_USDC ? { ok: true, totalUsdc } : { ok: false, totalUsdc, error: `Gateway balance below ${MIN_GATEWAY_BALANCE_USDC} USDC` }
  }))
  checks.push(await checkReadOnly('arc-chain-id', async () => arc.assertArcChain({ rpcUrl })))
  checks.push(await checkReadOnly('escrow-bytecode', async () => {
    if (!escrow) throw new Error('RESERVATION_ESCROW_ADDRESS missing')
    const code = await arc.getCode({ address: escrow, rpcUrl })
    if (!code || code === '0x') return { ok: false, error: 'escrow bytecode missing', address: escrow }
    return { ok: true, address: escrow, bytecodeBytes: Math.max(0, (code.length - 2) / 2) }
  }))
  checks.push(await checkReadOnly('unresolved-reconciliation', async () => {
    const unresolved = await state.listUnresolvedReconciliations({ owner: 'operator:live' })
    return unresolved.length === 0 ? { ok: true, count: 0 } : { ok: false, count: unresolved.length, unresolved, error: 'Unresolved reconciliation blocks live execution' }
  }))
  return { readinessLevel: 'read-only-live-check', ok: checks.every((check) => check.ok), checks, checkedAt: new Date().toISOString() }
}

function statusPayload() {
  const { liveMissing, liveConfigComplete } = liveConfigSummary()
  const statePath = stateFile()
  return {
    app: 'SlabScout',
    status: 'ok',
    mode: process.env.SLABSCOUT_DEFAULT_MODE || 'replay',
    circleMode: process.env.CIRCLE_MODE || 'mock',
    arcExecutionMode: process.env.ARC_EXECUTION_MODE || 'mock',
    chainId: Number(process.env.ARC_CHAIN_ID || ARC_TESTNET_CHAIN_ID),
    usdcAddress: process.env.ARC_USDC_ADDRESS || ARC_TESTNET_USDC_ADDRESS,
    persistence: {
      backend: persistenceBackend(),
      configured: persistentStoreConfigured(),
      stateFile: statePath || null,
      writable: statePath ? stateFileWritable() : false,
      limitation: 'single-instance-file; use a persistent volume and do not run multiple writers',
    },
    circle: {
      cliCommand: commandConfigured(),
      verifiedCliVersionRange: circleCli.CIRCLE_CLI_VERIFIED_VERSION_RANGE,
      cliSessionRequired: true,
      agentWalletConfigured: Boolean(process.env.CIRCLE_AGENT_WALLET_ADDRESS || process.env.AGENT_WALLET_ADDRESS),
      gatewayBalanceCheck: 'read-only: circle gateway balance --address <wallet> --chain ARC-TESTNET',
      serviceUrlConfigured: Boolean(process.env.MARKET_PROOF_SERVICE_URL),
      sellerAddressConfigured: Boolean(process.env.MARKET_PROOF_SELLER_ADDRESS),
      facilitatorUrl: process.env.CIRCLE_GATEWAY_FACILITATOR_URL || 'https://gateway-api-testnet.circle.com',
    },
    escrow: {
      deployed: Boolean(process.env.RESERVATION_ESCROW_ADDRESS),
      address: process.env.RESERVATION_ESCROW_ADDRESS || null,
      rpcUrl: process.env.ARC_RPC_URL || arcRpc.RPC_URL,
    },
    readinessLevel: 'config-only',
    liveConfigComplete,
    liveMissingEnv: liveMissing,
    renaissConfigured: Boolean(process.env.RENAISS_API_KEY && process.env.RENAISS_API_SECRET),
    checkedAt: new Date().toISOString(),
  }
}

function createStatusRouter({ circle = circleCli, arc = arcRpc } = {}) {
  const router = routerModule()
  router.get('/', (_req, res) => res.json(statusPayload()))
  router.get('/live-readiness', async (req, res, next) => {
    try {
      assertReadinessOperator(req)
      res.json(await collectLiveReadiness({ circle, arc }))
    } catch (error) {
      next(error)
    }
  })
  router.use((error, _req, res, _next) => {
    res.status(error.statusCode || 400).json({ error: 'Status check failed', message: error.message })
  })
  return router
}

const defaultRouter = createStatusRouter()
defaultRouter.createStatusRouter = createStatusRouter
defaultRouter._internals = { collectLiveReadiness, assertReadinessOperator, liveConfigSummary, checkReadOnly, parseGatewayBalanceUsdc, walletSessionOk, walletControlsAddress, statusPayload }

module.exports = defaultRouter
