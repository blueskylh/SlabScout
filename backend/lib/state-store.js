const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_STATE = Object.freeze({
  authorizations: {},
  runs: {},
  idempotency: {},
  paymentIntents: {},
  payments: {},
  proofs: {},
  reservations: {},
  budgetHolds: {},
  budgetLineItems: {},
  audit: [],
})

let memoryState = clone(DEFAULT_STATE)
let queue = Promise.resolve()

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function stateFile() {
  return process.env.SLABSCOUT_STATE_FILE || null
}

function persistenceBackend() {
  return stateFile() ? 'single-instance-file' : 'memory-replay-only'
}

function persistentStoreConfigured() {
  return Boolean(stateFile())
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
}

function stateFileWritable() {
  const file = stateFile()
  if (!file) return false
  try {
    ensureDir(file)
    const probe = `${file}.${process.pid}.probe`
    fs.writeFileSync(probe, 'ok')
    fs.rmSync(probe)
    return true
  } catch {
    return false
  }
}

function loadState() {
  const file = stateFile()
  if (!file) return clone(memoryState)
  if (!fs.existsSync(file)) return clone(DEFAULT_STATE)
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  return { ...clone(DEFAULT_STATE), ...parsed }
}

function saveState(state) {
  const file = stateFile()
  if (!file) {
    memoryState = clone(state)
    return
  }
  ensureDir(file)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
  fs.renameSync(tmp, file)
}

function withState(mutator) {
  const run = queue.then(async () => {
    const state = loadState()
    const result = await mutator(state)
    saveState(state)
    return result
  })
  queue = run.catch(() => {})
  return run
}

function sameDay(a, b = new Date()) {
  const da = new Date(a)
  if (!Number.isFinite(da.getTime())) return false
  return da.toISOString().slice(0, 10) === b.toISOString().slice(0, 10)
}

function lineItemCountsForBudget(item) {
  return item?.budgetImpact === true && ['held', 'spent', 'ambiguous', 'locked'].includes(item.status)
}

function activeDailySpend(state, owner, now = new Date()) {
  const lineItems = Object.values(state.budgetLineItems || {}).filter((item) => item.owner === owner && lineItemCountsForBudget(item) && sameDay(item.createdAt || item.updatedAt, now))
  if (lineItems.length > 0) return lineItems.reduce((sum, item) => sum + Number(item.amountUsdc || 0), 0)
  const held = Object.values(state.budgetHolds)
    .filter((hold) => hold.owner === owner && ['held', 'reconciliation-held'].includes(hold.status) && sameDay(hold.createdAt, now))
    .reduce((sum, hold) => sum + Number(hold.amountUsdc || 0), 0)
  const settledPayments = Object.values(state.payments)
    .filter((payment) => payment.owner === owner && payment.budgetImpact === true && sameDay(payment.savedAt, now))
    .reduce((sum, payment) => sum + Number(payment.amountUsdc || 0), 0)
  const settledReservations = Object.values(state.reservations)
    .filter((reservation) => reservation.owner === owner && reservation.budgetImpact === true && sameDay(reservation.savedAt, now))
    .reduce((sum, reservation) => sum + Number(reservation.amountUsdc || 0), 0)
  return held + settledPayments + settledReservations
}

function budgetLineKey(runId, operation) {
  return `${runId}:${operation}`
}

function upsertBudgetLineItemInState(state, { runId, owner, operation, amountUsdc, status = 'held', externalId = null, budgetImpact = true, meta = {} }) {
  const now = new Date().toISOString()
  const key = budgetLineKey(runId, operation)
  const existing = state.budgetLineItems[key] || {}
  state.budgetLineItems[key] = {
    ...existing,
    runId,
    owner: owner || existing.owner,
    operation,
    amountUsdc: Number(amountUsdc ?? existing.amountUsdc ?? 0),
    status,
    externalId: externalId ?? existing.externalId ?? null,
    budgetImpact,
    meta: { ...(existing.meta || {}), ...meta },
    createdAt: existing.createdAt || now,
    updatedAt: now,
  }
  return state.budgetLineItems[key]
}

