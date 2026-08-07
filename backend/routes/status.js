const router = require('express').Router()
const { ARC_TESTNET_CHAIN_ID, ARC_TESTNET_USDC_ADDRESS } = require('../../packages/shared')
const { missingLivePaymentEnv, missingLiveEscrowEnv } = require('../lib/circle-adapters')
const { persistenceBackend, persistentStoreConfigured, stateFile, stateFileWritable } = require('../lib/state-store')

function commandConfigured() {
  return process.env.CIRCLE_CLI_BIN || 'circle'
}

router.get('/', (_req, res) => {
  const paymentMissing = missingLivePaymentEnv()
  const escrowMissing = missingLiveEscrowEnv()
  const operatorMissing = !process.env.SLABSCOUT_OPERATOR_TOKEN ? ['SLABSCOUT_OPERATOR_TOKEN'] : []
  const liveMissing = [...new Set([...paymentMissing, ...escrowMissing, ...operatorMissing])]
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
      cliSessionRequired: true,
      agentWalletConfigured: Boolean(process.env.CIRCLE_AGENT_WALLET_ADDRESS || process.env.AGENT_WALLET_ADDRESS),
      gatewayBalanceCheck: 'run circle gateway balance --address <wallet> --chain ARC-TESTNET',
      serviceUrlConfigured: Boolean(process.env.MARKET_PROOF_SERVICE_URL),
      sellerAddressConfigured: Boolean(process.env.MARKET_PROOF_SELLER_ADDRESS),
      facilitatorUrl: process.env.CIRCLE_GATEWAY_FACILITATOR_URL || 'https://gateway-api-testnet.circle.com',
    },
    escrow: {
      deployed: Boolean(process.env.RESERVATION_ESCROW_ADDRESS),
      address: process.env.RESERVATION_ESCROW_ADDRESS || null,
      rpcUrl: process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.io',
    },
    liveExecutionAvailable: liveMissing.length === 0 && process.env.CIRCLE_MODE === 'live' && process.env.ARC_EXECUTION_MODE === 'live',
    liveMissingEnv: liveMissing,
    renaissConfigured: Boolean(process.env.RENAISS_API_KEY && process.env.RENAISS_API_SECRET),
    checkedAt: new Date().toISOString(),
  })
})

module.exports = router
