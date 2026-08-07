const fs = require('node:fs')
const path = require('node:path')

const DAY_MS = 86_400_000
const DEFAULT_STATE = Object.freeze({
  authorizations: {},
  runs: {},
  idempotency: {},
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

function persistentStoreConfigured() {
  return Boolean(stateFile() || process.env.DATABASE_URL)
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
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
    .filter((hold) => hold.owner === owner && hold.status === 'held' && sameDay(hold.createdAt, now))
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
    state.runs[runId] = { runId, idempotencyKey, offerId, mode, status: 'started', startedAt: new Date().toISOString() }
    return { claimed: true }
  })
}

async function saveRunResult(runId, result) {
  return withState((state) => {
    state.runs[runId] = { ...(state.runs[runId] || {}), runId, offerId: result.offer?.id, mode: result.mode, status: result.status, result, savedAt: new Date().toISOString() }
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
    return { held: true, current, amountUsdc: Number(amountUsdc) }
  })
}

async function releaseBudget(runId, status = 'released') {
  return withState((state) => {
    if (state.budgetHolds[runId]) state.budgetHolds[runId].status = status
    return state.budgetHolds[runId] || null
  })
}

async function recordPayment(payment, { owner = 'demo-operator', budgetImpact = false } = {}) {
  return withState((state) => {
    if (payment.receiptId && state.payments[payment.receiptId] && state.payments[payment.receiptId].runId !== payment.runId) {
      const error = new Error('payment receipt replayed')
      error.statusCode = 409
      throw error
    }
    if (budgetImpact && Object.values(state.payments).some((row) => row.offerId === payment.offerId && row.budgetImpact === true)) {
      const error = new Error('offer already has a live MarketProof payment')
      error.statusCode = 409
      throw error
    }
    if (payment.receiptId) {
      state.payments[payment.receiptId] = { ...payment, owner, budgetImpact, savedAt: new Date().toISOString() }
    }
    return payment.receiptId ? state.payments[payment.receiptId] : null
  })
}

async function recordProof(proof) {
  return withState((state) => {
    state.proofs[proof.proofHash] = { ...proof, savedAt: new Date().toISOString() }
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

function resetStateForTests() {
  memoryState = clone(DEFAULT_STATE)
  const file = stateFile()
  if (file && fs.existsSync(file)) fs.rmSync(file)
}

module.exports = {
  persistentStoreConfigured,
  claimIdempotency,
  saveRunResult,
  reserveBudget,
  releaseBudget,
  recordPayment,
  recordProof,
  recordReservation,
  isReceiptUsed,
  resetStateForTests,
  activeDailySpend,
}