async function claimIdempotency({ runId, idempotencyKey, offerId, mode }) {
  if (!idempotencyKey) return { claimed: true }
  return withState((state) => {
    const existingRunId = state.idempotency[idempotencyKey]
    if (existingRunId) {
      const existing = state.runs[existingRunId]
      if (!existing || existing.offerId !== offerId || existing.mode !== mode) {
        const error = new Error('idempotencyKey is already used for a different run scope')
        error.statusCode = 409
        throw error
      }
      return { claimed: false, existingRun: existing }
    }
    state.idempotency[idempotencyKey] = runId
    state.runs[runId] = { runId, idempotencyKey, offerId, mode, status: 'created', stages: [{ status: 'created', at: new Date().toISOString() }], startedAt: new Date().toISOString() }
    return { claimed: true }
  })
}

async function markRunStage(runId, status, extra = {}) {
  return withState((state) => {
    const run = state.runs[runId] || { runId, stages: [] }
    run.status = status
    run.stages = [...(run.stages || []), { status, at: new Date().toISOString(), ...extra }]
    state.runs[runId] = run
    return run
  })
}

async function saveAuthorizationSnapshot({ runId, owner, authorization }) {
  return withState((state) => {
    state.authorizations[runId] = { runId, owner, authorization, savedAt: new Date().toISOString() }
    return state.authorizations[runId]
  })
}

async function saveRunResult(runId, result) {
  return withState((state) => {
    const existing = state.runs[runId] || {}
    state.runs[runId] = { ...existing, runId, offerId: result.offer?.id, mode: result.mode, status: result.executionStatus, result, savedAt: new Date().toISOString() }
    return state.runs[runId]
  })
}

async function reserveBudget({ runId, owner, amountUsdc, dailyBudgetUsdc, budgetImpact = true }) {
  if (!budgetImpact || Number(amountUsdc) <= 0) return { held: false, amountUsdc: 0 }
  return withState((state) => {
    const now = new Date()
    const current = activeDailySpend(state, owner, now)
    if (current + Number(amountUsdc) > Number(dailyBudgetUsdc)) {
      const error = new Error(`Daily budget exceeded: ${current + Number(amountUsdc)} > ${dailyBudgetUsdc}`)
      error.statusCode = 409
      throw error
    }
    state.budgetHolds[runId] = { runId, owner, amountUsdc: Number(amountUsdc), status: 'held', createdAt: now.toISOString() }
    if (state.runs[runId]) state.runs[runId].status = 'budget-held'
    return { held: true, current, amountUsdc: Number(amountUsdc) }
  })
}

async function releaseBudget(runId, status = 'released') {
  return withState((state) => {
    if (state.budgetHolds[runId]) state.budgetHolds[runId].status = status
    const mapped = status === 'reconciliation-held' ? 'ambiguous' : status === 'settled' ? 'spent' : 'released'
    for (const item of Object.values(state.budgetLineItems || {}).filter((line) => line.runId === runId && line.status === 'held')) item.status = mapped
    return state.budgetHolds[runId] || null
  })
}

async function reserveBudgetLineItem({ runId, owner, operation, amountUsdc, dailyBudgetUsdc, externalId = null, budgetImpact = true, meta = {} }) {
  if (!budgetImpact || Number(amountUsdc) <= 0) return { held: false, amountUsdc: 0 }
  return withState((state) => {
    const current = activeDailySpend(state, owner, new Date())
    const existing = state.budgetLineItems[budgetLineKey(runId, operation)]
    const delta = existing && lineItemCountsForBudget(existing) ? 0 : Number(amountUsdc)
    if (current + delta > Number(dailyBudgetUsdc)) {
      const error = new Error(`Daily budget exceeded: ${current + delta} > ${dailyBudgetUsdc}`)
      error.statusCode = 409
      throw error
    }
    return upsertBudgetLineItemInState(state, { runId, owner, operation, amountUsdc, status: 'held', externalId, budgetImpact, meta })
  })
}

