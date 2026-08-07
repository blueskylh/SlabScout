const router = require('express').Router()
const { ARC_TESTNET_CHAIN_ID, ARC_TESTNET_USDC_ADDRESS } = require('../../packages/shared')
const { missingLivePaymentEnv, missingLiveEscrowEnv } = require('../lib/circle-adapters')
const { persistentStoreConfigured } = require('../lib/state-store')

router.get('/', (_req, res) => {
  const liveMissing = [...new Set([...missingLivePaymentEnv(), ...missingLiveEscrowEnv(), ...(!process.env.SLABSCOUT_OPERATOR_TOKEN ? ['SLABSCOUT_OPERATOR_TOKEN'] : [])])]
  res.json({
    app: 'SlabScout',
    status: 'ok',
    mode: process.env.SLABSCOUT_DEFAULT_MODE || 'replay',
    circleMode: process.env.CIRCLE_MODE || 'mock',
    arcExecutionMode: process.env.ARC_EXECUTION_MODE || 'mock',
    chainId: Number(process.env.ARC_CHAIN_ID || ARC_TESTNET_CHAIN_ID),
    usdcAddress: process.env.ARC_USDC_ADDRESS || ARC_TESTNET_USDC_ADDRESS,
    persistentStateConfigured: persistentStoreConfigured(),
    liveExecutionAvailable: liveMissing.length === 0 && process.env.CIRCLE_MODE === 'live' && process.env.ARC_EXECUTION_MODE === 'live',
    liveMissingEnv: liveMissing,
    renaissConfigured: Boolean(process.env.RENAISS_API_KEY && process.env.RENAISS_API_SECRET),
    checkedAt: new Date().toISOString(),
  })
})

module.exports = router
