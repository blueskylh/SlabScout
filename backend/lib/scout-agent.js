const crypto = require('node:crypto')
const {
  DEFAULT_AUTHORIZATION,
  DEMO_OFFERS,
  stableJson,
  round,
  MAX_MARKET_PROOF_FEE_USDC,
  MAX_ESCROW_DEPOSIT_USDC,
} = require('../../packages/shared')
const { validateAuthorization, validateOffer, validateRuntimeConfig, assertValid, pickAuthorizationFields } = require('../../packages/shared/validation')
const { getCardSignal } = require('../../packages/renaiss-client')
const { evaluateSignal, finalizeWithProof } = require('../../packages/policy-engine')
const { buildMarketProof, buildPolicyProof, verifyMarketProof, assertLiveSigningSecret } = require('../../packages/market-proof')
const { payForMarketProof, reserveEscrow, isReconciliationError, reconciliationSubmission } = require('./circle-adapters')
const { appendAudit } = require('./audit-log')
const stateStore = require('./state-store')
const { resolveEffectiveMode } = require('./mode')

function runId() {
  return `run_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`
}

function replayIdempotencyKey(body, offerId) {
  if (body.idempotencyKey) return String(body.idempotencyKey)
  return `replay_${crypto.createHash('sha256').update(stableJson({ offerId, at: Date.now(), nonce: crypto.randomBytes(4).toString('hex') })).digest('hex').slice(0, 24)}`
}

