const crypto = require('node:crypto')
const { DEFAULT_AUTHORIZATION, DEMO_OFFERS, stableJson, round } = require('../../packages/shared')
const { validateAuthorization, validateOffer, validateMode, validateRuntimeConfig, assertValid } = require('../../packages/shared/validation')
const { getCardSignal } = require('../../packages/renaiss-client')
const { evaluateSignal, finalizeWithProof } = require('../../packages/policy-engine')
const { buildMarketProof, buildPolicyProof, verifyMarketProof, assertLiveSigningSecret } = require('../../packages/market-proof')
const { payForMarketProof, reserveEscrow } = require('./circle-adapters')
const { appendAudit } = require('./audit-log')
const stateStore = require('./state-store')

function runId() {
  return `run_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`
}

function deterministicIdempotencyKey(body, offerId) {
  if (body.idempotencyKey) return String(body.idempotencyKey)
  return `auto_${crypto.createHash('sha256').update(stableJson({ offerId, mode: body.mode || 'replay', at: Date.now(), nonce: crypto.randomBytes(4).toString('hex') })).digest('hex').slice(0, 24)}`
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
    spentTodayUsdc: 0,
    maxOfferUsd: finiteOrDefault(safeInput.maxOfferUsd, DEFAULT_AUTHORIZATION.maxOfferUsd),
    maxPriceVsMedianPct: finiteOrDefault(safeInput.maxPriceVsMedianPct, DEFAULT_AUTHORIZATION.maxPriceVsMedianPct),
    minSourceCount: finiteOrDefault(safeInput.minSourceCount, DEFAULT_AUTHORIZATION.minSourceCount),
    minObservationCount: finiteOrDefault(safeInput.minObservationCount, DEFAULT_AUTHORIZATION.minObservationCount),
    maxLastSaleAgeDays: finiteOrDefault(safeInput.maxLastSaleAgeDays, DEFAULT_AUTHORIZATION.maxLastSaleAgeDays),
    maxMethodDeviationPct: finiteOrDefault(safeInput.maxMethodDeviationPct, DEFAULT_AUTHORIZATION.maxMethodDeviationPct),
    maxIntelFeeUsdc: finiteOrDefault(safeInput.maxIntelFeeUsdc, DEFAULT_AUTHORIZATION.maxIntelFeeUsdc),
    maxDepositUsdc: finiteOrDefault(safeInput.maxDepositUsdc, DEFAULT_AUTHORIZATION.maxDepositUsdc),
    dailyBudgetUsdc: finiteOrDefault(safeInput.dailyBudgetUsdc, DEFAULT_AUTHORIZATION.dailyBudgetUsdc),
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

function plannedRunSpend(authorization, offer) {
  const proofFee = authorization.requireMarketProof ? Number(process.env.MARKET_PROOF_PRICE_USDC || 0.001) : 0
  return round(proofFee + Number(offer.depositUsdc || 0), 6)
}

async function buildAndVerifyMarketProof({ mode, runId: id, idempotencyKey, offer, authorization, payment }) {
  const proofSignal = await getCardSignal({ mode, card: offer.card, offer, authorization })
  const proof = buildMarketProof({ signal: proofSignal, offer, authorization, payment, runId: id, idempotencyKey })
  const verification = verifyMarketProof({ proof, offer, authorization, payment, runId: id, idempotencyKey, expectedMode: mode })
  return { proofSignal, proof: verification.proof, verification }
}

function executionStatus({ mode, signal, payment, escrow, finalDecision, authorization }) {
  if (signal?.dataMode === 'REPLAY_FALLBACK') return 'replay-fallback-blocked'
  const realExecutionConfirmed = payment?.confirmed === true && payment?.providerStatus && ['confirmed', 'settled'].includes(payment.providerStatus) && escrow?.chainConfirmed === true && Boolean(escrow?.txHash)
  if (realExecutionConfirmed) return 'chain-confirmed'
  if (mode === 'replay') return escrow ? 'replay-simulated' : finalDecision.action === 'REJECT' ? 'blocked' : 'replay-pending'
  if (authorization.requireMarketProof && payment?.status?.startsWith('live-unavailable')) return 'live-unavailable'
  if (escrow?.status?.startsWith('live-unavailable')) return 'live-unavailable'
  return finalDecision.action === 'REJECT' ? 'blocked' : 'pending'
}

async function runScout(body = {}) {
  const id = runId()
  const timeline = []
  const mode = body.mode || process.env.SLABSCOUT_DEFAULT_MODE || 'replay'
  assertValid('mode', validateMode(mode))
  assertValid('runtime config', validateRuntimeConfig(process.env))
  assertLiveSigningSecret(mode)
  liveOperatorRequired(mode, body.operatorAuthorized)

  const offer = selectOffer(body)
  const authorization = mergeAuthorization(body.authorization)
  const idempotencyKey = deterministicIdempotencyKey(body, offer.id)
  const owner = authorization.owner || 'demo-operator'
  assertValid('authorization', validateAuthorization(authorization))
  assertValid('offer', validateOffer(offer))

  const claim = await stateStore.claimIdempotency({ runId: id, idempotencyKey, offerId: offer.id, mode })
  if (!claim.claimed && claim.existingRun?.result) return { ...claim.existingRun.result, idempotentReplay: true }
  if (!claim.claimed) {
    const error = new Error('idempotencyKey run is already in progress')
    error.statusCode = 409
    throw error
  }

  const budgetImpact = mode === 'live'
  const held = await stateStore.reserveBudget({ runId: id, owner, amountUsdc: plannedRunSpend(authorization, offer), dailyBudgetUsdc: authorization.dailyBudgetUsdc, budgetImpact })
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
      payment = await payForMarketProof({ runId: id, idempotencyKey, offer, authorization, dataMode: signal.dataMode })
      pushTimeline(
        timeline,
        'Nanopayment',
        payment.verification?.ok ? 'done' : 'warn',
        payment.verification?.ok ? `MarketProof 付款凭证已通过 ${payment.verification.acceptance || payment.verification?.acceptance || '本地'} 校验；真实 confirmed=${payment.confirmed === true}。` : payment.note,
        { receiptId: payment.receiptId },
      )
      if (payment.verification?.ok) {
        await stateStore.recordPayment(payment, { owner, budgetImpact: mode === 'live' && payment.confirmed === true })
        const built = await buildAndVerifyMarketProof({ mode, runId: id, idempotencyKey, offer, authorization, payment })
        signal = built.proofSignal
        proof = built.proof
        await stateStore.recordProof(proof)
        pushTimeline(
          timeline,
          'MarketProof',
          built.verification.ok ? 'done' : 'blocked',
          built.verification.ok ? `付款后重新拉取数据并验签 MarketProof：${proof.proofHash.slice(0, 18)}…。` : `MarketProof 验证失败：${built.verification.errors.join('; ')}`,
        )
        finalDecision = built.verification.ok
          ? finalizeWithProof({ signal, offer, authorization, proof, proofVerification: built.verification })
          : { ...preliminary, action: 'REJECT', explanation: `MarketProof 验证失败：${built.verification.errors.join('; ')}` }
        pushTimeline(timeline, '规则复判', finalDecision.action === 'RESERVE' ? 'done' : 'blocked', finalDecision.explanation)
      } else {
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
      escrow = await reserveEscrow({ runId: id, idempotencyKey, offer, proof, authorization, dataMode: signal.dataMode, payment, decision: finalDecision })
      await stateStore.recordReservation(escrow, { owner, budgetImpact: mode === 'live' && escrow.chainConfirmed === true })
      pushTimeline(
        timeline,
        'Arc 订金合约',
        escrow.chainConfirmed ? 'done' : 'warn',
        escrow.chainConfirmed ? `Arc escrow 已链上确认 ${offer.depositUsdc} USDC 订金。` : escrow.note,
        { txHash: escrow.txHash },
      )
    } else if (finalDecision.action === 'REJECT') {
      pushTimeline(timeline, '支付保护', 'blocked', '硬门槛失败，未购买 MarketProof，未锁订金。')
    }

    if (finalDecision.action === 'REJECT' || !escrow?.chainConfirmed) await stateStore.releaseBudget(id)
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

    const finalResult = { ...result, audit }
    await stateStore.saveRunResult(id, finalResult)
    return finalResult
  } catch (error) {
    await stateStore.releaseBudget(id)
    throw error
  }
}

module.exports = { runScout, mergeAuthorization, selectOffer, plannedRunSpend }
