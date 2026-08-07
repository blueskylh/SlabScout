const {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_USDC_ADDRESS,
  ZERO_ADDRESS,
  CONFIDENCE_LEVELS,
  DATA_MODES,
  EXECUTION_MODES,
  PROOF_HASH_RE,
  EVM_ADDRESS_RE,
  MAX_MARKET_PROOF_FEE_USDC,
  MAX_ESCROW_DEPOSIT_USDC,
} = require('./constants')

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

function nonZeroAddress(value) {
  return typeof value === 'string' && EVM_ADDRESS_RE.test(value) && value.toLowerCase() !== ZERO_ADDRESS.toLowerCase()
}

function validProofHash(value) {
  return typeof value === 'string' && PROOF_HASH_RE.test(value)
}

function validateEnum(value, allowed, field, errors) {
  if (!allowed.includes(value)) errors.push(`${field} must be one of: ${allowed.join(', ')}`)
}

function validateAuthorization(input = {}) {
  const errors = []
  const auth = isPlainObject(input) ? input : {}
  if (!auth.targetItemId && !auth.targetHref) errors.push('targetItemId or targetHref is required')
  if (!auth.targetCard || typeof auth.targetCard !== 'string' || auth.targetCard.trim().length < 3) errors.push('targetCard is required')
  if (!auth.certNumber || typeof auth.certNumber !== 'string' || !CERT_RE.test(auth.certNumber)) errors.push('certNumber is required')
  if (!auth.company || typeof auth.company !== 'string') errors.push('company is required')
  if (!auth.gradeLabel || typeof auth.gradeLabel !== 'string') errors.push('gradeLabel is required')
  if (positiveNumber(auth.maxOfferUsd) === null) errors.push('maxOfferUsd must be a positive number')
  const discount = positiveNumber(auth.maxPriceVsMedianPct)
  if (discount === null || discount > 100) errors.push('maxPriceVsMedianPct must be > 0 and <= 100')
  if (!CONFIDENCE_LEVELS.includes(auth.minConfidence)) errors.push(`minConfidence must be one of: ${CONFIDENCE_LEVELS.join(', ')}`)
  if (positiveNumber(auth.minSourceCount) === null) errors.push('minSourceCount must be positive')
  if (positiveNumber(auth.minObservationCount) === null) errors.push('minObservationCount must be positive')
  if (positiveNumber(auth.maxLastSaleAgeDays) === null) errors.push('maxLastSaleAgeDays must be positive')
  if (positiveNumber(auth.maxMethodDeviationPct) === null) errors.push('maxMethodDeviationPct must be positive')
  const maxIntelFee = positiveNumber(auth.maxIntelFeeUsdc)
  if (maxIntelFee === null) errors.push('maxIntelFeeUsdc must be positive')
  else if (maxIntelFee > MAX_MARKET_PROOF_FEE_USDC) errors.push(`maxIntelFeeUsdc must be <= ${MAX_MARKET_PROOF_FEE_USDC}`)
  const maxDeposit = positiveNumber(auth.maxDepositUsdc)
  if (maxDeposit === null) errors.push('maxDepositUsdc must be positive')
  else if (maxDeposit > MAX_ESCROW_DEPOSIT_USDC) errors.push(`maxDepositUsdc must be <= ${MAX_ESCROW_DEPOSIT_USDC}`)
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
  if (!offer.targetItemId && !offer.targetHref) errors.push('offer.targetItemId or offer.targetHref is required')
  if (!offer.targetCard || typeof offer.targetCard !== 'string' || offer.targetCard.trim().length < 3) errors.push('offer.targetCard is required')
  if (!offer.certNumber || typeof offer.certNumber !== 'string' || !CERT_RE.test(offer.certNumber)) errors.push('offer.certNumber is required')
  if (!offer.company || typeof offer.company !== 'string') errors.push('offer.company is required')
  if (!offer.gradeLabel || typeof offer.gradeLabel !== 'string') errors.push('offer.gradeLabel is required')
  if (positiveNumber(offer.askUsd) === null) errors.push('offer.askUsd must be positive')
  const offerDeposit = positiveNumber(offer.depositUsdc)
  if (offerDeposit === null) errors.push('offer.depositUsdc must be positive')
  else if (offerDeposit > MAX_ESCROW_DEPOSIT_USDC) errors.push(`offer.depositUsdc must be <= ${MAX_ESCROW_DEPOSIT_USDC}`)
  if (!nonZeroAddress(offer.sellerAddress)) errors.push('offer.sellerAddress must be a valid non-zero EVM address')
  if (!offer.expiresAt) errors.push('offer.expiresAt is required')
  else {
    const expiry = new Date(offer.expiresAt).getTime()
    if (!Number.isFinite(expiry)) errors.push('offer.expiresAt must be an ISO date')
    else if (expiry <= now.getTime()) errors.push('offer is expired')
  }
  if (offer.imageConfidence !== undefined && !CONFIDENCE_LEVELS.includes(offer.imageConfidence)) errors.push(`offer.imageConfidence must be one of: ${CONFIDENCE_LEVELS.join(', ')}`)
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

function validateRuntimeConfig(env = process.env, { live = false } = {}) {
  const errors = []
  const chainId = Number(env.ARC_CHAIN_ID || ARC_TESTNET_CHAIN_ID)
  if (chainId !== ARC_TESTNET_CHAIN_ID) errors.push(`ARC_CHAIN_ID must be ${ARC_TESTNET_CHAIN_ID}`)
  const usdc = env.ARC_USDC_ADDRESS || ARC_TESTNET_USDC_ADDRESS
  if (String(usdc).toLowerCase() !== ARC_TESTNET_USDC_ADDRESS.toLowerCase()) errors.push(`ARC_USDC_ADDRESS must be ${ARC_TESTNET_USDC_ADDRESS}`)
  validateEnum(env.CIRCLE_MODE || 'mock', EXECUTION_MODES, 'CIRCLE_MODE', errors)
  validateEnum(env.ARC_EXECUTION_MODE || 'mock', EXECUTION_MODES, 'ARC_EXECUTION_MODE', errors)
  if (env.RESERVATION_ESCROW_ADDRESS && !nonZeroAddress(env.RESERVATION_ESCROW_ADDRESS)) errors.push('RESERVATION_ESCROW_ADDRESS must be a valid non-zero EVM address')
  if (env.AGENT_WALLET_ADDRESS && !nonZeroAddress(env.AGENT_WALLET_ADDRESS)) errors.push('AGENT_WALLET_ADDRESS must be a valid non-zero EVM address')
  if (env.SELLER_WALLET_ADDRESS && !nonZeroAddress(env.SELLER_WALLET_ADDRESS)) errors.push('SELLER_WALLET_ADDRESS must be a valid non-zero EVM address')
  if (env.PROOF_HASH && !validProofHash(env.PROOF_HASH)) errors.push('PROOF_HASH must be a full 32-byte 0x-prefixed hex string')
  if (live && (!env.RESERVATION_ESCROW_ADDRESS || !env.AGENT_WALLET_ADDRESS)) errors.push('live mode requires RESERVATION_ESCROW_ADDRESS and AGENT_WALLET_ADDRESS')
  return { ok: errors.length === 0, errors }
}

function assertValid(label, result) {
  if (!result.ok) throw new Error(`${label}: ${result.errors.join('; ')}`)
}

function identityMatches({ authorization, offer, certLookup, cardDetail }) {
  if (!authorization || !offer || !certLookup || !cardDetail) return false
  if (!certLookup.found) return false
  const targetItemId = authorization.targetItemId || offer.targetItemId
  const targetHref = authorization.targetHref || offer.targetHref
  const certItemId = certLookup.itemId || certLookup.card?.id
  const certHref = certLookup.href || certLookup.card?.href
  const detailItemId = cardDetail.id
  const detailHref = cardDetail.href
  const company = authorization.company || offer.company
  const gradeLabel = authorization.gradeLabel || offer.gradeLabel
  return Boolean(
    targetItemId && targetHref &&
    offer.targetCard === authorization.targetCard &&
    offer.targetItemId === targetItemId &&
    offer.targetHref === targetHref &&
    certItemId === targetItemId &&
    detailItemId === targetItemId &&
    certHref === targetHref &&
    detailHref === targetHref &&
    certLookup.certNumber === offer.certNumber &&
    authorization.certNumber === offer.certNumber &&
    certLookup.company === company &&
    cardDetail.company === company &&
    offer.company === company &&
    certLookup.gradeLabel === gradeLabel &&
    cardDetail.gradeLabel === gradeLabel &&
    offer.gradeLabel === gradeLabel
  )
}

module.exports = {
  EVM_ADDRESS_RE,
  CERT_RE,
  finiteNumber,
  positiveNumber,
  nonZeroAddress,
  validProofHash,
  validateAuthorization,
  validateOffer,
  validateMode,
  validateExecutionMode,
  validateRuntimeConfig,
  assertValid,
  identityMatches,
}