async function updateBudgetLineItem({ runId, operation, status, externalId = null, meta = {} }) {
  return withState((state) => {
    const key = budgetLineKey(runId, operation)
    const existing = state.budgetLineItems[key]
    if (!existing) return null
    return upsertBudgetLineItemInState(state, { ...existing, status, externalId: externalId ?? existing.externalId, meta: { ...(existing.meta || {}), ...meta } })
  })
}

async function listBudgetLineItems({ runId, owner } = {}) {
  return withState((state) => Object.values(state.budgetLineItems || {}).filter((item) => (!runId || item.runId === runId) && (!owner || item.owner === owner)))
}

function summarizeBudgetLineItems(items = []) {
  return items.reduce((summary, item) => {
    const amount = Number(item.amountUsdc || 0)
    if (item.status === 'spent') summary.spentUsdc += amount
    if (item.status === 'locked') summary.lockedDepositUsdc += amount
    if (item.status === 'held') summary.heldUsdc += amount
    if (item.status === 'ambiguous') summary.ambiguousUsdc += amount
    if (item.status === 'released') summary.releasedUsdc += amount
    if (item.operation === 'reserve' && item.status === 'spent') summary.historicalDepositSpendUsdc += amount
    if (item.operation === 'reserve' && item.status === 'locked') summary.currentLockedDepositUsdc += amount
    summary.committedUsdc = summary.spentUsdc + summary.lockedDepositUsdc + summary.heldUsdc + summary.ambiguousUsdc
    return summary
  }, { spentUsdc: 0, lockedDepositUsdc: 0, heldUsdc: 0, ambiguousUsdc: 0, releasedUsdc: 0, historicalDepositSpendUsdc: 0, currentLockedDepositUsdc: 0, committedUsdc: 0 })
}

async function budgetSummary({ runId, owner } = {}) {
  return summarizeBudgetLineItems(await listBudgetLineItems({ runId, owner }))
}

async function claimPaymentIntent({ runId, idempotencyKey, offerId, owner, amountUsdc, budgetImpact = false }) {
  return withState((state) => {
    const existingForKey = state.paymentIntents[idempotencyKey]
    if (existingForKey && existingForKey.runId !== runId) {
      const error = new Error('payment intent already exists for idempotencyKey')
      error.statusCode = 409
      throw error
    }
    if (budgetImpact) {
      const existingForOffer = Object.values(state.paymentIntents).find((intent) => intent.offerId === offerId && intent.status !== 'failed' && intent.runId !== runId)
      const paidForOffer = Object.values(state.payments).find((payment) => payment.offerId === offerId && payment.budgetImpact === true && payment.runId !== runId)
      if (existingForOffer || paidForOffer) {
        const error = new Error('offer already has a live MarketProof payment intent')
        error.statusCode = 409
        throw error
      }
    }
    state.paymentIntents[idempotencyKey] = { runId, idempotencyKey, offerId, owner, amountUsdc, status: 'payment-submitting', updatedAt: new Date().toISOString() }
    if (state.runs[runId]) state.runs[runId].status = 'payment-submitting'
    return state.paymentIntents[idempotencyKey]
  })
}

async function updatePaymentIntent(idempotencyKey, status, extra = {}) {
  return withState((state) => {
    if (state.paymentIntents[idempotencyKey]) state.paymentIntents[idempotencyKey] = { ...state.paymentIntents[idempotencyKey], status, updatedAt: new Date().toISOString(), ...extra }
    return state.paymentIntents[idempotencyKey] || null
  })
}

