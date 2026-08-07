const { confidenceMeets, pctDiff, round } = require('../shared')

function check(id, label, pass, details, severity = 'hard') {
  return {
    id,
    label,
    status: pass ? 'pass' : 'fail',
    severity,
    details,
  }
}

function warn(id, label, details) {
  return { id, label, status: 'warn', severity: 'soft', details }
}

function daysSince(iso, now = new Date()) {
  if (!iso) return Number.POSITIVE_INFINITY
  const timestamp = new Date(iso).getTime()
  if (!Number.isFinite(timestamp)) return Number.POSITIVE_INFINITY
  return Math.max(0, (now.getTime() - timestamp) / 86_400_000)
}

function evaluateSignal({ signal, offer, authorization, now = new Date(), ignoreRefreshing = false, proof = null }) {
  const valuation = signal.valuation || {}
  const quality = signal.quality || {}
  const identity = signal.identity || {}
  const medianUsd = valuation.medianUsd
  const meanUsd = valuation.meanUsd
  const vwapUsd = valuation.vwapUsd
  const askUsd = Number(offer.askUsd)
  const depositUsdc = Number(offer.depositUsdc)
  const intelFee = Number(authorization.intelFeeUsdc || process.env.MARKET_PROOF_PRICE_USDC || 0.001)
  const allowedByMedian = medianUsd ? round(medianUsd * (authorization.maxPriceVsMedianPct / 100), 2) : null
  const allowedAskUsd = Math.min(
    Number.isFinite(Number(authorization.maxOfferUsd)) ? Number(authorization.maxOfferUsd) : Number.POSITIVE_INFINITY,
    allowedByMedian || Number.POSITIVE_INFINITY,
  )
  const meanDeviationPct = pctDiff(meanUsd, medianUsd)
  const vwapDeviationPct = pctDiff(vwapUsd, medianUsd)
  const saleAgeDays = daysSince(quality.lastSaleAt, now)

  const checks = [
    check(
      'identity',
      '身份可信',
      identity.certFound === true || identity.imageConfidence === 'high',
      `image=${identity.imageConfidence || 'unknown'}, certFound=${identity.certFound}`,
    ),
    check(
      'confidence',
      '估值置信度达到授权门槛',
      confidenceMeets(quality.confidence, authorization.minConfidence),
      `actual=${quality.confidence || 'unknown'}, min=${authorization.minConfidence}`,
    ),
    check(
      'source-count',
      '来源数充足',
      Number(quality.sourceCount) >= Number(authorization.minSourceCount),
      `${quality.sourceCount || 0} / ${authorization.minSourceCount}`,
    ),
    check(
      'observation-count',
      '成交/观察样本充足',
      Number(quality.observationCount) >= Number(authorization.minObservationCount),
      `${quality.observationCount || 0} / ${authorization.minObservationCount}`,
    ),
    check(
      'freshness',
      '最近成交足够新',
      saleAgeDays <= Number(authorization.maxLastSaleAgeDays),
      `${round(saleAgeDays, 1)}d / ${authorization.maxLastSaleAgeDays}d`,
    ),
    check(
      'ask-discount',
      '报价低于授权价格上限',
      Number.isFinite(askUsd) && Number.isFinite(allowedAskUsd) && askUsd <= allowedAskUsd,
      `ask=$${round(askUsd, 2)}, allowed=$${round(allowedAskUsd, 2)}`,
    ),
    check(
      'mean-consistency',
      '均价与中位价偏差可接受',
      meanDeviationPct !== null && meanDeviationPct <= Number(authorization.maxMethodDeviationPct),
      `${round(meanDeviationPct, 2)}% / ${authorization.maxMethodDeviationPct}%`,
    ),
    check(
      'vwap-consistency',
      'VWAP 与中位价偏差可接受',
      vwapDeviationPct !== null && vwapDeviationPct <= Number(authorization.maxMethodDeviationPct),
      `${round(vwapDeviationPct, 2)}% / ${authorization.maxMethodDeviationPct}%`,
    ),
    check(
      'intel-budget',
      '情报费不超过单次授权',
      intelFee <= Number(authorization.maxIntelFeeUsdc),
      `${intelFee} / ${authorization.maxIntelFeeUsdc} USDC`,
    ),
    check(
      'deposit-budget',
      '订金不超过单次授权',
      depositUsdc <= Number(authorization.maxDepositUsdc),
      `${depositUsdc} / ${authorization.maxDepositUsdc} USDC`,
    ),
    check(
      'daily-budget',
      '累计日支出不超过授权',
      Number(authorization.spentTodayUsdc || 0) + intelFee + depositUsdc <= Number(authorization.dailyBudgetUsdc),
      `${round(Number(authorization.spentTodayUsdc || 0) + intelFee + depositUsdc, 6)} / ${authorization.dailyBudgetUsdc} USDC`,
    ),
  ]

  if (quality.refreshing && !ignoreRefreshing) {
    checks.push(warn('refreshing', 'Renaiss 正在刷新', '先购买 MarketProof，不直接付款'))
  }
  if (authorization.requireMarketProof && !proof) {
    checks.push(warn('proof-required', '授权要求市场证明', '先用 nanopayment 获取带哈希的 MarketProof'))
  }
  if (proof) {
    checks.push(check('proof-hash', 'MarketProof 哈希存在', Boolean(proof.proofHash), proof.proofHash || 'missing'))
  }

  const hardFails = checks.filter((item) => item.severity === 'hard' && item.status === 'fail')
  const warnings = checks.filter((item) => item.status === 'warn')
  const action = hardFails.length > 0 ? 'REJECT' : warnings.length > 0 ? 'INVESTIGATE' : 'RESERVE'

  return {
    action,
    policyVersion: 'slabscout-policy-v1.0.0',
    checkedAt: now.toISOString(),
    checks,
    hardFails,
    warnings,
    metrics: {
      askUsd: round(askUsd, 2),
      medianUsd: round(medianUsd, 2),
      allowedAskUsd: round(allowedAskUsd, 2),
      discountToMedianPct: medianUsd ? round((1 - askUsd / medianUsd) * 100, 2) : null,
      meanDeviationPct: round(meanDeviationPct, 2),
      vwapDeviationPct: round(vwapDeviationPct, 2),
      saleAgeDays: round(saleAgeDays, 1),
    },
    explanation: buildExplanation(action, hardFails, warnings),
  }
}

function buildExplanation(action, hardFails, warnings) {
  if (action === 'RESERVE') return '全部硬门槛通过，且无需更多调查；代理可锁订金。'
  if (action === 'INVESTIGATE') return `硬门槛通过，但存在 ${warnings.length} 个软门槛，需要先购买 MarketProof。`
  return `拒绝：${hardFails.map((item) => item.label).join('、')}。`
}

function finalizeWithProof({ signal, offer, authorization, proof, now = new Date() }) {
  return evaluateSignal({ signal, offer, authorization, now, ignoreRefreshing: true, proof })
}

module.exports = {
  evaluateSignal,
  finalizeWithProof,
  daysSince,
}
