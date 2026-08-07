const crypto = require('node:crypto')
const { round, stableJson } = require('../shared')
const { validProofHash } = require('../shared/validation')

const DEFAULT_SIGNING_SECRET = 'slabscout-demo-signing-secret'
const MAX_PROOF_AGE_MS = 15 * 60 * 1000
const MAX_SOURCE_AGE_MS = 30 * 24 * 60 * 60 * 1000

function getSigningSecret({ live = false } = {}) {
  const secret = process.env.MARKET_PROOF_SIGNING_SECRET || DEFAULT_SIGNING_SECRET
  if (live && secret === DEFAULT_SIGNING_SECRET) throw new Error('MARKET_PROOF_SIGNING_SECRET must be set to a non-default value in live mode')
  return secret
}

function assertLiveSigningSecret(mode) {
  if (mode === 'live') getSigningSecret({ live: true })
}

function canonicalProofPayload(proof) {
  const { proofHash, signature, canonicalBytes, verification, verified, ...payload } = proof || {}
  return payload
}

function hashPayload(payload) {
  return `0x${crypto.createHash('sha256').update(stableJson(payload)).digest('hex')}`
}

function timingSafeHexEqual(hexA, hexB) {
  if (typeof hexA !== 'string' || typeof hexB !== 'string') return false
  const cleanA = hexA.replace(/^0x/i, '')
  const cleanB = hexB.replace(/^0x/i, '')
  if (!/^[a-fA-F0-9]+$/.test(cleanA) || !/^[a-fA-F0-9]+$/.test(cleanB)) return false
  const a = Buffer.from(cleanA, 'hex')
  const b = Buffer.from(cleanB, 'hex')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function signingSecretForProof(proof) {
  return getSigningSecret({ live: String(proof?.dataMode || '').startsWith('live') })
}

function buildMarketProof({ signal, offer, authorization, payment }) {
  const medianUsd = signal.valuation.medianUsd
  const meanUsd = signal.valuation.meanUsd
  const vwapUsd = signal.valuation.vwapUsd
  const suggestedMaxUsd = medianUsd ? round(medianUsd * (authorization.maxPriceVsMedianPct / 100), 2) : null
  const completedTrades = Array.isArray(signal.trades?.recent) ? signal.trades.recent.filter((trade) => trade.kind === 'transaction') : []
  const aggregateRows = Array.isArray(signal.trades?.aggregateRows) ? signal.trades.aggregateRows : []
  const sourceSample = completedTrades.length > 0 ? completedTrades.slice(0, 5) : aggregateRows.slice(0, 5)
  const sourceTimestamps = sourceSample
    .map((trade) => ({ source: trade.source, observedAt: trade.observedAt, mode: completedTrades.length > 0 ? 'transaction' : 'aggregate-only' }))
    .filter((item) => item.observedAt)
    .slice(0, 10)
  const payload = {
    proofVersion: 'market-proof-v1.1.0',
    generatedAt: new Date().toISOString(),
    fetchedAt: signal.fetchedAt || signal.dataAsOf,
    sourceUpdatedAt: signal.sourceUpdatedAt || signal.dataAsOf,
    lastSaleAt: signal.lastSaleAt || signal.quality?.lastSaleAt || null,
    dataMode: signal.dataMode,
    targetItemId: authorization.targetItemId || offer.targetItemId,
    targetHref: authorization.targetHref || offer.targetHref,
    cardId: signal.card.id,
    cardName: `${signal.card.name} ${signal.card.gradeLabel}`,
    cardIdentity: {
      name: signal.card.name,
      setName: signal.card.setName,
      gradeLabel: signal.card.gradeLabel,
      company: signal.card.company,
      certNumber: signal.identity?.certNumber || offer.certNumber || null,
      certFound: signal.identity?.certFound || false,
      certMatchesOffer: signal.identity?.certMatchesOffer || false,
      certItemId: signal.identity?.certLookup?.itemId || null,
      certHref: signal.identity?.certLookup?.href || null,
    },
    offerId: offer.id,
    expiresAt: offer.expiresAt,
    askUsd: round(offer.askUsd, 2),
    source: 'Renaiss OS Index',
    confidence: signal.quality.confidence,
    sourceCount: signal.quality.sourceCount,
    observationCount: signal.quality.observationCount,
    medianUsd: round(medianUsd, 2),
    meanUsd: round(meanUsd, 2),
    vwapUsd: round(vwapUsd, 2),
    suggestedMaxUsd,
    tradeSampleMode: completedTrades.length > 0 ? 'transaction' : 'aggregate-only',
    sourceSample,
    sourceTimestamps,
    listingRowsExcluded: signal.trades?.listingCount || 0,
    outliers: detectOutliers({ signal, offer, authorization }),
    paymentReceipt: payment ? {
      receiptId: payment.receiptId,
      status: payment.status,
      amountUsdc: payment.amountUsdc,
      paidAt: payment.paidAt || null,
    } : null,
  }
  const canonical = stableJson(payload)
  const proofHash = hashPayload(payload)
  const signingSecret = signingSecretForProof(payload)
  const signature = `hmac-sha256:${crypto.createHmac('sha256', signingSecret).update(proofHash).digest('hex')}`
  return { ...payload, proofHash, signature, canonicalBytes: Buffer.byteLength(canonical, 'utf8') }
}

function compareNumber(a, b) {
  return Number(a) === Number(b)
}

function paymentConfirmed(status) {
  return ['replay-payment-confirmed', 'live-payment-confirmed', 'paid', 'confirmed'].includes(status)
}

function verifyMarketProof({ proof, offer, authorization, payment, now = new Date(), maxProofAgeMs = MAX_PROOF_AGE_MS, maxSourceAgeMs = MAX_SOURCE_AGE_MS } = {}) {
  const errors = []
  if (!proof || typeof proof !== 'object') return { ok: false, errors: ['proof missing'], proof: null }
  if (!validProofHash(proof.proofHash)) errors.push('proofHash must be a full 32-byte 0x-prefixed hex string')
  const payload = canonicalProofPayload(proof)
  const expectedHash = hashPayload(payload)
  if (validProofHash(proof.proofHash) && !timingSafeHexEqual(expectedHash, proof.proofHash)) errors.push('proofHash does not match canonical payload')
  if (typeof proof.signature !== 'string' || !/^hmac-sha256:[a-fA-F0-9]{64}$/.test(proof.signature)) {
    errors.push('signature format invalid')
  } else {
    const expectedSignature = `hmac-sha256:${crypto.createHmac('sha256', signingSecretForProof(proof)).update(proof.proofHash).digest('hex')}`
    const actual = proof.signature.slice('hmac-sha256:'.length)
    const expected = expectedSignature.slice('hmac-sha256:'.length)
    if (!timingSafeHexEqual(actual, expected)) errors.push('signature mismatch')
  }

  if (!offer || proof.offerId !== offer.id) errors.push('offerId mismatch')
  if (!authorization) errors.push('authorization missing')
  if (offer && authorization) {
    const targetItemId = authorization.targetItemId || offer.targetItemId
    const targetHref = authorization.targetHref || offer.targetHref
    if (proof.targetItemId !== targetItemId) errors.push('targetItemId mismatch')
    if (proof.targetHref !== targetHref) errors.push('targetHref mismatch')
    if (proof.cardId !== targetItemId) errors.push('cardId mismatch')
    if (proof.cardIdentity?.certItemId !== targetItemId) errors.push('cert item mismatch')
    if (proof.cardIdentity?.certHref !== targetHref) errors.push('cert href mismatch')
    if (proof.cardIdentity?.certNumber !== offer.certNumber || proof.cardIdentity?.certNumber !== authorization.certNumber) errors.push('cert mismatch')
    if (proof.cardIdentity?.gradeLabel !== offer.gradeLabel || proof.cardIdentity?.gradeLabel !== authorization.gradeLabel) errors.push('grade mismatch')
    if (proof.cardIdentity?.company !== offer.company || proof.cardIdentity?.company !== authorization.company) errors.push('grading company mismatch')
    if (!compareNumber(proof.askUsd, round(offer.askUsd, 2))) errors.push('ask mismatch')
    if (proof.expiresAt !== offer.expiresAt) errors.push('expiresAt mismatch')
  }

  const receipt = proof.paymentReceipt
  if (!receipt || !payment) errors.push('payment receipt missing')
  else {
    if (receipt.receiptId !== payment.receiptId) errors.push('payment receiptId mismatch')
    if (receipt.status !== payment.status) errors.push('payment status mismatch')
    if (!paymentConfirmed(receipt.status)) errors.push('payment not confirmed')
    if (!compareNumber(receipt.amountUsdc, payment.amountUsdc)) errors.push('payment amount mismatch')
  }

  const generatedAt = new Date(proof.generatedAt).getTime()
  const expiresAt = new Date(proof.expiresAt).getTime()
  const sourceUpdatedAt = new Date(proof.sourceUpdatedAt || proof.dataAsOf || 0).getTime()
  if (!Number.isFinite(generatedAt)) errors.push('generatedAt invalid')
  else {
    if (generatedAt - now.getTime() > 60_000) errors.push('generatedAt is in the future')
    if (now.getTime() - generatedAt > maxProofAgeMs) errors.push('proof expired by TTL')
  }
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) errors.push('offer expired')
  if (!Number.isFinite(sourceUpdatedAt) || sourceUpdatedAt <= 0) errors.push('sourceUpdatedAt invalid')
  else if (now.getTime() - sourceUpdatedAt > maxSourceAgeMs) errors.push('source data exceeded TTL')
  if (proof.tradeSampleMode !== 'transaction' && proof.tradeSampleMode !== 'aggregate-only') errors.push('tradeSampleMode invalid')
  if (proof.tradeSampleMode === 'transaction' && (!Array.isArray(proof.sourceSample) || proof.sourceSample.length < 1)) errors.push('transaction sample missing')
  if (proof.tradeSampleMode === 'aggregate-only' && Array.isArray(proof.sourceSample) && proof.sourceSample.some((row) => row.kind === 'transaction')) errors.push('aggregate-only proof cannot contain transaction rows')

  const ok = errors.length === 0
  return { ok, errors, proof: ok ? { ...proof, verified: true, verification: { ok: true, checkedAt: now.toISOString() } } : { ...proof, verified: false, verification: { ok: false, errors } } }
}

function detectOutliers({ signal, offer, authorization }) {
  const outliers = []
  const medianUsd = signal.valuation.medianUsd
  if (!medianUsd) outliers.push('missing-median')
  if (medianUsd && offer.askUsd > medianUsd * (authorization.maxPriceVsMedianPct / 100)) outliers.push('ask-above-authorized-discount')
  if (signal.quality.sourceCount < authorization.minSourceCount) outliers.push('insufficient-sources')
  if (signal.quality.observationCount < authorization.minObservationCount) outliers.push('insufficient-observations')
  if ((signal.trades?.listingCount || 0) > 0) outliers.push('listings-excluded-from-proof')
  if (signal.trades?.sampleMode === 'aggregate-only') outliers.push('aggregate-only-source-sample')
  return outliers
}

module.exports = {
  buildMarketProof,
  verifyMarketProof,
  canonicalProofPayload,
  hashPayload,
  getSigningSecret,
  assertLiveSigningSecret,
  DEFAULT_SIGNING_SECRET,
}
