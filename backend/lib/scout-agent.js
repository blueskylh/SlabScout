const crypto = require('node:crypto')
const {
  DEFAULT_AUTHORIZATION,
  DEMO_OFFERS,
  stableJson,
  round,
  MAX_MARKET_PROOF_FEE_USDC,
  MAX_ESCROW_DEPOSIT_USDC,
} = require('../packages/shared')
const { validateAuthorization, validateOffer, validateRuntimeConfig, assertValid, pickAuthorizationFields } = require('../packages/shared/validation')
const { getCardSignal } = require('../packages/renaiss-client')
const { evaluateSignal, finalizeWithProof } = require('../packages/policy-engine')
const { buildMarketProof, buildPolicyProof, verifyMarketProof, assertLiveSigningSecret } = require('../packages/market-proof')
const { payForMarketProof, reserveEscrow, isReconciliationError, reconciliationSubmission } = require('./circle-adapters')
const { appendAudit } = require('./audit-log')
const stateStore = require('./state-store')
const { resolveEffectiveMode } = require('./mode')
const { assertPaymentPreflight } = require('./live-spend-preflight')

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

// Accepts either a plain string or an { en, zh } pair; emits English as the
// primary field plus a `*Zh` sibling so the UI can switch language without
// re-running the agent.
function localized(value, key) {
  if (value && typeof value === 'object') return { [key]: value.en, [`${key}Zh`]: value.zh }
  return { [key]: value, [`${key}Zh`]: value }
}

function pushTimeline(timeline, stage, status, note, extra = {}) {
  timeline.push({ ...localized(stage, 'stage'), status, ...localized(note, 'note'), at: new Date().toISOString(), ...extra })
}