async function recordPayment(payment, { owner = 'demo-operator', budgetImpact = false } = {}) {
  return withState((state) => {
    if (payment.receiptId && state.payments[payment.receiptId] && state.payments[payment.receiptId].runId !== payment.runId) {
      const error = new Error('payment receipt replayed')
      error.statusCode = 409
      throw error
    }
    if (budgetImpact && Object.values(state.payments).some((row) => row.offerId === payment.offerId && row.budgetImpact === true && row.runId !== payment.runId)) {
      const error = new Error('offer already has a live MarketProof payment')
      error.statusCode = 409
      throw error
    }
    if (payment.receiptId) state.payments[payment.receiptId] = { ...payment, owner, budgetImpact, savedAt: new Date().toISOString() }
    return payment.receiptId ? state.payments[payment.receiptId] : null
  })
}

async function recordProof(proof) {
  return withState((state) => {
    state.proofs[proof.proofHash] = { ...proof, savedAt: new Date().toISOString() }
    if (proof.runId && state.runs[proof.runId]) state.runs[proof.runId].status = 'proof-verified'
    return state.proofs[proof.proofHash]
  })
}

async function recordReservation(reservation, { owner = 'demo-operator', budgetImpact = false } = {}) {
  return withState((state) => {
    if (budgetImpact && reservation.offerHash && state.reservations[reservation.offerHash] && state.reservations[reservation.offerHash].runId !== reservation.runId) {
      const error = new Error('offer already reserved')
      error.statusCode = 409
      throw error
    }
    if (reservation.offerHash) state.reservations[reservation.offerHash] = { ...reservation, owner, budgetImpact, savedAt: new Date().toISOString() }
    return reservation.offerHash ? state.reservations[reservation.offerHash] : null
  })
}

async function isReceiptUsed(receiptId, { runId, offerId } = {}) {
  return withState((state) => {
    const row = state.payments[receiptId]
    return Boolean(row && (row.runId !== runId || row.offerId !== offerId))
  })
}

async function recordAudit(row) {
  return withState((state) => {
    state.audit.unshift(row)
    state.audit = state.audit.slice(0, 500)
    return row
  })
}

function redactAudit(row) {
  return {
    auditId: row.auditId,
    savedAt: row.savedAt,
    runId: row.runId,
    offerId: row.offerId,
    policyVersion: row.policyVersion,
    action: row.action,
    executionStatus: row.executionStatus,
    proofKind: row.proofKind,
    proofHash: row.proofHash,
    escrowTxHash: row.escrowTxHash || null,
  }
}

async function listAudits({ redacted = true } = {}) {
  return withState((state) => (state.audit || []).slice(0, 500).map((row) => redacted ? redactAudit(row) : row))
}

async function getBudgetHold(runId) {
  return withState((state) => {
    if (state.budgetHolds[runId]) return state.budgetHolds[runId]
    const items = Object.values(state.budgetLineItems || {}).filter((item) => item.runId === runId)
    if (items.length === 0) return null
    const status = items.some((item) => item.status === 'ambiguous') ? 'reconciliation-held'
      : items.some((item) => item.status === 'held') ? 'held'
        : items.some((item) => ['spent', 'locked'].includes(item.status)) ? 'settled'
          : 'released'
    return { runId, owner: items[0].owner, amountUsdc: items.reduce((sum, item) => sum + Number(item.amountUsdc || 0), 0), status, lineItems: items }
  })
}

async function getRun(runId) {
  return withState((state) => state.runs[runId] || null)
}

async function getIdempotencyRunId(idempotencyKey) {
  return withState((state) => state.idempotency[idempotencyKey] || null)
}

async function getReconciliationContext(runId) {
  return withState((state) => {
    const run = state.runs[runId] || null
    const budgetHold = state.budgetHolds[runId] || null
    const paymentIntent = Object.values(state.paymentIntents).find((intent) => intent.runId === runId) || null
    const reservationEntry = Object.entries(state.reservations).find(([, reservation]) => reservation.runId === runId) || null
    const reservation = reservationEntry ? { offerHash: reservationEntry[0], ...reservationEntry[1] } : null
    const budgetLineItems = Object.values(state.budgetLineItems || {}).filter((item) => item.runId === runId)
    const unresolved = Boolean((budgetHold && budgetHold.status === 'reconciliation-held') || budgetLineItems.some((item) => item.status === 'ambiguous') || (run && run.status === 'reconciliation-required'))
    return { run, budgetHold, paymentIntent, reservation, budgetLineItems, budgetSummary: summarizeBudgetLineItems(budgetLineItems), unresolved }
  })
}

