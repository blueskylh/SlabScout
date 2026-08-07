const crypto = require('node:crypto')

function safeEqualString(actual = '', expected = '') {
  const a = Buffer.from(String(actual))
  const b = Buffer.from(String(expected))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function tokenFromRequest(req) {
  const header = req.get ? req.get('x-slabscout-operator-token') : req.headers?.['x-slabscout-operator-token']
  if (header) return header
  const auth = req.get ? req.get('authorization') : req.headers?.authorization
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice('Bearer '.length)
  return null
}

function modeRequiresOperator(body = {}) {
  return body.mode === 'live'
}

function operatorError(statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function assertOperatorAuthorized(req) {
  if (!modeRequiresOperator(req.body || {})) return true
  const configured = process.env.SLABSCOUT_OPERATOR_TOKEN
  if (!configured) throw operatorError(403, 'Live execution requires SLABSCOUT_OPERATOR_TOKEN to be configured on the server')
  const supplied = tokenFromRequest(req)
  if (!supplied) throw operatorError(401, 'Live execution requires an operator token')
  if (!safeEqualString(supplied, configured)) throw operatorError(403, 'Invalid operator token')
  return true
}

function requireOperatorForLive(req, _res, next) {
  try {
    req.operatorAuthorized = assertOperatorAuthorized(req)
    next()
  } catch (error) {
    next(error)
  }
}

module.exports = { safeEqualString, tokenFromRequest, modeRequiresOperator, assertOperatorAuthorized, requireOperatorForLive }
