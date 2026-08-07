const crypto = require('node:crypto')
const { DEFAULT_AUTHORIZATION, DEMO_OFFERS } = require('../../packages/shared')
const { getCardSignal } = require('../../packages/renaiss-client')
const { evaluateSignal, finalizeWithProof } = require('../../packages/policy-engine')
const { buildMarketProof } = require('../../packages/market-proof')
const { payForMarketProof, reserveEscrow } = require('./circle-adapters')
const { appendAudit } = require('./audit-log')

function runId() {
  return `run_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`
}

function mergeAuthorization(input = {}) {
  return {
    ...DEFAULT_AUTHORIZATION,
    ...input,
    maxOfferUsd: Number(input.maxOfferUsd ?? DEFAULT_AUTHORIZATION.maxOfferUsd),
    maxPriceVsMedianPct: Number(input.maxPriceVsMedianPct ?? DEFAULT_AUTHORIZATION.maxPriceVsMedianPct),
    minSourceCount: Number(input.minSourceCount ?? DEFAULT_AUTHORIZATION.minSourceCount),
    minObservationCount: Number(input.minObservationCount ?? DEFAULT_AUTHORIZATION.minObservationCount),
    maxLastSaleAgeDays: Number(input.maxLastSaleAgeDays ?? DEFAULT_AUTHORIZATION.maxLastSaleAgeDays),
    maxMethodDeviationPct: Number(input.maxMethodDeviationPct ?? DEFAULT_AUTHORIZATION.maxMethodDeviationPct),
    maxIntelFeeUsdc: Number(input.maxIntelFeeUsdc ?? DEFAULT_AUTHORIZATION.maxIntelFeeUsdc),
    maxDepositUsdc: Number(input.maxDepositUsdc ?? DEFAULT_AUTHORIZATION.maxDepositUsdc),
    dailyBudgetUsdc: Number(input.dailyBudgetUsdc ?? DEFAULT_AUTHORIZATION.dailyBudgetUsdc),
    spentTodayUsdc: Number(input.spentTodayUsdc ?? DEFAULT_AUTHORIZATION.spentTodayUsdc),
    requireMarketProof: input.requireMarketProof ?? DEFAULT_AUTHORIZATION.requireMarketProof,
  }
}

function selectOffer(body = {}) {
  if (body.offer) return body.offer
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
  const offer = selectOffer(body)
  const authorization = mergeAuthorization(body.authorization)

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
    payment = await payForMarketProof({ runId: id, offer, authorization })
    pushTimeline(
      timeline,
      'Nanopayment',
      payment.status === 'paid' ? 'done' : 'warn',
      payment.status === 'paid' ? `代理支付 ${payment.amountUsdc} USDC 获取 MarketProof。` : payment.note,
      { receiptId: payment.receiptId },
    )
    if (payment.status === 'paid') {
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
      payment = await payForMarketProof({ runId: id, offer, authorization })
      proof = buildMarketProof({ signal, offer, authorization, payment })
      finalDecision = finalizeWithProof({ signal, offer, authorization, proof })
    }
    if (!proof && finalDecision.action === 'RESERVE') {
      proof = buildMarketProof({ signal, offer, authorization, payment: null })
      pushTimeline(timeline, 'PolicyProof', 'done', `未要求付费证明；生成本地决策哈希 ${proof.proofHash.slice(0, 18)}… 供 escrow 审计。`)
    }
    if (finalDecision.action === 'RESERVE') {
      escrow = await reserveEscrow({ runId: id, offer, proof, authorization })
      pushTimeline(
        timeline,
        'Arc 订金合约',
        escrow.status === 'reserved' ? 'done' : 'warn',
        escrow.status === 'reserved' ? `锁定 ${offer.depositUsdc} USDC 订金。` : escrow.note,
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
