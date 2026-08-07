const router = require('express').Router()
const { runScout } = require('../lib/scout-agent')
const { listAudits } = require('../lib/audit-log')
const { requireOperatorForSpend, tokenFromRequest, safeEqualString } = require('../lib/operator-auth')
const stateStore = require('../lib/state-store')
const { rateLimit } = require('../lib/rate-limit')

router.post('/run', rateLimit({ windowMs: 60_000, max: 30 }), requireOperatorForSpend, async (req, res, next) => {
  try {
    const result = await runScout({ ...(req.body || {}), mode: req.effectiveMode, operatorAuthorized: req.operatorAuthorized })
    res.json(result)
  } catch (error) {
    next(error)
  }
})

router.get('/audits', async (req, res, next) => {
  try {
    const token = tokenFromRequest(req)
    const full = Boolean(process.env.SLABSCOUT_OPERATOR_TOKEN && token && safeEqualString(token, process.env.SLABSCOUT_OPERATOR_TOKEN))
    const persisted = await stateStore.listAudits({ redacted: !full })
    res.json({ audits: persisted.length > 0 ? persisted : listAudits(), redacted: !full })
  } catch (error) {
    next(error)
  }
})

router.use((error, _req, res, _next) => {
  res.status(error.statusCode || 400).json({
    error: 'SlabScout run failed',
    message: error.message,
  })
})

module.exports = router