function finiteOrDefault(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function serverProofFeeCap() {
  return Math.min(Number(process.env.SLABSCOUT_MAX_PROOF_FEE_USDC || MAX_MARKET_PROOF_FEE_USDC), MAX_MARKET_PROOF_FEE_USDC)
}

function serverDepositCap() {
  return Math.min(Number(process.env.SLABSCOUT_MAX_DEPOSIT_USDC || MAX_ESCROW_DEPOSIT_USDC), MAX_ESCROW_DEPOSIT_USDC)
}

function serverDailyBudgetCap() {
  const parsed = Number(process.env.SLABSCOUT_MAX_DAILY_BUDGET_USDC || DEFAULT_AUTHORIZATION.dailyBudgetUsdc)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AUTHORIZATION.dailyBudgetUsdc
}

function mergeAuthorization(input = {}) {
  const safeInput = pickAuthorizationFields(input)
  return {
    ...DEFAULT_AUTHORIZATION,
    ...safeInput,
    spentTodayUsdc: 0,
    maxOfferUsd: finiteOrDefault(safeInput.maxOfferUsd, DEFAULT_AUTHORIZATION.maxOfferUsd),
    maxPriceVsMedianPct: finiteOrDefault(safeInput.maxPriceVsMedianPct, DEFAULT_AUTHORIZATION.maxPriceVsMedianPct),
    minSourceCount: finiteOrDefault(safeInput.minSourceCount, DEFAULT_AUTHORIZATION.minSourceCount),
    minObservationCount: finiteOrDefault(safeInput.minObservationCount, DEFAULT_AUTHORIZATION.minObservationCount),
    maxLastSaleAgeDays: finiteOrDefault(safeInput.maxLastSaleAgeDays, DEFAULT_AUTHORIZATION.maxLastSaleAgeDays),
    maxMethodDeviationPct: finiteOrDefault(safeInput.maxMethodDeviationPct, DEFAULT_AUTHORIZATION.maxMethodDeviationPct),
    maxIntelFeeUsdc: Math.min(finiteOrDefault(safeInput.maxIntelFeeUsdc, DEFAULT_AUTHORIZATION.maxIntelFeeUsdc), serverProofFeeCap()),
    maxDepositUsdc: Math.min(finiteOrDefault(safeInput.maxDepositUsdc, DEFAULT_AUTHORIZATION.maxDepositUsdc), serverDepositCap()),
    dailyBudgetUsdc: Math.min(finiteOrDefault(safeInput.dailyBudgetUsdc, DEFAULT_AUTHORIZATION.dailyBudgetUsdc), serverDailyBudgetCap()),
    requireMarketProof: safeInput.requireMarketProof ?? DEFAULT_AUTHORIZATION.requireMarketProof,
  }
}

function selectOffer(body = {}) {
  if (body.offer && typeof body.offer === 'object') {
    const error = new Error('body.offer is not accepted by the public API; submit a trusted offerId')
    error.statusCode = 400
    throw error
  }
  if (!body.offerId) {
    const error = new Error('offerId is required')
    error.statusCode = 400
    throw error
  }
  const selected = DEMO_OFFERS.find((offer) => offer.id === body.offerId)
  if (!selected) {
    const error = new Error(`Unknown offerId: ${body.offerId}`)
    error.statusCode = 400
    throw error
  }
  return { ...selected, card: { ...selected.card } }
}

function pushTimeline(timeline, stage, status, note, extra = {}) {
  timeline.push({ stage, status, note, at: new Date().toISOString(), ...extra })
}

function liveOperatorRequired(mode, operatorAuthorized) {
  if (mode === 'live' && operatorAuthorized !== true) {
    const error = new Error('Live mode requires an authorized operator token before any Renaiss, Circle, or Arc execution')
    error.statusCode = 401
    throw error
  }
}

function assertLiveStateReady(mode) {
  if (mode !== 'live') return
  if (!stateStore.persistentStoreConfigured()) {
    const error = new Error('Live mode requires SLABSCOUT_STATE_FILE before any Renaiss, Circle, or Arc execution')
    error.statusCode = 503
    throw error
  }
  if (!stateStore.stateFileWritable()) {
    const error = new Error('Live mode requires a writable SLABSCOUT_STATE_FILE before any Renaiss, Circle, or Arc execution')
    error.statusCode = 503
    throw error
  }
}

function resolveRunIdempotencyKey(body, offerId, mode) {
  if (mode === 'live' && !body.idempotencyKey) {
    const error = new Error('live mode requires an explicit idempotencyKey')
    error.statusCode = 400
    throw error
  }
  return mode === 'live' ? String(body.idempotencyKey) : replayIdempotencyKey(body, offerId)
}

function plannedRunSpend(authorization, offer) {
  const proofFee = authorization.requireMarketProof ? Number(process.env.MARKET_PROOF_PRICE_USDC || 0.001) : 0
  return round(proofFee + Number(offer.depositUsdc || 0), 6)
}

async function buildAndVerifyMarketProof({ mode, runId: id, idempotencyKey, offer, authorization, payment }) {
  const proofSignal = await getCardSignal({ mode, card: offer.card, offer, authorization })
  const proof = buildMarketProof({ signal: proofSignal, offer, authorization, payment, runId: id, idempotencyKey })
  const verification = await verifyMarketProof({ proof, offer, authorization, payment, runId: id, idempotencyKey, expectedMode: mode })
  return { proofSignal, proof: verification.proof, verification }
}

function executionStatus({ mode, signal, payment, escrow, finalDecision, authorization }) {
  if (signal?.dataMode === 'REPLAY_FALLBACK') return 'replay-fallback-blocked'
  const realExecutionConfirmed = payment?.confirmed === true && ['confirmed', 'settled'].includes(payment.providerStatus || '') && escrow?.chainConfirmed === true && Boolean(escrow?.txHash)
  if (realExecutionConfirmed) return 'chain-confirmed'
  if (mode === 'replay') return escrow ? 'replay-simulated' : finalDecision.action === 'REJECT' ? 'blocked' : 'replay-pending'
  if (authorization.requireMarketProof && payment?.status?.startsWith('live-unavailable')) return 'live-unavailable'
  if (payment?.status === 'reconciliation_required' || escrow?.status === 'reconciliation_required') return 'reconciliation-required'
  if (escrow?.status?.startsWith('live-unavailable')) return 'live-unavailable'
  return finalDecision.action === 'REJECT' ? 'blocked' : 'pending'
}

async function runScout(body = {}) {
  const id = runId()
  const timeline = []
  const mode = resolveEffectiveMode(body.mode, process.env.SLABSCOUT_DEFAULT_MODE || 'replay')
  assertValid('runtime config', validateRuntimeConfig(process.env))
  assertLiveSigningSecret(mode)
  liveOperatorRequired(mode, body.operatorAuthorized)

  const offer = selectOffer(body)
  const authorization = mergeAuthorization(body.authorization)
  const idempotencyKey = resolveRunIdempotencyKey(body, offer.id, mode)
  assertLiveStateReady(mode)
  const owner = mode === 'live' ? 'operator:live' : 'demo-operator'
  assertValid('authorization', validateAuthorization(authorization))
  assertValid('offer', validateOffer(offer))

  const claim = await stateStore.claimIdempotency({ runId: id, idempotencyKey, offerId: offer.id, mode })
  if (!claim.claimed && claim.existingRun?.result) return { ...claim.existingRun.result, idempotentReplay: true }
  if (!claim.claimed) {
    const error = new Error('idempotencyKey run is already in progress')
    error.statusCode = 409
    throw error
  }

  await stateStore.saveAuthorizationSnapshot({ runId: id, owner, authorization })
  const budgetImpact = mode === 'live'
  const held = await stateStore.reserveBudget({ runId: id, owner, amountUsdc: plannedRunSpend(authorization, offer), dailyBudgetUsdc: authorization.dailyBudgetUsdc, budgetImpact })
  await stateStore.markRunStage(id, 'budget-held')
  pushTimeline(timeline, '授权读取', 'done', '用户预算、目标卡身份和硬门槛已固定；服务端忽略客户端 spentTodayUsdc，并按 run/idempotency 约束执行。', { idempotencyKey, budgetHeldUsdc: held.amountUsdc || 0 })

  let signal
  let payment = null
  let proof = null
  let finalDecision
  let escrow = null
  let preliminary

  try {
    signal = await getCardSignal({ mode, card: offer.card, offer, authorization })
    const fallback = signal.dataMode === 'REPLAY_FALLBACK'
    pushTimeline(
      timeline,
      'Renaiss 信号',
      fallback ? 'warn' : 'done',
      signal.liveError ? `Live 调用失败，进入 REPLAY_FALLBACK；真实支付被禁止：${signal.liveError}` : `读取 ${signal.card.name || '目标卡'} ${signal.card.gradeLabel || ''} 的证书、估值、样本与趋势。`,
    )

    preliminary = evaluateSignal({ signal, offer, authorization })
    pushTimeline(timeline, '规则初判', preliminary.action === 'REJECT' ? 'blocked' : 'done', preliminary.explanation)
    finalDecision = preliminary

    if (preliminary.action === 'INVESTIGATE' && authorization.requireMarketProof === true) {
      await stateStore.claimPaymentIntent({ runId: id, idempotencyKey, offerId: offer.id, owner, amountUsdc: Number(process.env.MARKET_PROOF_PRICE_USDC || 0.001), budgetImpact })
      await stateStore.markRunStage(id, 'payment-submitting')
      payment = await payForMarketProof({ runId: id, idempotencyKey, offer, authorization, dataMode: signal.dataMode })
      pushTimeline(
        timeline,
        'Nanopayment',
        payment.verification?.ok ? 'done' : 'warn',
        payment.verification?.ok ? `MarketProof 付款凭证已通过 ${payment.verification.acceptance || 'verifier'} 校验；真实 confirmed=${payment.confirmed === true}。` : payment.note,
        { receiptId: payment.receiptId },
      )
      if (payment.status === 'reconciliation_required') {
        await stateStore.updatePaymentIntent(idempotencyKey, 'reconciliation_required', { payment })
        finalDecision = { ...preliminary, action: 'INVESTIGATE', explanation: '付款状态未知，进入 reconciliation_required，禁止自动重付。' }
      } else if (payment.verification?.ok) {
        await stateStore.recordPayment(payment, { owner, budgetImpact: mode === 'live' && payment.confirmed === true })
        await stateStore.updatePaymentIntent(idempotencyKey, 'payment-confirmed', { receiptId: payment.receiptId })
        await stateStore.markRunStage(id, 'payment-confirmed')
        if (payment.proof && mode === 'live') {
          proof = payment.proof
          const verification = await verifyMarketProof({ proof, offer, authorization, payment, runId: id, idempotencyKey, expectedMode: mode })
          proof = verification.proof
          signal = await getCardSignal({ mode, card: offer.card, offer, authorization })
          await stateStore.recordProof(proof)
          pushTimeline(timeline, 'MarketProof', verification.ok ? 'done' : 'blocked', verification.ok ? `Seller x402 endpoint returned verified MarketProof：${proof.proofHash.slice(0, 18)}…。` : `MarketProof 验证失败：${verification.errors.join('; ')}`)
          finalDecision = verification.ok
            ? await finalizeWithProof({ signal, offer, authorization, proof, payment, runId: id, idempotencyKey, expectedMode: mode })
            : { ...preliminary, action: 'REJECT', explanation: `MarketProof 验证失败：${verification.errors.join('; ')}` }
        } else {
          const built = await buildAndVerifyMarketProof({ mode, runId: id, idempotencyKey, offer, authorization, payment })
          signal = built.proofSignal
          proof = built.proof
          await stateStore.recordProof(proof)
          pushTimeline(timeline, 'MarketProof', built.verification.ok ? 'done' : 'blocked', built.verification.ok ? `付款后重新拉取数据并验签 MarketProof：${proof.proofHash.slice(0, 18)}…。` : `MarketProof 验证失败：${built.verification.errors.join('; ')}`)
          finalDecision = built.verification.ok
            ? await finalizeWithProof({ signal, offer, authorization, proof, payment, runId: id, idempotencyKey, expectedMode: mode })
            : { ...preliminary, action: 'REJECT', explanation: `MarketProof 验证失败：${built.verification.errors.join('; ')}` }
        }
        await stateStore.markRunStage(id, 'proof-verified')
        pushTimeline(timeline, '规则复判', finalDecision.action === 'RESERVE' ? 'done' : 'blocked', finalDecision.explanation)
      } else {
        await stateStore.updatePaymentIntent(idempotencyKey, 'failed', { payment })
        finalDecision = { ...preliminary, action: 'INVESTIGATE', explanation: '支付适配器未完成可信付款/模拟凭证；保持调查状态，禁止锁订金。' }
        pushTimeline(timeline, '支付保护', 'blocked', finalDecision.explanation)
      }
    }

    if (finalDecision.action === 'RESERVE') {
      if (!proof) {
        proof = buildPolicyProof({ runId: id, idempotencyKey, signal, offer, authorization, decision: finalDecision })
        await stateStore.recordProof(proof)
        pushTimeline(timeline, 'PolicyProof', 'done', `未要求付费 MarketProof；生成独立 PolicyProof ${proof.proofHash.slice(0, 18)}… 供 escrow 审计。`)
      }
      await stateStore.markRunStage(id, 'escrow-submitting')
      escrow = await reserveEscrow({ runId: id, idempotencyKey, offer, proof, authorization, dataMode: signal.dataMode, payment, decision: finalDecision })
      await stateStore.recordReservation(escrow, { owner, budgetImpact: mode === 'live' && escrow.chainConfirmed === true })
      await stateStore.markRunStage(id, escrow.chainConfirmed ? 'chain-confirmed' : escrow.status === 'reconciliation_required' ? 'reconciliation-required' : 'failed')
      pushTimeline(timeline, 'Arc 订金合约', escrow.chainConfirmed ? 'done' : 'warn', escrow.chainConfirmed ? `Arc escrow 已链上确认 ${offer.depositUsdc} USDC 订金。` : escrow.note, { txHash: escrow.txHash })
    } else if (finalDecision.action === 'REJECT') {
      await stateStore.markRunStage(id, 'failed')
      pushTimeline(timeline, '支付保护', 'blocked', '硬门槛失败，未购买 MarketProof，未锁订金。')
    }

    const needsReconciliation = payment?.status === 'reconciliation_required' || escrow?.status === 'reconciliation_required'
    if (needsReconciliation) await stateStore.releaseBudget(id, 'reconciliation-held')
    else if (finalDecision.action === 'REJECT' || !escrow?.chainConfirmed) await stateStore.releaseBudget(id)
    else await stateStore.releaseBudget(id, 'settled')

    const result = {
      runId: id,
      idempotencyKey,
      status: escrow ? escrow.status : finalDecision.action.toLowerCase(),
      executionStatus: executionStatus({ mode, signal, payment, escrow, finalDecision, authorization }),
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
      idempotencyKey,
      offerId: offer.id,
      policyVersion: finalDecision.policyVersion,
      action: finalDecision.action,
      executionStatus: result.executionStatus,
      proofHash: proof?.proofHash || null,
      proofKind: proof?.proofKind || null,
      paymentReceiptId: payment?.receiptId || null,
      escrowTxHash: escrow?.txHash || null,
      checks: finalDecision.checks,
    })
    await stateStore.recordAudit(audit)

    const finalResult = { ...result, audit }
    await stateStore.saveRunResult(id, finalResult)
    return finalResult
  } catch (error) {
    if (isReconciliationError(error)) {
      const submitted = reconciliationSubmission(error)
      await stateStore.markRunStage(id, 'reconciliation-required', { error: error.message, ...submitted })
      await stateStore.releaseBudget(id, 'reconciliation-held')
    } else {
      await stateStore.markRunStage(id, 'failed', { error: error.message })
      await stateStore.releaseBudget(id)
    }
    throw error
  }
}

module.exports = { runScout, mergeAuthorization, selectOffer, plannedRunSpend }
