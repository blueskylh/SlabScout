const router = require('express').Router()
const { ARC_TESTNET_CHAIN_ID, ARC_TESTNET_USDC_ADDRESS } = require('../../packages/shared')

router.get('/', (_req, res) => {
  res.json({
    app: 'SlabScout',
    status: 'ok',
    mode: process.env.SLABSCOUT_DEFAULT_MODE || 'replay',
    circleMode: process.env.CIRCLE_MODE || 'mock',
    arcExecutionMode: process.env.ARC_EXECUTION_MODE || 'mock',
    chainId: Number(process.env.ARC_CHAIN_ID || ARC_TESTNET_CHAIN_ID),
    usdcAddress: process.env.ARC_USDC_ADDRESS || ARC_TESTNET_USDC_ADDRESS,
    renaissConfigured: Boolean(process.env.RENAISS_API_KEY && process.env.RENAISS_API_SECRET),
    checkedAt: new Date().toISOString(),
  })
})

module.exports = router
