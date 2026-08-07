const router = require('express').Router()
const { DEFAULT_AUTHORIZATION, DEMO_OFFERS, DEMO_CARD } = require('../../packages/shared')
const { getCardSignal } = require('../../packages/renaiss-client')

router.get('/', async (_req, res, next) => {
  try {
    const signal = await getCardSignal({ mode: 'replay', card: DEMO_CARD, offer: DEMO_OFFERS[0] })
    res.json({
      app: 'SlabScout',
      defaultMode: process.env.SLABSCOUT_DEFAULT_MODE || 'replay',
      defaultAuthorization: DEFAULT_AUTHORIZATION,
      offers: DEMO_OFFERS,
      replaySignal: signal,
      disclosures: [
        'Renaiss credentials are backend-only environment variables.',
        'Arc and Circle adapters default to deterministic mock mode for hackathon demos.',
        'Replay mode uses a fixed Renaiss-shaped snapshot so the 3-minute demo remains stable.',
      ],
    })
  } catch (error) {
    next(error)
  }
})

router.use((error, _req, res, _next) => {
  res.status(400).json({ error: 'Demo config failed', message: error.message })
})

module.exports = router
