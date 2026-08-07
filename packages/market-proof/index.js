const crypto = require('node:crypto')
const {
  round,
  stableJson,
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_USDC_ADDRESS,
  ARC_TESTNET_NAME,
  DEFAULT_MARKET_PROOF_PRICE_USDC,
} = require('../shared')
const { validProofHash } = require('../shared/validation')

const DEFAULT_SIGNING_SECRET = 'slabscout-demo-signing-secret'
const DEFAULT_POLICY_SIGNING_SECRET = 'slabscout-demo-policy-proof-secret'
const MAX_PROOF_AGE_MS = 15 * 60 * 1000
const MAX_SOURCE_AGE_MS = 30 * 24 * 60 * 60 * 1000
const MAX_PAYMENT_AGE_MS = 15 * 60 * 1000

function getSigningSecret({ live = false } = {}) {
  const secret = process.env.MARKET_PROOF_SIGNING_SECRET || DEFAULT_SIGNING_SECRET
  if (live && secret === DEFAULT_SIGNING_SECRET) throw new Error('MARKET_PROOF_SIGNING_SECRET must be set to a non-default value in live mode')
  return secret
}

function getPolicySigningSecret({ live = false } = {}) {
  const secret = process.env.POLICY_PROOF_SIGNING_SECRET || DEFAULT_POLICY_SIGNING_SECRET
  if (live && secret === DEFAULT_POLICY_SIGNING_SECRET) throw new Error('POLICY_PROOF_SIGNING_SECRET must be set to a non-default value in live mode')
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

function hmacPayload(secret, proofHash) {
  return `hmac-sha256:${crypto.createHmac('sha256', secret).update(proofHash).digest('hex')}`
}

function timingSafeHexEqual(hexA, hexB) {
  if (typeof hexA !== 'string' || typeof hexB !== 'string') return false
  const cleanA = hexA.replace(/^0x/i, '').replace(/^hmac-sha256:/i, '')
  const cleanB = hexB.replace(/^0x/i, '').replace(/^hmac-sha256:/i, '')
  if (!/^[a-fA-F0-9]+$/.test(cleanA) || !/^[a-fA-F0-9]+$/.test(cleanB)) return false
  const a = Buffer.from(cleanA, 'hex')
  const b = Buffer.from(cleanB, 'hex')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function signingSecretForProof(proof) {
  return getSigningSecret({ live: String(proof?.dataMode || '').startsWith('live') })
}

function policySigningSecretForProof(proof) {
  return getPolicySigningSecret({ live: String(proof?.dataMode || '').startsWith('live') })
}

function normalizeExpectedDataMode(expectedMode) {
  if (expectedMode === 'replay') return 'replay'
  if (String(expectedMode || '').startsWith('live')) return 'live'
  return expectedMode || null
}

function proofModeMatches(proofDataMode, expectedMode) {
  const expected = normalizeExpectedDataMode(expectedMode)
  if (!expected) return true
  if (expected === 'replay') return proofDataMode === 'replay'
  if (expected === 'live') return String(proofDataMode || '').startsWith('live')
  return proofDataMode === expectedMode
}

function buildMarketProof({ signal, offer, authorization, payment, runId, idempotencyKey }) {
  const medianUsd = signal.valuation.medianUsd
  const meanUsd = signal.valuation.meanUsd
  const vwapUsd = signal.valuation.vwapUsd
  const suggestedMaxUsd = medianUsd ? round(medianUsd * (authorization.maxPriceVsMedianPct / 100), 2) : null
  const completedTrades = Array.isArray(signal.trades?.recent) ? signal.trades.recent.filter((trade) => trade.kind === 'transaction') : []
  const aggregateRows = Array.isArray(signal.trades?.aggregateRows) ? signal.trades.aggregateRows.filter((trade) => trade.kind !== 'transaction') : []
  const sourceSample = completedTrades.length > 0 ? completedTrades.slice(0, 5) : aggregateRows.slice(0, 5)
  const sourceTimestamps = sourceSample
    .map((trade) => ({ source: trade.source, observedAt: trade.observedAt, mode: completedTrades.length > 0 ? 'transaction' : 'aggregate-only' }))
    .filter((item) => item.observedAt)
    .slice(0, 10)
  const payload = {
    proofKind: 'MarketProof',
    proofVersion: 'market-proof-v1.2.0',
    runId: runId || payment?.runId || null,
    idempotencyKey: idempotencyKey || payment?.idempotencyKey || null,
    generatedAt: new Date().toISOString(),
    fetchedAt: signal.fetchedAt || signal.dataAsOf,
    sourceUpdatedAt: signal.sourceUpdatedAt || signal.dataAsOf,
    lastSaleAt: signal.lastSaleAt || signal.quality?.lastSaleAt || null,
    dataMode: signal.dataMode,
    targetItemId: authorization.targetItemId || offer.targetItemId,
    targetHref: authorization.targetHref || offer.targetHref,
    cardId: signal.card.id,
    cardHref: signal.card.href,
    cardName: `${signal.card.name} ${signal.card.gradeLabel}`,
    cardIdentity: {
      displayLabel: authorization.displayLabel || authorization.targetCard,
      targetCard: authorization.targetCard,
      name: signal.card.name,
      setName: signal.card.setName,
      language: signal.card.language || null,
      gradeLabel: signal.card.gradeLabel,
      company: signal.card.company,
      certNumber: signal.identity?.certNumber || offer.certNumber || null,
      certFound: signal.identity?.certFound || false,
      certMatchesOffer: signal.identity?.certMatchesOffer || false,
      certItemId: signal.identity?.certLookup?.itemId || null,
      certHref: signal.identity?.certLookup?.href || null,
    },
    offerId: offer.id,
    sellerAddress: offer.sellerAddress,
    expiresAt: offer.expiresAt,
    askUsd: round(offer.askUsd, 2),
    depositUsdc: round(offer.depositUsdc, 6),
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
    paymentReceipt: payment ? canonicalPaymentReceipt(payment) : null,
  }
  const canonical = stableJson(payload)
  const proofHash = hashPayload(payload)
  const signature = hmacPayload(signingSecretForProof(payload), proofHash)
  return { ...payload, proofHash, signature, canonicalBytes: Buffer.byteLength(canonical, 'utf8') }
}

function buildPolicyProof({ runId, idempotencyKey, signal, offer, authorization, decision }) {
  const payload = {
    proofKind: 'PolicyProof',
    proofVersion: 'policy-proof-v1.0.0',
    runId,
    idempotencyKey: idempotencyKey || null,
    generatedAt: new Date().toISOString(),
    dataMode: signal.dataMode,
    sourceUpdatedAt: signal.sourceUpdatedAt || signal.dataAsOf,
    targetItemId: authorization.targetItemId || offer.targetItemId,
    targetHref: authorization.targetHref || offer.targetHref,
    certNumber: authorization.certNumber,
    company: authorization.company,
    gradeLabel: authorization.gradeLabel,
    offerId: offer.id,
    sellerAddress: offer.sellerAddress,
    askUsd: round(offer.askUsd, 2),
    depositUsdc: round(offer.depositUsdc, 6),
    requireMarketProof: false,
    decision: {
      action: decision.action,
      policyVersion: decision.policyVersion,
      checkedAt: decision.checkedAt,
      metrics: decision.metrics,
    },
  }
  const canonical = stableJson(payload)
  const proofHash = hashPayload(payload)
  const signature = hmacPayload(policySigningSecretForProof(payload), proofHash)
  return { ...payload, proofHash, signature, canonicalBytes: Buffer.byteLength(canonical, 'utf8') }
}

function canonicalPaymentReceipt(payment) {
  if (!payment) return null
  return {
    paymentKind: payment.paymentKind || 'MarketProofPayment',
    runId: payment.runId || null,
    idempotencyKey: payment.idempotencyKey || null,
    offerId: payment.offerId || null,
    targetItemId: payment.targetItemId || null,
    targetHref: payment.targetHref || null,
    payerWallet: payment.payerWallet || null,
    payeeService: payment.payeeService || null,
    network: payment.network || null,
    chainId: payment.chainId ?? null,
    asset: payment.asset || null,
    usdcAddress: payment.usdcAddress || null,
    amountUsdc: payment.amountUsdc ?? null,
    receiptId: payment.receiptId || null,
    circlePaymentId: payment.circlePaymentId || null,
    txHash: payment.txHash || null,
    paidAt: payment.paidAt || null,
    providerStatus: payment.providerStatus || null,
    confirmed: payment.confirmed === true,
    simulated: payment.simulated === true,
    replayAccepted: payment.replayAccepted === true,
  }
}

function compareNumber(a, b) {
  return Number(a) === Number(b)
}

function verifyPaymentReceipt({ payment, runId, idempotencyKey, offer, authorization, expectedMode = 'live', now = new Date(), maxPaymentAgeMs = MAX_PAYMENT_AGE_MS, isReceiptUsed } = {}) {
  const errors = []
  const receipt = canonicalPaymentReceipt(payment)
  if (!receipt) return { ok: false, errors: ['payment missing'], receipt: null }
  const replayMode = normalizeExpectedDataMode(expectedMode) === 'replay'
  const expectedAmount = Number(process.env.MARKET_PROOF_PRICE_USDC || DEFAULT_MARKET_PROOF_PRICE_USDC)
  if (receipt.runId !== runId) errors.push('payment runId mismatch')
  if ((idempotencyKey || null) !== receipt.idempotencyKey) errors.push('payment idempotencyKey mismatch')
  if (!offer || receipt.offerId !== offer.id) errors.push('payment offerId mismatch')
  if (offer && receipt.targetItemId !== offer.targetItemId) errors.push('payment targetItemId mismatch')
  if (offer && receipt.targetHref !== offer.targetHref) errors.push('payment targetHref mismatch')
  if (!compareNumber(receipt.amountUsdc, expectedAmount)) errors.push('payment amount mismatch')
  if (authorization && Number(receipt.amountUsdc) > Number(authorization.maxIntelFeeUsdc)) errors.push('payment exceeds authorization')
  if (receipt.network !== ARC_TESTNET_NAME) errors.push('payment network mismatch')
  if (Number(receipt.chainId) !== ARC_TESTNET_CHAIN_ID) errors.push('payment chainId mismatch')
  if (receipt.asset !== 'USDC') errors.push('payment asset mismatch')
  if (String(receipt.usdcAddress || '').toLowerCase() !== ARC_TESTNET_USDC_ADDRESS.toLowerCase()) errors.push('payment USDC address mismatch')

  if (replayMode) {
    if (receipt.confirmed === true) errors.push('replay payment cannot be confirmed')
    if (receipt.providerStatus !== 'simulated') errors.push('replay provider status must be simulated')
    if (receipt.simulated !== true || receipt.replayAccepted !== true) errors.push('replay payment must be explicitly simulated and replayAccepted')
    if (receipt.txHash) errors.push('replay payment cannot include txHash')
  } else {
    if (receipt.confirmed !== true) errors.push('live payment must have confirmed=true')
    if (!receipt.receiptId) errors.push('live payment receiptId missing')
    if (!receipt.circlePaymentId && !receipt.txHash) errors.push('live payment requires Circle payment ID or tx hash')
    if (!['confirmed', 'settled'].includes(receipt.providerStatus)) errors.push('live provider status is not confirmed')
    if (!receipt.payerWallet) errors.push('live payer wallet missing')
    if (!receipt.payeeService) errors.push('live payee/service missing')
  }

  const paidAt = new Date(receipt.paidAt || 0).getTime()
  if (!Number.isFinite(paidAt) || paidAt <= 0) errors.push('payment paidAt invalid')
  else {
    if (paidAt - now.getTime() > 60_000) errors.push('payment paidAt is in the future')
    if (now.getTime() - paidAt > maxPaymentAgeMs) errors.push('payment receipt expired')
  }
  if (receipt.receiptId && typeof isReceiptUsed === 'function' && isReceiptUsed(receipt.receiptId, { runId, offerId: offer?.id })) errors.push('payment receipt replayed')
  const ok = errors.length === 0
  return { ok, errors, receipt, acceptance: ok ? (replayMode ? 'replay-simulation' : 'live-confirmed') : 'rejected' }
}

function verifyMarketProof({ proof, offer, authorization, payment, runId, idempotencyKey, expectedMode = 'live', now = new Date(), maxProofAgeMs = MAX_PROOF_AGE_MS, maxSourceAgeMs = MAX_SOURCE_AGE_MS, isReceiptUsed } = {}) {
  const errors = []
  if (!proof || typeof proof !== 'object') return { ok: false, errors: ['proof missing'], proof: null, proofKind: 'MarketProof' }
  if (proof.proofKind !== 'MarketProof') errors.push('proofKind must be MarketProof')
  if (!proofModeMatches(proof.dataMode, expectedMode)) errors.push('proof dataMode does not match current run mode')
  if (!validProofHash(proof.proofHash)) errors.push('proofHash must be a full 32-byte 0x-prefixed hex string')
  const payload = canonicalProofPayload(proof)
  const expectedHash = hashPayload(payload)
  if (validProofHash(proof.proofHash) && !timingSafeHexEqual(expectedHash, proof.proofHash)) errors.push('proofHash does not match canonical payload')
  if (typeof proof.signature !== 'string' || !/^hmac-sha256:[a-fA-F0-9]{64}$/.test(proof.signature)) {
    errors.push('signature format invalid')
  } else {
    const expectedSignature = hmacPayload(signingSecretForProof(proof), proof.proofHash)
    if (!timingSafeHexEqual(proof.signature, expectedSignature)) errors.push('signature mismatch')
  }

  if (proof.runId !== runId) errors.push('proof runId mismatch')
  if ((idempotencyKey || null) !== proof.idempotencyKey) errors.push('proof idempotencyKey mismatch')
  if (!offer || proof.offerId !== offer.id) errors.push('offerId mismatch')
  if (!authorization) errors.push('authorization missing')
  if (offer && authorization) {
    const targetItemId = authorization.targetItemId || offer.targetItemId
    const targetHref = authorization.targetHref || offer.targetHref
    if (proof.targetItemId !== targetItemId) errors.push('targetItemId mismatch')
    if (proof.targetHref !== targetHref) errors.push('targetHref mismatch')
    if (proof.cardId !== targetItemId) errors.push('cardId mismatch')
    if (proof.cardHref !== targetHref) errors.push('cardHref mismatch')
    if (proof.cardIdentity?.certItemId !== targetItemId) errors.push('cert item mismatch')
    if (proof.cardIdentity?.certHref !== targetHref) errors.push('cert href mismatch')
    if (proof.cardIdentity?.targetCard !== authorization.targetCard) errors.push('targetCard mismatch')
    if (proof.cardIdentity?.certNumber !== offer.certNumber || proof.cardIdentity?.certNumber !== authorization.certNumber) errors.push('cert mismatch')
    if (proof.cardIdentity?.gradeLabel !== offer.gradeLabel || proof.cardIdentity?.gradeLabel !== authorization.gradeLabel) errors.push('grade mismatch')
    if (proof.cardIdentity?.company !== offer.company || proof.cardIdentity?.company !== authorization.company) errors.push('grading company mismatch')
    if (proof.sellerAddress !== offer.sellerAddress) errors.push('seller mismatch')
    if (!compareNumber(proof.askUsd, round(offer.askUsd, 2))) errors.push('ask mismatch')
    if (!compareNumber(proof.depositUsdc, round(offer.depositUsdc, 6))) errors.push('deposit mismatch')
    if (proof.expiresAt !== offer.expiresAt) errors.push('expiresAt mismatch')
  }

  const paymentCheck = verifyPaymentReceipt({ payment, runId, idempotencyKey, offer, authorization, expectedMode, now, isReceiptUsed })
  if (!paymentCheck.ok) errors.push(...paymentCheck.errors)
  if (JSON.stringify(proof.paymentReceipt) !== JSON.stringify(paymentCheck.receipt)) errors.push('payment receipt payload mismatch')

  const generatedAt = new Date(proof.generatedAt).getTime()
  const expiresAt = new Date(proof.expiresAt).getTime()
  const sourceUpdatedAt = new Date(proof.sourceUpdatedAt || 0).getTime()
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
  if (proof.tradeSampleMode === 'transaction' && proof.sourceSample.some((row) => row.kind !== 'transaction')) errors.push('transaction proof sample contains non-transaction row')
  if (proof.tradeSampleMode === 'aggregate-only' && Array.isArray(proof.sourceSample) && proof.sourceSample.some((row) => row.kind === 'transaction')) errors.push('aggregate-only proof cannot contain transaction rows')

  const ok = errors.length === 0
  return {
    ok,
    errors,
    proofKind: 'MarketProof',
    acceptance: paymentCheck.acceptance,
    proof: ok ? { ...proof, verified: true, verification: { ok: true, checkedAt: now.toISOString(), verifiedBy: 'slabscout-market-proof-verifier' } } : { ...proof, verified: false, verification: { ok: false, errors } },
  }
}

function verifyPolicyProof({ proof, offer, authorization, decision, runId, idempotencyKey, expectedMode = 'replay', now = new Date(), maxProofAgeMs = MAX_PROOF_AGE_MS } = {}) {
  const errors = []
  if (!proof || typeof proof !== 'object') return { ok: false, errors: ['proof missing'], proof: null, proofKind: 'PolicyProof' }
  if (proof.proofKind !== 'PolicyProof') errors.push('proofKind must be PolicyProof')
  if (!proofModeMatches(proof.dataMode, expectedMode)) errors.push('policy proof dataMode mismatch')
  if (authorization?.requireMarketProof !== false) errors.push('PolicyProof requires authorization.requireMarketProof=false')
  if (!validProofHash(proof.proofHash)) errors.push('policy proofHash invalid')
  const payload = canonicalProofPayload(proof)
  const expectedHash = hashPayload(payload)
  if (validProofHash(proof.proofHash) && !timingSafeHexEqual(expectedHash, proof.proofHash)) errors.push('policy proof hash mismatch')
  if (typeof proof.signature !== 'string' || !/^hmac-sha256:[a-fA-F0-9]{64}$/.test(proof.signature)) errors.push('policy signature format invalid')
  else if (!timingSafeHexEqual(proof.signature, hmacPayload(policySigningSecretForProof(proof), proof.proofHash))) errors.push('policy signature mismatch')
  if (proof.runId !== runId) errors.push('policy runId mismatch')
  if ((idempotencyKey || null) !== proof.idempotencyKey) errors.push('policy idempotencyKey mismatch')
  if (!offer || proof.offerId !== offer.id) errors.push('policy offer mismatch')
  if (offer && authorization) {
    if (proof.targetItemId !== (authorization.targetItemId || offer.targetItemId)) errors.push('policy targetItemId mismatch')
    if (proof.targetHref !== (authorization.targetHref || offer.targetHref)) errors.push('policy targetHref mismatch')
    if (proof.certNumber !== authorization.certNumber || proof.certNumber !== offer.certNumber) errors.push('policy cert mismatch')
    if (proof.company !== authorization.company || proof.company !== offer.company) errors.push('policy company mismatch')
    if (proof.gradeLabel !== authorization.gradeLabel || proof.gradeLabel !== offer.gradeLabel) errors.push('policy grade mismatch')
    if (proof.sellerAddress !== offer.sellerAddress) errors.push('policy seller mismatch')
    if (!compareNumber(proof.askUsd, round(offer.askUsd, 2))) errors.push('policy ask mismatch')
    if (!compareNumber(proof.depositUsdc, round(offer.depositUsdc, 6))) errors.push('policy deposit mismatch')
  }
  if (!decision || proof.decision?.action !== decision.action || proof.decision?.policyVersion !== decision.policyVersion) errors.push('policy decision mismatch')
  const generatedAt = new Date(proof.generatedAt).getTime()
  if (!Number.isFinite(generatedAt)) errors.push('policy generatedAt invalid')
  else {
    if (generatedAt - now.getTime() > 60_000) errors.push('policy generatedAt is in the future')
    if (now.getTime() - generatedAt > maxProofAgeMs) errors.push('policy proof expired by TTL')
  }
  const ok = errors.length === 0
  return { ok, errors, proofKind: 'PolicyProof', proof: ok ? { ...proof, verified: true, verification: { ok: true, checkedAt: now.toISOString(), verifiedBy: 'slabscout-policy-proof-verifier' } } : { ...proof, verified: false, verification: { ok: false, errors } } }
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
  buildPolicyProof,
  verifyMarketProof,
  verifyPolicyProof,
  verifyPaymentReceipt,
  canonicalProofPayload,
  canonicalPaymentReceipt,
  hashPayload,
  getSigningSecret,
  getPolicySigningSecret,
  assertLiveSigningSecret,
  DEFAULT_SIGNING_SECRET,
  DEFAULT_POLICY_SIGNING_SECRET,
}
