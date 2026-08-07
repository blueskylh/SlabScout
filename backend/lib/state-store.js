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

function activeDailySpend(state, owner, now = new Date()) {
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
    return state.budgetHolds[runId] || null
  })
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
  return withState((state) => state.budgetHolds[runId] || null)
}

async function listUnresolvedReconciliations({ owner } = {}) {
  return withState((state) => {
    const holds = Object.values(state.budgetHolds)
      .filter((hold) => hold.status === 'reconciliation-held' && (!owner || hold.owner === owner))
      .map((hold) => {
        const run = state.runs[hold.runId] || {}
        return { runId: hold.runId, owner: hold.owner, amountUsdc: hold.amountUsdc, status: hold.status, createdAt: hold.createdAt, runStatus: run.status || null, idempotencyKey: run.idempotencyKey || null, offerId: run.offerId || null, stage: (run.stages || []).slice(-1)[0] || null }
      })
    const runs = Object.values(state.runs)
      .filter((run) => run.status === 'reconciliation-required' && !holds.some((hold) => hold.runId === run.runId))
      .map((run) => ({ runId: run.runId, owner: null, amountUsdc: 0, status: 'reconciliation-held', createdAt: run.startedAt || run.savedAt || null, runStatus: run.status, idempotencyKey: run.idempotencyKey || null, offerId: run.offerId || null, stage: (run.stages || []).slice(-1)[0] || null }))
    return [...holds, ...runs]
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
  claimPaymentIntent,
  updatePaymentIntent,
  recordPayment,
  recordProof,
  recordReservation,
  isReceiptUsed,
  recordAudit,
  listAudits,
  getBudgetHold,
  listUnresolvedReconciliations,
  resetStateForTests,
  activeDailySpend,
}
