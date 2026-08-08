const { confidenceMeets, pctDiff, round } = require('../shared')
const { verifyMarketProof } = require('../market-proof')

// Localized copy is emitted as parallel `*Zh` siblings so the UI can switch
// language instantly without re-running the agent. English stays the primary
// field, which keeps the API shape backward compatible.
function pair(value, key) {
  if (value && typeof value === 'object') return { [key]: value.en, [`${key}Zh`]: value.zh }
  return { [key]: value, [`${key}Zh`]: value }
}

function check(id, label, pass, details, severity = 'hard') {
  return { id, ...pair(label, 'label'), status: pass ? 'pass' : 'fail', severity, ...pair(details, 'details') }
}

function warn(id, label, details) {
  return { id, ...pair(label, 'label'), status: 'warn', severity: 'soft', ...pair(details, 'details') }
}

function daysSince(iso, now = new Date()) {
  if (!iso) return Number.POSITIVE_INFINITY
  const timestamp = new Date(iso).getTime()
  if (!Number.isFinite(timestamp)) return Number.POSITIVE_INFINITY
  return Math.max(0, (now.getTime() - timestamp) / 86_400_000)
}

function finiteNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function positiveNumber(value) {
  const parsed = finiteNumber(value)
  return parsed !== null && parsed > 0 ? parsed : null
}

function display(value, digits = 2) {
  const rounded = round(value, digits)
  return rounded === null ? 'missing' : rounded
}

function plannedIntelFee({ authorization, quality, proof, ignoreRefreshing }) {
  const configuredFee = positiveNumber(authorization.intelFeeUsdc || process.env.MARKET_PROOF_PRICE_USDC || 0.001)
  const needsProof = Boolean(proof) || authorization.requireMarketProof === true
  return needsProof ? configuredFee : 0
}

function proofIsVerified(proof, proofVerification) {
  return Boolean(
    proof &&
    proofVerification &&
    proofVerification.ok === true &&
    proofVerification.proofKind === 'MarketProof' &&
    proofVerification.proof?.proofHash === proof.proofHash &&
    proofVerification.proof?.runId === proof.runId &&
    proofVerification.proof?.offerId === proof.offerId &&
    proofVerification.proof?.idempotencyKey === proof.idempotencyKey
  )
}

