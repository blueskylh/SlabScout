const crypto = require('node:crypto')
const { DEFAULT_AUTHORIZATION, DEMO_OFFERS } = require('../../packages/shared')
const { validateAuthorization, validateOffer, validateMode, assertValid } = require('../../packages/shared/validation')
const { getCardSignal } = require('../../packages/renaiss-client')
const { evaluateSignal, finalizeWithProof } = require('../../packages/policy-engine')
const { buildMarketProof, assertLiveSigningSecret } = require('../../packages/market-proof')
const { payForMarketProof, reserveEscrow } = require('./circle-adapters')
const { appendAudit } = require('./audit-log')

function runId() {
  return `run_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`
}

function finiteOrDefault(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function mergeAuthorization(input = {}) {
  const safeInput = input && typeof input === 'object' ? input : {}
  return {
    ...DEFAULT_AUTHORIZATION,
    ...safeInput,
    maxOfferUsd: finiteOrDefault(safeInput.maxOfferUsd, DEFAULT_AUTHORIZATION.maxOfferUsd),
    maxPriceVsMedianPct: finiteOrDefault(safeInput.maxPriceVsMedianPct, DEFAULT_AUTHORIZATION.maxPriceVsMedianPct),
    minSourceCount: finiteOrDefault(safeInput.minSourceCount, DEFAULT_AUTHORIZATION.minSourceCount),
    minObservationCount: finiteOrDefault(safeInput.minObservationCount, DEFAULT_AUTHORIZATION.minObservationCount),
    maxLastSaleAgeDays: finiteOrDefault(safeInput.maxLastSaleAgeDays, DEFAULT_AUTHORIZATION.maxLastSaleAgeDays),
    maxMethodDeviationPct: finiteOrDefault(safeInput.maxMethodDeviationPct, DEFAULT_AUTHORIZATION.maxMethodDeviationPct),
    maxIntelFeeUsdc: finiteOrDefault(safeInput.maxIntelFeeUsdc, DEFAULT_AUTHORIZATION.maxIntelFeeUsdc),
    maxDepositUsdc: finiteOrDefault(safeInput.maxDepositUsdc, DEFAULT_AUTHORIZATION.maxDepositUsdc),
    dailyBudgetUsdc: finiteOrDefault(safeInput.dailyBudgetUsdc, DEFAULT_AUTHORIZATION.dailyBudgetUsdc),
    spentTodayUsdc: finiteOrDefault(safeInput.spentTodayUsdc, DEFAULT_AUTHORIZATION.spentTodayUsdc),
    requireMarketProof: safeInput.requireMarketProof ?? DEFAULT_AUTHORIZATION.requireMarketProof,
  }
}

function selectOffer(body = {}) {
  const candidate = body.offer && typeof body.offer === 'object' ? body.offer : null
  if (candidate?.id && Number.isFinite(Number(candidate.askUsd)) && Number.isFinite(Number(candidate.depositUsdc))) return candidate
  const requested = body.offerId || DEMO_OFFERS[0].id
  return DEMO_OFFERS.find((offer) => offer.id === requested) || DEMO_OFFERS[0]
}

function pushTimeline(timeline, stage, status, note, extra = {}) {
  timeline.push({ stage, status, note, at: new Date().toISOString(), ...extra })
}

async function runScout(body = {}) {
  const id = runId()
  const timeline = []
  const mode = body.mode || process.env.SLABSCOUT_DEFAULT_MODE || 'replay'
  assertValid('mode', validateMode(mode))
  assertLiveSigningSecret(mode)
  const offer = selectOffer(body)
  const authorization = mergeAuthorization(body.authorization)
  if (!offer.targetCard) offer.targetCard = authorization.targetCard
  assertValid('authorization', validateAuthorization(authorization))
  assertValid('offer', validateOffer(offer))

  pushTimeline(timeline, '授权读取', 'done', '用户预算和硬门槛已固定，后续花钱只能由规则引擎触发。')

  const signal = await getCardSignal({ mode, card: offer.card, offer })
  pushTimeline(
    timeline,
    'Renaiss 信号',
    signal.dataMode.includes('fallback') ? 'warn' : 'done',
    signal.liveError ? `Live 调用失败，已切换 replay：${signal.liveError}` : `读取 ${signal.card.name} ${signal.card.gradeLabel} 的估值、样本与趋势。`,
  )

  const preliminary = evaluateSignal({ signal, offer, authorization })
  pushTimeline(timeline, '规则初判', preliminary.action === 'REJECT' ? 'blocked' : 'done', preliminary.explanation)

  let payment = null
  let proof = null
  let finalDecision = preliminary
  let escrow = null

  if (preliminary.action === 'INVESTIGATE') {
    payment = await payForMarketProof({ runId: id, offer, authorization, dataMode: signal.dataMode })
    pushTimeline(
      timeline,
      'Nanopayment',
      payment.confirmed ? 'done' : 'warn',
      payment.confirmed ? `MarketProof 付款已确认：${payment.amountUsdc} USDC。` : payment.note,
      { receiptId: payment.receiptId },
    )
    if (payment.confirmed) {
      proof = buildMarketProof({ signal, offer, authorization, payment })
      pushTimeline(timeline, 'MarketProof', 'done', `证明哈希 ${proof.proofHash.slice(0, 18)}… 已生成，listing 行已排除。`)
      finalDecision = finalizeWithProof({ signal, offer, authorization, proof })
      pushTimeline(timeline, '规则复判', finalDecision.action === 'RESERVE' ? 'done' : 'blocked', finalDecision.explanation)
    } else {
      finalDecision = { ...preliminary, action: 'INVESTIGATE', explanation: '支付适配器未完成真实付款；保持调查状态，禁止锁订金。' }
      pushTimeline(timeline, '支付保护', 'blocked', finalDecision.explanation)
    }
  }

  if (finalDecision.action === 'RESERVE') {
    if (!proof && authorization.requireMarketProof) {
      payment = await payForMarketProof({ runId: id, offer, authorization, dataMode: signal.dataMode })
      if (!payment.confirmed) {
        finalDecision = { ...finalDecision, action: 'INVESTIGATE', explanation: '支付适配器未完成真实付款；保持调查状态，禁止锁订金。' }
        pushTimeline(timeline, '支付保护', 'blocked', finalDecision.explanation, { receiptId: payment.receiptId })
      } else {
        proof = buildMarketProof({ signal, offer, authorization, payment })
        finalDecision = finalizeWithProof({ signal, offer, authorization, proof })
      }
    }
    if (!proof && finalDecision.action === 'RESERVE') {
      proof = buildMarketProof({ signal, offer, authorization, payment: null })
      pushTimeline(timeline, 'PolicyProof', 'done', `未要求付费证明；生成本地决策哈希 ${proof.proofHash.slice(0, 18)}… 供 escrow 审计。`)
    }
    if (finalDecision.action === 'RESERVE') {
      escrow = await reserveEscrow({ runId: id, offer, proof, authorization, dataMode: signal.dataMode })
      pushTimeline(
        timeline,
        'Arc 订金合约',
        escrow.chainConfirmed ? 'done' : 'warn',
        escrow.chainConfirmed ? `Arc escrow 已确认 ${offer.depositUsdc} USDC 订金。` : escrow.note,
        { txHash: escrow.txHash },
      )
    }
  } else if (finalDecision.action === 'REJECT') {
    pushTimeline(timeline, '支付保护', 'blocked', '硬门槛失败，未购买 MarketProof，未锁订金。')
  }

  const result = {
    runId: id,
    status: escrow ? escrow.status : finalDecision.action.toLowerCase(),
    mode,
    authorization,
    offer,
    signal,
    preliminary,
    payment,
    proof,
    finalDecision,
    escrow,
    timeline,
  }

  const audit = appendAudit({
    runId: id,
    offerId: offer.id,
    policyVersion: finalDecision.policyVersion,
    action: finalDecision.action,
    proofHash: proof?.proofHash || null,
    paymentReceiptId: payment?.receiptId || null,
    escrowTxHash: escrow?.txHash || null,
    checks: finalDecision.checks,
  })

  return { ...result, audit }
}

module.exports = {
  runScout,
  mergeAuthorization,
}
