const { CONFIDENCE_LEVELS, DATA_MODES, EXECUTION_MODES } = require('./constants')

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/
const CERT_RE = /^[a-zA-Z0-9-]{4,64}$/

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function finiteNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function positiveNumber(value) {
  const parsed = finiteNumber(value)
  return parsed !== null && parsed > 0 ? parsed : null
}

function validateEnum(value, allowed, field, errors) {
  if (!allowed.includes(value)) errors.push(`${field} must be one of: ${allowed.join(', ')}`)
}

function validateAuthorization(input = {}) {
  const errors = []
  const auth = isPlainObject(input) ? input : {}
  if (!auth.targetCard || typeof auth.targetCard !== 'string' || auth.targetCard.trim().length < 3) {
    errors.push('targetCard is required')
  }
  if (positiveNumber(auth.maxOfferUsd) === null) errors.push('maxOfferUsd must be a positive number')
  const discount = positiveNumber(auth.maxPriceVsMedianPct)
  if (discount === null || discount > 100) errors.push('maxPriceVsMedianPct must be > 0 and <= 100')
  if (!CONFIDENCE_LEVELS.includes(auth.minConfidence)) errors.push(`minConfidence must be one of: ${CONFIDENCE_LEVELS.join(', ')}`)
  if (positiveNumber(auth.minSourceCount) === null) errors.push('minSourceCount must be positive')
  if (positiveNumber(auth.minObservationCount) === null) errors.push('minObservationCount must be positive')
  if (positiveNumber(auth.maxLastSaleAgeDays) === null) errors.push('maxLastSaleAgeDays must be positive')
  if (positiveNumber(auth.maxMethodDeviationPct) === null) errors.push('maxMethodDeviationPct must be positive')
  if (positiveNumber(auth.maxIntelFeeUsdc) === null) errors.push('maxIntelFeeUsdc must be positive')
  if (positiveNumber(auth.maxDepositUsdc) === null) errors.push('maxDepositUsdc must be positive')
  if (positiveNumber(auth.dailyBudgetUsdc) === null) errors.push('dailyBudgetUsdc must be positive')
  const spent = finiteNumber(auth.spentTodayUsdc)
  if (spent === null || spent < 0) errors.push('spentTodayUsdc must be >= 0')
  if (typeof auth.requireMarketProof !== 'boolean') errors.push('requireMarketProof must be boolean')
  return { ok: errors.length === 0, errors }
}

function validateOffer(input = {}, now = new Date()) {
  const errors = []
  const offer = isPlainObject(input) ? input : {}
  if (!offer.id || typeof offer.id !== 'string' || offer.id.trim().length < 3) errors.push('offer.id is required')
  if (!offer.targetCard || typeof offer.targetCard !== 'string' || offer.targetCard.trim().length < 3) errors.push('offer.targetCard is required')
  if (!offer.certNumber || typeof offer.certNumber !== 'string' || !CERT_RE.test(offer.certNumber)) errors.push('offer.certNumber is required')
  if (positiveNumber(offer.askUsd) === null) errors.push('offer.askUsd must be positive')
  if (positiveNumber(offer.depositUsdc) === null) errors.push('offer.depositUsdc must be positive')
  if (!offer.sellerAddress || !EVM_ADDRESS_RE.test(offer.sellerAddress)) errors.push('offer.sellerAddress must be a valid EVM address')
  if (!offer.expiresAt) {
    errors.push('offer.expiresAt is required')
  } else {
    const expiry = new Date(offer.expiresAt).getTime()
    if (!Number.isFinite(expiry)) errors.push('offer.expiresAt must be an ISO date')
    else if (expiry <= now.getTime()) errors.push('offer is expired')
  }
  if (offer.imageConfidence !== undefined && !CONFIDENCE_LEVELS.includes(offer.imageConfidence)) {
    errors.push(`offer.imageConfidence must be one of: ${CONFIDENCE_LEVELS.join(', ')}`)
  }
  return { ok: errors.length === 0, errors }
}

function validateMode(mode) {
  const errors = []
  validateEnum(mode, DATA_MODES, 'mode', errors)
  return { ok: errors.length === 0, errors }
}

function validateExecutionMode(mode, field = 'execution mode') {
  const errors = []
  validateEnum(mode, EXECUTION_MODES, field, errors)
  return { ok: errors.length === 0, errors }
}

function assertValid(label, result) {
  if (!result.ok) throw new Error(`${label}: ${result.errors.join('; ')}`)
}

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function textContainsAll(haystack, needles) {
  const normalizedHaystack = normalizeText(haystack)
  return needles.every((needle) => normalizedHaystack.includes(normalizeText(needle)))
}

function cardIdentityMatchesTarget({ targetCard, cardName, gradeLabel }) {
  const target = normalizeText(targetCard)
  const name = normalizeText(cardName)
  const grade = normalizeText(gradeLabel)
  return Boolean(target && name && grade && target.includes(name) && target.includes(grade))
}

module.exports = {
  EVM_ADDRESS_RE,
  CERT_RE,
  finiteNumber,
  positiveNumber,
  validateAuthorization,
  validateOffer,
  validateMode,
  validateExecutionMode,
  assertValid,
  normalizeText,
  textContainsAll,
  cardIdentityMatchesTarget,
}
