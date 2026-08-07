const router = require('express').Router()
const { runScout } = require('../lib/scout-agent')
const { listAudits } = require('../lib/audit-log')
const { requireOperatorForLive } = require('../lib/operator-auth')
const { rateLimit } = require('../lib/rate-limit')

router.post('/run', rateLimit({ windowMs: 60_000, max: 30 }), requireOperatorForLive, async (req, res, next) => {
  try {
    const result = await runScout({ ...(req.body || {}), operatorAuthorized: req.operatorAuthorized })
    res.json(result)
  } catch (error) {
    next(error)
  }
})

router.get('/audits', (_req, res) => {
  res.json({ audits: listAudits() })
})

router.use((error, _req, res, _next) => {
  res.status(error.statusCode || 400).json({
    error: 'SlabScout run failed',
    message: error.message,
  })
})

module.exports = router
