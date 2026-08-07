const router = require('express').Router()
const { ARC_TESTNET_CHAIN_ID, ARC_TESTNET_USDC_ADDRESS } = require('../../packages/shared')
const { missingLivePaymentEnv, missingLiveEscrowEnv } = require('../lib/circle-adapters')
const { persistenceBackend, persistentStoreConfigured, stateFile, stateFileWritable } = require('../lib/state-store')
const circleCli = require('../lib/circle-cli')
const arcRpc = require('../lib/arc-rpc')
const { tokenFromRequest, safeEqualString } = require('../lib/operator-auth')

function commandConfigured() {
  return process.env.CIRCLE_CLI_BIN || 'circle'
}

function liveConfigSummary() {
  const paymentMissing = missingLivePaymentEnv()
  const escrowMissing = missingLiveEscrowEnv()
  const operatorMissing = !process.env.SLABSCOUT_OPERATOR_TOKEN ? ['SLABSCOUT_OPERATOR_TOKEN'] : []
  const liveMissing = [...new Set([...paymentMissing, ...escrowMissing, ...operatorMissing])]
  return { paymentMissing, escrowMissing, liveMissing, liveConfigComplete: liveMissing.length === 0 && process.env.CIRCLE_MODE === 'live' && process.env.ARC_EXECUTION_MODE === 'live' }
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
    return { label, ok: true, value }
  } catch (error) {
    return { label, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function collectLiveReadiness({ circle = circleCli, arc = arcRpc } = {}) {
  const walletAddress = process.env.CIRCLE_AGENT_WALLET_ADDRESS || process.env.AGENT_WALLET_ADDRESS || null
  const rpcUrl = process.env.ARC_RPC_URL || arc.RPC_URL
  const escrow = process.env.RESERVATION_ESCROW_ADDRESS || null
  const checks = []
  checks.push({ label: 'state-file-writable', ok: Boolean(stateFile() && stateFileWritable()), value: stateFile() || null })
  checks.push({ label: 'wallet-address-configured', ok: Boolean(walletAddress), value: walletAddress })
  checks.push(await checkReadOnly('circle-cli-status', async () => {
    const status = await circle.circleWalletStatus()
    return { ok: status.ok === true, cliVersion: status.normalized?.cliVersion || null }
  }))
  checks.push(await checkReadOnly('circle-gateway-balance', async () => {
    if (!walletAddress) throw new Error('wallet address missing')
    const balance = await circle.circleGatewayBalance({ address: walletAddress, chain: 'ARC-TESTNET' })
    return { ok: balance.ok === true, parsed: balance.parsed || null }
  }))
  checks.push(await checkReadOnly('arc-chain-id', async () => arc.assertArcChain({ rpcUrl })))
  checks.push(await checkReadOnly('escrow-bytecode', async () => {
    if (!escrow) throw new Error('RESERVATION_ESCROW_ADDRESS missing')
    const code = await arc.getCode({ address: escrow, rpcUrl })
    if (!code || code === '0x') throw new Error('escrow bytecode missing')
    return { address: escrow, bytecodeBytes: Math.max(0, (code.length - 2) / 2) }
  }))
  return { readinessLevel: 'read-only-live-check', ok: checks.every((check) => check.ok), checks, checkedAt: new Date().toISOString() }
}

router.get('/', (_req, res) => {
  const { liveMissing, liveConfigComplete } = liveConfigSummary()
  const statePath = stateFile()
  res.json({
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
    liveExecutionAvailable: liveConfigComplete,
    liveMissingEnv: liveMissing,
    renaissConfigured: Boolean(process.env.RENAISS_API_KEY && process.env.RENAISS_API_SECRET),
    checkedAt: new Date().toISOString(),
  })
})

router.get('/live-readiness', async (req, res, next) => {
  try {
    assertReadinessOperator(req)
    res.json(await collectLiveReadiness())
  } catch (error) {
    next(error)
  }
})

router.use((error, _req, res, _next) => {
  res.status(error.statusCode || 400).json({ error: 'Status check failed', message: error.message })
})

module.exports = router
module.exports._internals = { collectLiveReadiness, assertReadinessOperator, liveConfigSummary }