function operationFromDetails(details = {}) {
  return details.operation || details.submission?.operation || null
}

async function resolveOperationReconciliationState({ runId, operation, outcome, details = {} }) {
  return withState((state) => {
    const now = new Date().toISOString()
    const run = state.runs[runId] || null
    const budgetHold = state.budgetHolds[runId] || null
    const paymentIntentKey = Object.keys(state.paymentIntents).find((key) => state.paymentIntents[key].runId === runId)
    const reservationKey = Object.keys(state.reservations).find((key) => state.reservations[key].runId === runId)
    const budgetLine = state.budgetLineItems[budgetLineKey(runId, operation)] || null
    const unresolved = Boolean((budgetHold && budgetHold.status === 'reconciliation-held') || (budgetLine && budgetLine.status === 'ambiguous') || (run && run.status === 'reconciliation-required'))
    if (!run) {
      const error = new Error('run not found')
      error.statusCode = 404
      throw error
    }
    if (!unresolved) return { runId, operation, status: 'already_resolved', unresolved: false, outcome: run.status, resolvedAt: run.reconciliation?.resolvedAt || null }
    run.reconciliation = { ...(run.reconciliation || {}), [operation]: { outcome, details, checkedAt: now } }
    run.stages = [...(run.stages || []), { status: `reconciliation-${operation}-${outcome}`, at: now, ...details }]

    if (!['confirmed', 'ambiguous', 'reverted', 'not-submitted', 'released', 'refunded'].includes(outcome)) {
      const error = new Error('unsupported reconciliation outcome')
      error.statusCode = 400
      throw error
    }

    if (operation === 'services-pay') {
      if (paymentIntentKey && outcome !== 'ambiguous') state.paymentIntents[paymentIntentKey] = { ...state.paymentIntents[paymentIntentKey], status: `reconciled-${outcome}`, reconciliation: { outcome, details, resolvedAt: now }, updatedAt: now }
      if (budgetLine) budgetLine.status = outcome === 'confirmed' ? 'spent' : outcome === 'ambiguous' ? 'ambiguous' : 'released'
      run.status = outcome === 'confirmed' ? 'payment-confirmed' : outcome === 'ambiguous' ? 'reconciliation-required' : 'payment-not-submitted'
    } else if (operation === 'approve') {
      if (reservationKey) state.reservations[reservationKey] = { ...state.reservations[reservationKey], approveStatus: outcome, status: outcome === 'confirmed' ? 'approve-confirmed' : `approve-${outcome}`, chainConfirmed: false, reconciliation: { outcome, details, resolvedAt: now }, savedAt: now }
      run.status = outcome === 'ambiguous' ? 'reconciliation-required' : `approve-${outcome}`
    } else if (operation === 'reserve') {
      if (reservationKey) state.reservations[reservationKey] = { ...state.reservations[reservationKey], reserveStatus: outcome, status: outcome === 'confirmed' ? 'chain-confirmed' : outcome, chainConfirmed: outcome === 'confirmed', reconciliation: { outcome, details, resolvedAt: now }, savedAt: now }
      if (budgetLine) budgetLine.status = outcome === 'confirmed' ? 'spent' : outcome === 'ambiguous' ? 'ambiguous' : 'released'
      run.status = outcome === 'confirmed' ? 'chain-confirmed' : outcome === 'ambiguous' ? 'reconciliation-required' : `reserve-${outcome}`
    }

    if (budgetHold && outcome !== 'ambiguous') budgetHold.status = outcome === 'confirmed' && operation === 'reserve' ? 'settled' : 'released'
    if (budgetHold && outcome === 'ambiguous') budgetHold.status = 'reconciliation-held'
    return { runId, operation, status: outcome === 'ambiguous' ? 'still_ambiguous' : `reconciled-${operation}-${outcome}`, unresolved: outcome === 'ambiguous', outcome, resolvedAt: outcome === 'ambiguous' ? null : now, checkedAt: now }
  })
}