function evaluateSignal({ signal, offer, authorization, now = new Date(), ignoreRefreshing = false, proof = null, proofVerification = null }) {
  const valuation = signal.valuation || {}
  const quality = signal.quality || {}
  const identity = signal.identity || {}
  const medianUsd = positiveNumber(valuation.medianUsd)
  const meanUsd = positiveNumber(valuation.meanUsd)
  const vwapUsd = positiveNumber(valuation.vwapUsd)
  const askUsd = positiveNumber(offer.askUsd)
  const depositUsdc = positiveNumber(offer.depositUsdc)
  const intelFee = plannedIntelFee({ authorization, quality, proof, ignoreRefreshing })
  const maxOfferUsd = positiveNumber(authorization.maxOfferUsd)
  const maxPriceVsMedianPct = positiveNumber(authorization.maxPriceVsMedianPct)
  const maxIntelFeeUsdc = positiveNumber(authorization.maxIntelFeeUsdc)
  const maxDepositUsdc = positiveNumber(authorization.maxDepositUsdc)
  const dailyBudgetUsdc = positiveNumber(authorization.dailyBudgetUsdc)
  const spentTodayUsdc = finiteNumber(authorization.spentTodayUsdc) ?? 0
  const allowedByMedian = medianUsd && maxPriceVsMedianPct ? round(medianUsd * (maxPriceVsMedianPct / 100), 2) : null
  const allowedAskCandidates = [maxOfferUsd, allowedByMedian].filter((value) => typeof value === 'number' && Number.isFinite(value))
  const allowedAskUsd = allowedAskCandidates.length > 0 ? Math.min(...allowedAskCandidates) : null
  const meanDeviationPct = pctDiff(meanUsd, medianUsd)
  const vwapDeviationPct = pctDiff(vwapUsd, medianUsd)
  const saleAgeDays = daysSince(signal.lastSaleAt || quality.lastSaleAt, now)

  const checks = [
    check('execution-data-mode', { en: 'Replay fallback must not trigger real execution', zh: '实时失败回放不得触发真实执行' }, signal.dataMode !== 'REPLAY_FALLBACK', signal.dataMode || 'unknown'),
    check(
      'identity',
      { en: 'Identity is trustworthy', zh: '身份可信' },
      identity.certMatchesOffer === true && identity.imageConfidence !== 'low',
      `image=${identity.imageConfidence || 'unknown'}, certFound=${identity.certFound}, certMatch=${identity.certMatchesOffer}`,
    ),
    check(
      'cert-lookup',
      { en: 'Cert lookup matches the target card', zh: '证书查询与目标卡匹配' },
      identity.certFound === true && identity.certMatchesOffer === true,
      `cert=${identity.certNumber || 'missing'}, found=${identity.certFound}, match=${identity.certMatchesOffer}`,
    ),
    check(
      'confidence',
      { en: 'Valuation confidence meets the authorized floor', zh: '估值置信度达到授权门槛' },
      confidenceMeets(quality.confidence, authorization.minConfidence),
      `actual=${quality.confidence || 'unknown'}, min=${authorization.minConfidence}`,
    ),
    check('source-count', { en: 'Enough independent sources', zh: '来源数充足' }, Number(quality.sourceCount) >= Number(authorization.minSourceCount), `${quality.sourceCount || 0} / ${authorization.minSourceCount}`),
    check('observation-count', { en: 'Enough sale/observation samples', zh: '成交/观察样本充足' }, Number(quality.observationCount) >= Number(authorization.minObservationCount), `${quality.observationCount || 0} / ${authorization.minObservationCount}`),
    check('freshness', { en: 'Most recent sale is fresh enough', zh: '最近成交足够新' }, saleAgeDays <= Number(authorization.maxLastSaleAgeDays), `${display(saleAgeDays, 1)}d / ${authorization.maxLastSaleAgeDays}d`),
    check('valuation-present', { en: '7-day median / mean / VWAP all present', zh: '7 日中位价/均价/VWAP 存在' }, Boolean(medianUsd && meanUsd && vwapUsd), `median=$${display(medianUsd)}, mean=$${display(meanUsd)}, vwap=$${display(vwapUsd)}`),
    check('ask-discount', { en: 'Ask is below the authorized price ceiling', zh: '报价低于授权价格上限' }, askUsd !== null && allowedAskUsd !== null && askUsd <= allowedAskUsd, `ask=$${display(askUsd)}, allowed=$${display(allowedAskUsd)}`),
    check('mean-consistency', { en: 'Mean deviates from median within tolerance', zh: '均价与中位价偏差可接受' }, meanDeviationPct !== null && meanDeviationPct <= Number(authorization.maxMethodDeviationPct), `${display(meanDeviationPct, 2)}% / ${authorization.maxMethodDeviationPct}%`),
    check('vwap-consistency', { en: 'VWAP deviates from median within tolerance', zh: 'VWAP 与中位价偏差可接受' }, vwapDeviationPct !== null && vwapDeviationPct <= Number(authorization.maxMethodDeviationPct), `${display(vwapDeviationPct, 2)}% / ${authorization.maxMethodDeviationPct}%`),
    check('intel-budget', { en: 'Intel fee within the per-run authorization', zh: '情报费不超过单次授权' }, intelFee !== null && maxIntelFeeUsdc !== null && intelFee <= maxIntelFeeUsdc, `${display(intelFee, 6)} / ${display(maxIntelFeeUsdc, 6)} USDC`),
    check('deposit-budget', { en: 'Deposit within the per-run authorization', zh: '订金不超过单次授权' }, depositUsdc !== null && maxDepositUsdc !== null && depositUsdc <= maxDepositUsdc, `${display(depositUsdc, 6)} / ${display(maxDepositUsdc, 6)} USDC`),
    check('daily-budget', { en: 'Cumulative daily spend within the authorization', zh: '累计日支出不超过授权' }, intelFee !== null && depositUsdc !== null && dailyBudgetUsdc !== null && spentTodayUsdc + intelFee + depositUsdc <= dailyBudgetUsdc, `${display(spentTodayUsdc + (intelFee || 0) + (depositUsdc || 0), 6)} / ${display(dailyBudgetUsdc, 6)} USDC`),
  ]

  if (quality.refreshing && authorization.requireMarketProof && !ignoreRefreshing) checks.push(warn('refreshing', { en: 'Renaiss is refreshing', zh: 'Renaiss 正在刷新' }, { en: 'Authorization requires MarketProof, so the proof must be purchased before any direct payment.', zh: '授权要求 MarketProof 时需先购买证明，不直接付款' }))
  if (authorization.requireMarketProof && !proof) checks.push(warn('proof-required', { en: 'Authorization requires a market proof', zh: '授权要求市场证明' }, { en: 'Fetch a hash-bound MarketProof via nanopayment first.', zh: '先用 nanopayment 获取带哈希的 MarketProof' }))
  if (proof) checks.push(check('proof-verified', { en: 'MarketProof verified and bound to this offer', zh: 'MarketProof 已验签且绑定本次报价' }, proofIsVerified(proof, proofVerification), proof.proofHash || 'missing'))

  const hardFails = checks.filter((item) => item.severity === 'hard' && item.status === 'fail')
  const warnings = checks.filter((item) => item.status === 'warn')
  const action = hardFails.length > 0 ? 'REJECT' : warnings.length > 0 ? 'INVESTIGATE' : 'RESERVE'

  return {
    action,
    policyVersion: 'slabscout-policy-v1.1.0',
    checkedAt: now.toISOString(),
    checks,
    hardFails,
    warnings,
    metrics: {
      askUsd: round(askUsd, 2),
      medianUsd: round(medianUsd, 2),
      allowedAskUsd: round(allowedAskUsd, 2),
      discountToMedianPct: askUsd !== null && medianUsd ? round((1 - askUsd / medianUsd) * 100, 2) : null,
      meanDeviationPct: round(meanDeviationPct, 2),
      vwapDeviationPct: round(vwapDeviationPct, 2),
      saleAgeDays: round(saleAgeDays, 1),
      plannedIntelFeeUsdc: round(intelFee, 6),
      plannedDepositUsdc: round(depositUsdc, 6),
      plannedRunSpendUsdc: round((intelFee || 0) + (depositUsdc || 0), 6),
      projectedDailySpendUsdc: round(spentTodayUsdc + (intelFee || 0) + (depositUsdc || 0), 6),
    },
    ...pair(buildExplanation(action, hardFails, warnings), 'explanation'),
  }
}

