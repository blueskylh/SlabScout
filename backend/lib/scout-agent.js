const crypto = require('node:crypto')
const { DEFAULT_AUTHORIZATION, DEMO_OFFERS, stableJson } = require('../../packages/shared')
const { validateAuthorization, validateOffer, validateMode, validateRuntimeConfig, assertValid } = require('../../packages/shared/validation')
const { getCardSignal } = require('../../packages/renaiss-client')
const { evaluateSignal, finalizeWithProof } = require('../../packages/policy-engine')
const { buildMarketProof, verifyMarketProof, assertLiveSigningSecret } = require('../../packages/market-proof')
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
  if (body.offer && typeof body.offer === 'object') return { ...body.offer }
  if (!body.offerId) throw new Error('offerId is required')
  const selected = DEMO_OFFERS.find((offer) => offer.id === body.offerId)
  if (!selected) throw new Error(`Unknown offerId: ${body.offerId}`)
  return { ...selected, card: { ...selected.card } }
}

function pushTimeline(timeline, stage, status, note, extra = {}) {
  timeline.push({ stage, status, note, at: new Date().toISOString(), ...extra })
}

function buildPolicyProof({ signal, offer, authorization }) {
  const payload = {
    proofVersion: 'policy-decision-proof-v1.0.0',
    generatedAt: new Date().toISOString(),
    targetItemId: authorization.targetItemId || offer.targetItemId,
    targetHref: authorization.targetHref || offer.targetHref,
    cardId: signal.card?.id || null,
    offerId: offer.id,
    askUsd: offer.askUsd,
    certNumber: offer.certNumber,
    sourceUpdatedAt: signal.sourceUpdatedAt || signal.dataAsOf,
    dataMode: signal.dataMode,
  }
  const canonical = stableJson(payload)
  const proofHash = `0x${crypto.createHash('sha256').update(canonical).digest('hex')}`
  return { ...payload, proofHash, canonicalBytes: Buffer.byteLength(canonical, 'utf8'), verified: true, verification: { ok: true, localPolicyProof: true } }
}

async function buildAndVerifyMarketProof({ mode, signal, offer, authorization, payment }) {
  const proofSignal = await getCardSignal({ mode, card: offer.card, offer, authorization })
  const proof = buildMarketProof({ signal: proofSignal, offer, authorization, payment })
  const verification = verifyMarketProof({ proof, offer, authorization, payment })
  return { proofSignal, proof: verification.proof, verification }
}

async function runScout(body = {}) {
  const id = runId()
  const timeline = []
  const mode = body.mode || process.env.SLABSCOUT_DEFAULT_MODE || 'replay'
  assertValid('mode', validateMode(mode))
  assertValid('runtime config', validateRuntimeConfig(process.env))
  assertLiveSigningSecret(mode)
  const offer = selectOffer(body)
  const authorization = mergeAuthorization(body.authorization)
  assertValid('authorization', validateAuthorization(authorization))
  assertValid('offer', validateOffer(offer))

  pushTimeline(timeline, '授权读取', 'done', '用户预算、目标卡身份和硬门槛已固定；后续花钱只能由规则引擎触发。')

  let signal = await getCardSignal({ mode, card: offer.card, offer, authorization })
  const fallback = signal.dataMode === 'REPLAY_FALLBACK'
  pushTimeline(
    timeline,
    'Renaiss 信号',
    fallback ? 'warn' : 'done',
    signal.liveError ? `Live 调用失败，进入 REPLAY_FALLBACK；真实支付被禁止：${signal.liveError}` : `读取 ${signal.card.name || '目标卡'} ${signal.card.gradeLabel || ''} 的证书、估值、样本与趋势。`,
  )

  const preliminary = evaluateSignal({ signal, offer, authorization })
  pushTimeline(timeline, '规则初判', preliminary.action === 'REJECT' ? 'blocked' : 'done', preliminary.explanation)

  let payment = null
  let proof = null
  let finalDecision = preliminary
  let escrow = null

  if (preliminary.action === 'INVESTIGATE' && authorization.requireMarketProof === true) {
    payment = await payForMarketProof({ runId: id, offer, authorization, dataMode: signal.dataMode })
    pushTimeline(
      timeline,
      'Nanopayment',
      payment.confirmed ? 'done' : 'warn',
      payment.confirmed ? `MarketProof 付款已确认：${payment.amountUsdc} USDC。` : payment.note,
      { receiptId: payment.receiptId },
    )
    if (payment.confirmed) {
      const built = await buildAndVerifyMarketProof({ mode, signal, offer, authorization, payment })
      signal = built.proofSignal
      proof = built.proof
      pushTimeline(
        timeline,
        'MarketProof',
        built.verification.ok ? 'done' : 'blocked',
        built.verification.ok ? `付款后重新拉取数据并验签 MarketProof：${proof.proofHash.slice(0, 18)}…。` : `MarketProof 验证失败：${built.verification.errors.join('; ')}`,
      )
      finalDecision = built.verification.ok
        ? finalizeWithProof({ signal, offer, authorization, proof })
        : { ...preliminary, action: 'REJECT', explanation: `MarketProof 验证失败：${built.verification.errors.join('; ')}` }
      pushTimeline(timeline, '规则复判', finalDecision.action === 'RESERVE' ? 'done' : 'blocked', finalDecision.explanation)
    } else {
      finalDecision = { ...preliminary, action: 'INVESTIGATE', explanation: '支付适配器未完成真实付款；保持调查状态，禁止锁订金。' }
      pushTimeline(timeline, '支付保护', 'blocked', finalDecision.explanation)
    }
  }

  if (finalDecision.action === 'RESERVE') {
    if (!proof) {
      proof = buildPolicyProof({ signal, offer, authorization })
      pushTimeline(timeline, 'PolicyProof', 'done', `未要求付费 MarketProof；生成本地决策哈希 ${proof.proofHash.slice(0, 18)}… 供 escrow 审计。`)
    }
    escrow = await reserveEscrow({ runId: id, offer, proof, authorization, dataMode: signal.dataMode })
    pushTimeline(
      timeline,
      'Arc 订金合约',
      escrow.chainConfirmed ? 'done' : 'warn',
      escrow.chainConfirmed ? `Arc escrow 已确认 ${offer.depositUsdc} USDC 订金。` : escrow.note,
      { txHash: escrow.txHash },
    )
  } else if (finalDecision.action === 'REJECT') {
    pushTimeline(timeline, '支付保护', 'blocked', '硬门槛失败，未购买 MarketProof，未锁订金。')
  }

  const realExecutionConfirmed = payment?.status === 'live-payment-confirmed' && escrow?.chainConfirmed === true && Boolean(escrow?.txHash)
  const executionStatus = realExecutionConfirmed
    ? 'success'
    : escrow?.status === 'replay-escrow-confirmed'
      ? 'replay-confirmed-not-live'
      : escrow?.chainConfirmed && !authorization.requireMarketProof
        ? 'policy-reserved-not-live'
        : finalDecision.action === 'REJECT'
          ? 'blocked'
          : 'pending'

  const result = {
    runId: id,
    status: escrow ? escrow.status : finalDecision.action.toLowerCase(),
    executionStatus,
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

module.exports = { runScout, mergeAuthorization, selectOffer }