async function resolveReconciliationState({ runId, outcome, details = {} }) {
  return resolveOperationReconciliationState({ runId, operation: operationFromDetails(details) || 'reserve', outcome, details })
}

async function listUnresolvedReconciliations({ owner, operations } = {}) {
  return withState((state) => {
    const opSet = operations ? new Set(operations) : null
    const lineItems = Object.values(state.budgetLineItems || {})
      .filter((item) => item.status === 'ambiguous' && (!owner || item.owner === owner) && (!opSet || opSet.has(item.operation)))
      .map((item) => {
        const run = state.runs[item.runId] || {}
        return { runId: item.runId, owner: item.owner, operation: item.operation, amountUsdc: item.amountUsdc, status: 'reconciliation-held', lineStatus: item.status, externalId: item.externalId || null, createdAt: item.createdAt, runStatus: run.status || null, idempotencyKey: run.idempotencyKey || null, offerId: run.offerId || null, stage: (run.stages || []).slice(-1)[0] || null }
      })
    const holds = Object.values(state.budgetHolds)
      .filter((hold) => hold.status === 'reconciliation-held' && (!owner || hold.owner === owner))
      .filter((hold) => !lineItems.some((item) => item.runId === hold.runId))
      .map((hold) => {
        const run = state.runs[hold.runId] || {}
        const stage = (run.stages || []).slice(-1)[0] || null
        const operation = stage?.operation || null
        return { runId: hold.runId, owner: hold.owner, operation, amountUsdc: hold.amountUsdc, status: hold.status, createdAt: hold.createdAt, runStatus: run.status || null, idempotencyKey: run.idempotencyKey || null, offerId: run.offerId || null, stage }
      })
      .filter((item) => !opSet || !item.operation || opSet.has(item.operation))
    const runs = Object.values(state.runs)
      .filter((run) => run.status === 'reconciliation-required' && !holds.some((hold) => hold.runId === run.runId) && !lineItems.some((item) => item.runId === run.runId))
      .map((run) => {
        const stage = (run.stages || []).slice(-1)[0] || null
        const operation = stage?.operation || null
        return { runId: run.runId, owner: null, operation, amountUsdc: 0, status: 'reconciliation-held', createdAt: run.startedAt || run.savedAt || null, runStatus: run.status, idempotencyKey: run.idempotencyKey || null, offerId: run.offerId || null, stage }
      })
      .filter((item) => !opSet || !item.operation || opSet.has(item.operation))
    return [...lineItems, ...holds, ...runs]
  })
}

function resetStateForTests() {
  memoryState = clone(DEFAULT_STATE)
  const file = stateFile()
  if (file && fs.existsSync(file)) fs.rmSync(file)
}

module.exports = {
  persistenceBackend,
  persistentStoreConfigured,
  stateFile,
  stateFileWritable,
  claimIdempotency,
  markRunStage,
  saveAuthorizationSnapshot,
  saveRunResult,
  reserveBudget,
  releaseBudget,
  reserveBudgetLineItem,
  updateBudgetLineItem,
  listBudgetLineItems,
  budgetSummary,
  claimPaymentIntent,
  updatePaymentIntent,
  recordPayment,
  recordProof,
  recordReservation,
  isReceiptUsed,
  recordAudit,
  listAudits,
  getBudgetHold,
  getRun,
  getIdempotencyRunId,
  getReconciliationContext,
  resolveOperationReconciliationState,
  resolveReconciliationState,
  listUnresolvedReconciliations,
  resetStateForTests,
  activeDailySpend,
  summarizeBudgetLineItems,
}