function buildExplanation(action, hardFails, warnings) {
  if (action === 'RESERVE') {
    return {
      en: 'All hard gates passed and no further investigation is needed; the agent may enter the execution branch.',
      zh: '全部硬门槛通过，且无需更多调查；代理可进入执行分支。',
    }
  }
  if (action === 'INVESTIGATE') {
    return {
      en: `Hard gates passed, but ${warnings.length} soft gate(s) remain; a MarketProof must be purchased and verified first.`,
      zh: `硬门槛通过，但存在 ${warnings.length} 个软门槛，需要先购买并验签 MarketProof。`,
    }
  }
  return {
    en: `Rejected — failed gates: ${hardFails.map((item) => item.label).join(', ')}.`,
    zh: `拒绝——未通过的门槛：${hardFails.map((item) => item.labelZh).join('、')}。`,
  }
}

async function finalizeWithProof({ signal, offer, authorization, proof, payment, runId, idempotencyKey, expectedMode, now = new Date(), isReceiptUsed, expectedPayerWallet, expectedPayeeAddress }) {
  const proofVerification = await verifyMarketProof({ proof, offer, authorization, payment, runId, idempotencyKey, expectedMode: expectedMode || signal.dataMode, now, isReceiptUsed, expectedPayerWallet, expectedPayeeAddress })
  if (!proofIsVerified(proof, proofVerification)) {
    const proofLabel = { en: 'MarketProof verified and bound to this offer', zh: 'MarketProof 已验签且绑定本次报价' }
    return {
      action: 'REJECT',
      policyVersion: 'slabscout-policy-v1.1.0',
      checkedAt: now.toISOString(),
      checks: [check('proof-verified', proofLabel, false, proof?.proofHash || 'missing')],
      hardFails: [check('proof-verified', proofLabel, false, proof?.proofHash || 'missing')],
      warnings: [],
      metrics: {},
      ...pair({
        en: 'Rejected: the MarketProof failed verification or is not bound to this offer.',
        zh: '拒绝：MarketProof 未通过验签或未绑定本次报价。',
      }, 'explanation'),
    }
  }
  return evaluateSignal({ signal, offer, authorization, now, ignoreRefreshing: true, proof, proofVerification })
}

module.exports = { evaluateSignal, finalizeWithProof, daysSince }