const STAGE = {
  authorization: { en: 'Authorization read', zh: '授权读取' },
  signal: { en: 'Renaiss signal', zh: 'Renaiss 信号' },
  preliminary: { en: 'Preliminary ruling', zh: '规则初判' },
  preflight: { en: 'x402 pre-payment check', zh: 'x402 付款前预检' },
  final: { en: 'Final ruling', zh: '规则复判' },
  paymentGuard: { en: 'Payment guard', zh: '支付保护' },
  escrow: { en: 'Arc escrow contract', zh: 'Arc 订金合约' },
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
  if (mode === 'live') {
    const unresolved = await stateStore.listUnresolvedReconciliations({ owner })
    if (unresolved.length > 0) {
      const error = new Error('Unresolved live reconciliation exists; reconcile Circle/Arc state before starting another live run')
      error.statusCode = 409
      error.unresolved = unresolved
      throw error
    }
  }

  const claim = await stateStore.claimIdempotency({ runId: id, idempotencyKey, offerId: offer.id, mode })
  if (!claim.claimed && claim.existingRun?.result) return { ...claim.existingRun.result, idempotentReplay: true }
  if (!claim.claimed) {
    const error = new Error('idempotencyKey run is already in progress')
    error.statusCode = 409
    throw error
  }

  await stateStore.saveAuthorizationSnapshot({ runId: id, owner, authorization })
  const budgetImpact = mode === 'live'
  await stateStore.markRunStage(id, 'authorization-fixed')
  pushTimeline(timeline, STAGE.authorization, 'done', {
    en: 'User budget, target card identity and hard gates are now fixed; the server ignores client-supplied spentTodayUsdc and enforces operation-level budget line items.',
    zh: '用户预算、目标卡身份和硬门槛已固定；服务端忽略客户端 spentTodayUsdc，并按 operation-level budget line items 执行。',
  }, { idempotencyKey, plannedSpendUsdc: plannedRunSpend(authorization, offer) })

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
      STAGE.signal,
      fallback ? 'warn' : 'done',
      signal.liveError
        ? {
          en: `Live call failed and fell back to REPLAY_FALLBACK; real payment is blocked: ${signal.liveError}`,
          zh: `Live 调用失败，进入 REPLAY_FALLBACK；真实支付被禁止：${signal.liveError}`,
        }
        : {
          en: `Read cert, valuation, samples and trend for ${signal.card.name || 'the target card'} ${signal.card.gradeLabel || ''}.`,
          zh: `读取 ${signal.card.name || '目标卡'} ${signal.card.gradeLabel || ''} 的证书、估值、样本与趋势。`,
        },
    )

    preliminary = evaluateSignal({ signal, offer, authorization })
    pushTimeline(timeline, STAGE.preliminary, preliminary.action === 'REJECT' ? 'blocked' : 'done', { en: preliminary.explanation, zh: preliminary.explanationZh })
    finalDecision = preliminary

    if (preliminary.action === 'INVESTIGATE' && authorization.requireMarketProof === true) {
      const paymentAmount = Number(process.env.MARKET_PROOF_PRICE_USDC || 0.001)
      if (mode === 'live') {
        const preflight = await assertPaymentPreflight({ authorization, owner })
        await stateStore.reserveBudgetLineItem({ runId: id, owner, operation: 'services-pay', amountUsdc: paymentAmount, dailyBudgetUsdc: authorization.dailyBudgetUsdc, budgetImpact, meta: { offerId: offer.id } })
        pushTimeline(timeline, STAGE.preflight, 'done', {
          en: `Circle testnet session, wallet list ownership, payment cap and unresolved payment checks passed; fee=${preflight.amountUsdc} USDC.`,
          zh: `Circle testnet session、wallet list ownership、payment cap 与 unresolved payment checks passed；fee=${preflight.amountUsdc} USDC。`,
        }, { checks: preflight.checks })
      }
      await stateStore.claimPaymentIntent({ runId: id, idempotencyKey, offerId: offer.id, owner, amountUsdc: paymentAmount, budgetImpact })
      await stateStore.markRunStage(id, 'payment-submitting')
      payment = await payForMarketProof({ runId: id, idempotencyKey, offer, authorization, dataMode: signal.dataMode })
      pushTimeline(
        timeline,
        'Nanopayment',
        payment.verification?.ok ? 'done' : 'warn',
        payment.verification?.ok
          ? {
            en: `MarketProof payment receipt validated by ${payment.verification.acceptance || 'verifier'}; real confirmed=${payment.confirmed === true}.`,
            zh: `MarketProof 付款凭证已通过 ${payment.verification.acceptance || 'verifier'} 校验；真实 confirmed=${payment.confirmed === true}。`,
          }
          : payment.note,
        { receiptId: payment.receiptId },
      )
      if (payment.status === 'reconciliation_required') {
        await stateStore.updateBudgetLineItem({ runId: id, operation: 'services-pay', status: 'ambiguous', externalId: payment.circlePaymentId || payment.receiptId || payment.txHash || null, meta: { paymentStatus: payment.status } })
        await stateStore.updatePaymentIntent(idempotencyKey, 'reconciliation_required', { payment })
        finalDecision = {
          ...preliminary,
          action: 'INVESTIGATE',
          explanation: 'Payment status is unknown, so the run entered reconciliation_required; automatic re-payment is blocked.',
          explanationZh: '付款状态未知，进入 reconciliation_required，禁止自动重付。',
        }
      } else if (payment.verification?.ok) {
        await stateStore.recordPayment(payment, { owner, budgetImpact: mode === 'live' && payment.confirmed === true })
        await stateStore.updateBudgetLineItem({ runId: id, operation: 'services-pay', status: mode === 'live' ? 'spent' : 'released', externalId: payment.circlePaymentId || payment.receiptId || payment.txHash || null, meta: { providerStatus: payment.providerStatus } })
        await stateStore.updatePaymentIntent(idempotencyKey, 'payment-confirmed', { receiptId: payment.receiptId })
        await stateStore.markRunStage(id, 'payment-confirmed')
        if (payment.proof && mode === 'live') {
          proof = payment.proof
          const verification = await verifyMarketProof({ proof, offer, authorization, payment, runId: id, idempotencyKey, expectedMode: mode })
          proof = verification.proof
          signal = await getCardSignal({ mode, card: offer.card, offer, authorization })
          await stateStore.recordProof(proof)
          pushTimeline(timeline, 'MarketProof', verification.ok ? 'done' : 'blocked', verification.ok
            ? {
              en: `Seller x402 endpoint returned a verified MarketProof: ${proof.proofHash.slice(0, 18)}….`,
              zh: `Seller x402 endpoint returned verified MarketProof：${proof.proofHash.slice(0, 18)}…。`,
            }
            : {
              en: `MarketProof verification failed: ${verification.errors.join('; ')}`,
              zh: `MarketProof 验证失败：${verification.errors.join('; ')}`,
            })
          finalDecision = verification.ok
            ? await finalizeWithProof({ signal, offer, authorization, proof, payment, runId: id, idempotencyKey, expectedMode: mode })
            : {
              ...preliminary,
              action: 'REJECT',
              explanation: `MarketProof verification failed: ${verification.errors.join('; ')}`,
              explanationZh: `MarketProof 验证失败：${verification.errors.join('; ')}`,
            }
        } else {
          const built = await buildAndVerifyMarketProof({ mode, runId: id, idempotencyKey, offer, authorization, payment })
          signal = built.proofSignal
          proof = built.proof
          await stateStore.recordProof(proof)
          pushTimeline(timeline, 'MarketProof', built.verification.ok ? 'done' : 'blocked', built.verification.ok
            ? {
              en: `Re-fetched data after payment and verified the MarketProof signature: ${proof.proofHash.slice(0, 18)}….`,
              zh: `付款后重新拉取数据并验签 MarketProof：${proof.proofHash.slice(0, 18)}…。`,
            }
            : {
              en: `MarketProof verification failed: ${built.verification.errors.join('; ')}`,
              zh: `MarketProof 验证失败：${built.verification.errors.join('; ')}`,
            })
          finalDecision = built.verification.ok
            ? await finalizeWithProof({ signal, offer, authorization, proof, payment, runId: id, idempotencyKey, expectedMode: mode })
            : {
              ...preliminary,
              action: 'REJECT',
              explanation: `MarketProof verification failed: ${built.verification.errors.join('; ')}`,
              explanationZh: `MarketProof 验证失败：${built.verification.errors.join('; ')}`,
            }
        }
        await stateStore.markRunStage(id, 'proof-verified')
        pushTimeline(timeline, STAGE.final, finalDecision.action === 'RESERVE' ? 'done' : 'blocked', { en: finalDecision.explanation, zh: finalDecision.explanationZh })
      } else {
        await stateStore.updateBudgetLineItem({ runId: id, operation: 'services-pay', status: 'released', meta: { paymentStatus: payment.status } })
        await stateStore.updatePaymentIntent(idempotencyKey, 'failed', { payment })
        finalDecision = {
          ...preliminary,
          action: 'INVESTIGATE',
          explanation: 'The payment adapter did not produce a trusted payment/simulated receipt; staying in investigate and blocking the deposit.',
          explanationZh: '支付适配器未完成可信付款/模拟凭证；保持调查状态，禁止锁订金。',
        }
        pushTimeline(timeline, STAGE.paymentGuard, 'blocked', { en: finalDecision.explanation, zh: finalDecision.explanationZh })
      }
    }

    if (finalDecision.action === 'RESERVE') {
      if (!proof) {
        proof = buildPolicyProof({ runId: id, idempotencyKey, signal, offer, authorization, decision: finalDecision })
        await stateStore.recordProof(proof)
        pushTimeline(timeline, 'PolicyProof', 'done', {
          en: `No paid MarketProof was required; generated a standalone PolicyProof ${proof.proofHash.slice(0, 18)}… for escrow audit.`,
          zh: `未要求付费 MarketProof；生成独立 PolicyProof ${proof.proofHash.slice(0, 18)}… 供 escrow 审计。`,
        })
      }
      if (mode === 'live') await stateStore.reserveBudgetLineItem({ runId: id, owner, operation: 'reserve', amountUsdc: Number(offer.depositUsdc || 0), dailyBudgetUsdc: authorization.dailyBudgetUsdc, budgetImpact, meta: { offerId: offer.id } })
      await stateStore.markRunStage(id, 'escrow-submitting')
      escrow = await reserveEscrow({ runId: id, idempotencyKey, offer, proof, authorization, dataMode: signal.dataMode, payment, decision: finalDecision })
      await stateStore.recordReservation(escrow, { owner, budgetImpact: mode === 'live' && escrow.chainConfirmed === true })
      const escrowOperation = escrow.operation || 'reserve'
      const reserveBudgetStatus = escrow.chainConfirmed ? 'spent' : escrow.status === 'reconciliation_required' && escrowOperation === 'reserve' ? 'ambiguous' : 'released'
      await stateStore.updateBudgetLineItem({ runId: id, operation: 'reserve', status: reserveBudgetStatus, externalId: escrowOperation === 'reserve' ? (escrow.circleTransactionId || escrow.txHash || null) : null, meta: { escrowStatus: escrow.status, operation: escrowOperation } })
      await stateStore.markRunStage(id, escrow.chainConfirmed ? 'chain-confirmed' : escrow.status === 'reconciliation_required' ? 'reconciliation-required' : 'failed', { operation: escrowOperation, offerHash: escrow.offerHash || null, txHash: escrow.txHash || null, circleTransactionId: escrow.circleTransactionId || null, externalIdempotencyKey: escrow.externalIdempotencyKey || null })
      pushTimeline(timeline, STAGE.escrow, escrow.chainConfirmed ? 'done' : 'warn', escrow.chainConfirmed
        ? {
          en: `Arc escrow confirmed a ${offer.depositUsdc} USDC deposit onchain.`,
          zh: `Arc escrow 已链上确认 ${offer.depositUsdc} USDC 订金。`,
        }
        : escrow.note, { txHash: escrow.txHash })
    } else if (finalDecision.action === 'REJECT') {
      await stateStore.markRunStage(id, 'failed')
      pushTimeline(timeline, STAGE.paymentGuard, 'blocked', {
        en: 'A hard gate failed: no MarketProof was purchased and no deposit was reserved.',
        zh: '硬门槛失败，未购买 MarketProof，未锁订金。',
      })
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
