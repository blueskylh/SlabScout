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

function redactAudit(row) {
  return {
    auditId: row.auditId,
    savedAt: row.savedAt,
    runId: row.runId,
    offerId: row.offerId,
    policyVersion: row.policyVersion,
    action: row.action,
    executionStatus: row.executionStatus,
    proofKind: row.proofKind,
    proofHash: row.proofHash,
    escrowTxHash: row.escrowTxHash || null,
  }
}

function assertOperatorToken(req) {
  const token = tokenFromRequest(req)
  if (!process.env.SLABSCOUT_OPERATOR_TOKEN) {
    const error = new Error('SLABSCOUT_OPERATOR_TOKEN is required')
    error.statusCode = 503
    throw error
  }
  if (!token) {
    const error = new Error('Operator token required')
    error.statusCode = 401
    throw error
  }
  if (!safeEqualString(token, process.env.SLABSCOUT_OPERATOR_TOKEN)) {
    const error = new Error('Invalid operator token')
    error.statusCode = 403
    throw error
  }
}

router.get('/reconciliations', async (req, res, next) => {
  try {
    assertOperatorToken(req)
    const unresolved = await stateStore.listUnresolvedReconciliations({ owner: 'operator:live' })
    res.json({ unresolved, count: unresolved.length })
  } catch (error) {
    next(error)
  }
})

router.get('/audits', async (req, res, next) => {
  try {
    const token = tokenFromRequest(req)
    const full = Boolean(process.env.SLABSCOUT_OPERATOR_TOKEN && token && safeEqualString(token, process.env.SLABSCOUT_OPERATOR_TOKEN))
    const persisted = await stateStore.listAudits({ redacted: !full })
    const fallback = listAudits()
    res.json({ audits: persisted.length > 0 ? persisted : (full ? fallback : fallback.map(redactAudit)), redacted: !full })
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
