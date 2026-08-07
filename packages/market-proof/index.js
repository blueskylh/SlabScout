const crypto = require('node:crypto')
const { round, stableJson } = require('../shared')

function buildMarketProof({ signal, offer, authorization, payment }) {
  const medianUsd = signal.valuation.medianUsd
  const meanUsd = signal.valuation.meanUsd
  const vwapUsd = signal.valuation.vwapUsd
  const suggestedMaxUsd = medianUsd ? round(medianUsd * (authorization.maxPriceVsMedianPct / 100), 2) : null
  const completedTrades = (signal.trades?.recent || []).filter((trade) => trade.kind === 'transaction')
  const payload = {
    proofVersion: 'market-proof-v1.0.0',
    generatedAt: new Date().toISOString(),
    cardId: signal.card.id,
    cardName: `${signal.card.name} ${signal.card.gradeLabel}`,
    offerId: offer.id,
    askUsd: offer.askUsd,
    source: 'Renaiss OS Index',
    dataAsOf: signal.dataAsOf,
    confidence: signal.quality.confidence,
    sourceCount: signal.quality.sourceCount,
    observationCount: signal.quality.observationCount,
    medianUsd: round(medianUsd, 2),
    meanUsd: round(meanUsd, 2),
    vwapUsd: round(vwapUsd, 2),
    suggestedMaxUsd,
    completedTradeSample: completedTrades.slice(0, 5),
    listingRowsExcluded: signal.trades?.listingCount || 0,
    outliers: detectOutliers({ signal, offer, authorization }),
    paymentReceiptId: payment?.receiptId || null,
  }
  const canonical = stableJson(payload)
  const proofHash = `0x${crypto.createHash('sha256').update(canonical).digest('hex')}`
  const signingSecret = process.env.MARKET_PROOF_SIGNING_SECRET || 'slabscout-demo-signing-secret'
  const signature = `hmac-sha256:${crypto.createHmac('sha256', signingSecret).update(proofHash).digest('hex')}`

  return {
    ...payload,
    proofHash,
    signature,
    canonicalBytes: Buffer.byteLength(canonical, 'utf8'),
  }
}

function detectOutliers({ signal, offer, authorization }) {
  const outliers = []
  const medianUsd = signal.valuation.medianUsd
  if (!medianUsd) outliers.push('missing-median')
  if (medianUsd && offer.askUsd > medianUsd * (authorization.maxPriceVsMedianPct / 100)) {
    outliers.push('ask-above-authorized-discount')
  }
  if (signal.quality.sourceCount < authorization.minSourceCount) outliers.push('insufficient-sources')
  if (signal.quality.observationCount < authorization.minObservationCount) outliers.push('insufficient-observations')
  if ((signal.trades?.listingCount || 0) > 0) outliers.push('listings-excluded-from-proof')
  return outliers
}

module.exports = {
  buildMarketProof,
}
