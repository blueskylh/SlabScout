const router = require('express').Router()
const { runScout } = require('../lib/scout-agent')
const { listAudits } = require('../lib/audit-log')

router.post('/run', async (req, res, next) => {
  try {
    const result = await runScout(req.body || {})
    res.json(result)
  } catch (error) {
    next(error)
  }
})

router.get('/audits', (_req, res) => {
  res.json({ audits: listAudits() })
})

router.use((error, _req, res, _next) => {
  res.status(400).json({
    error: 'SlabScout run failed',
    message: error.message,
  })
})

module.exports = router
