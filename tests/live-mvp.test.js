const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')

const { DEFAULT_AUTHORIZATION, DEMO_OFFERS, ARC_TESTNET_CHAIN_ID, ARC_TESTNET_USDC_ADDRESS } = require('../packages/shared')
const { replayCardDetail, replayFmvSeries, replayTrades, replayCertLookup, replayIndices } = require('../packages/shared/demo-fixtures')
const { buildPolicyProof, verifyMarketProof } = require('../packages/market-proof')
const { getReplaySignal } = require('../packages/renaiss-client')
const { evaluateSignal } = require('../packages/policy-engine')
const { resetStateForTests } = require('../backend/lib/state-store')
const { appendAudit } = require('../backend/lib/audit-log')
const { reserveEscrow } = require('../backend/lib/circle-adapters')
const { RPC_URL } = require('../backend/lib/arc-rpc')
const {
  sanitize,
  extractTxHash,
  normalizeServicesPayResult,
  CIRCLE_CLI_VERIFIED_VERSION_RANGE,
} = require('../backend/lib/circle-cli')
const marketProofRoute = require('../backend/routes/market-proof')

function withEnv(patch, fn) {
  const prev = {}
  for (const key of Object.keys(patch)) prev[key] = process.env[key]
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = String(value)
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(patch)) {
        if (prev[key] === undefined) delete process.env[key]
        else process.env[key] = prev[key]
      }
    })
}

function livePayment(runId, idempotencyKey) {
  return {
    paymentKind: 'MarketProofPayment',
    runId,
    idempotencyKey,
    offerId: DEMO_OFFERS[0].id,
    targetItemId: DEMO_OFFERS[0].targetItemId,
    targetHref: DEMO_OFFERS[0].targetHref,
    payerWallet: '0xA9E0000000000000000000000000000000000001',
    payeeService: 'circle-gateway-x402',
    payeeAddress: '0x7000000000000000000000000000000000000001',
    network: 'Arc Testnet',
    providerNetwork: `eip155:${ARC_TESTNET_CHAIN_ID}`,
    chainId: ARC_TESTNET_CHAIN_ID,
    asset: 'USDC',
    usdcAddress: ARC_TESTNET_USDC_ADDRESS,
    amountUsdc: 0.001,
    receiptId: `settlement_${runId}`,
    circlePaymentId: `settlement_${runId}`,
    txHash: `0x${'2'.repeat(64)}`,
    paidAt: new Date().toISOString(),
    providerStatus: 'settled',
    confirmed: true,
    simulated: false,
    replayAccepted: false,
  }
}

function mockRenaissFetch() {
  const prevFetch = global.fetch
  global.fetch = async (url) => {
    const href = String(url)
    let body = replayCardDetail
    if (href.includes('/v1/graded/')) body = replayCertLookup
    else if (href.includes('/fmv-series')) body = replayFmvSeries
    else if (href.includes('/trades')) body = replayTrades
    else if (href.endsWith('/v1/indices')) body = replayIndices
    return { ok: true, status: 200, text: async () => JSON.stringify(body), headers: { get: () => null }, url: href }
  }
  return () => { global.fetch = prevFetch }
}

function request(app, { path = '/api/scout/audits', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method: 'GET', headers }, (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => server.close(() => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null })))
      })
      req.on('error', (error) => server.close(() => reject(error)))
      req.end()
    })
  })
}

test.beforeEach(() => resetStateForTests())

test('P0 live UI/API source always sends live idempotencyKey and reuses pending retry key', () => {
  const api = fs.readFileSync('frontend/src/lib/api.ts', 'utf8')
  const app = fs.readFileSync('frontend/src/App.tsx', 'utf8')
  const idem = fs.readFileSync('frontend/src/lib/idempotency.ts', 'utf8')
  assert.match(api, /liveRunBody\(bodyInput\)/)
  assert.match(idem, /Live run requires an idempotencyKey/)
  assert.match(app, /pendingLiveIdempotencyKey \|\| createLiveIdempotencyKey/)
  assert.match(app, /idempotencyKey: liveKey/)
})

test('P0 circle-cli keeps txHash/proofHash while redacting private credentials', () => {
  const txHash = `0x${'a'.repeat(64)}`
  const proofHash = `0x${'b'.repeat(64)}`
  const privateKeyLabel = 'OPENSSH PRIVATE KEY'
  const privateKey = `-----BEGIN ${privateKeyLabel}-----\nabc\n-----END ${privateKeyLabel}-----`
  const out = sanitize(`Bearer secret-token ${privateKey} tx=${txHash} proof=${proofHash} rk_secretvalue123456`)
  assert.match(out, new RegExp(txHash))
  assert.match(out, new RegExp(proofHash))
  assert.doesNotMatch(out, /secret-token/)
  assert.doesNotMatch(out, new RegExp(privateKeyLabel))
  assert.doesNotMatch(out, /rk_secretvalue/)
  assert.equal(CIRCLE_CLI_VERIFIED_VERSION_RANGE, '0.0.6')
})

test('P0 circle-cli normalizes wallet execute and services pay 0.0.6 envelopes', () => {
  const txHash = `0x${'c'.repeat(64)}`
  assert.equal(extractTxHash({ data: { txHash } }), txHash)
  const seller = { payment: { receiptId: 'receipt_1' }, proof: { proofHash: `0x${'d'.repeat(64)}` } }
  const enveloped = normalizeServicesPayResult({ parsed: { success: true, data: { response: JSON.stringify(seller), payment: { receiptId: 'receipt_outer' } } } })
  assert.equal(enveloped.ok, true)
  assert.equal(enveloped.sellerResponse.proof.proofHash, seller.proof.proofHash)
  const quiet = normalizeServicesPayResult({ parsed: seller })
  assert.equal(quiet.ok, true)
  assert.equal(quiet.sellerResponse.payment.receiptId, 'receipt_1')
})

test('P0 seller endpoint requires mode live, strict authorization, and returns proof verified by the main agent auth', async () => withEnv({
  MARKET_PROOF_SIGNING_SECRET: 'live-market-proof-test-secret',
  CIRCLE_AGENT_WALLET_ADDRESS: '0xA9E0000000000000000000000000000000000001',
  MARKET_PROOF_SELLER_ADDRESS: '0x7000000000000000000000000000000000000001',
}, async () => {
  const restore = mockRenaissFetch()
  try {
    const runId = 'run_seller_flow'
    const idempotencyKey = 'idem_seller_flow'
    const body = { mode: 'live', offerId: DEMO_OFFERS[0].id, runId, idempotencyKey, authorization: { ...DEFAULT_AUTHORIZATION, maxIntelFeeUsdc: 0.5, maxDepositUsdc: 0.5, spentTodayUsdc: 999 } }
    await assert.rejects(() => marketProofRoute._internals.buildSellerProofResponse({ body: { ...body, mode: undefined }, payment: livePayment(runId, idempotencyKey) }), /mode: "live"/)
    await assert.rejects(() => marketProofRoute._internals.buildSellerProofResponse({ body: { ...body, authorization: { ...body.authorization, attacker: true } }, payment: livePayment(runId, idempotencyKey) }), /unsupported authorization fields/)
    const response = await marketProofRoute._internals.buildSellerProofResponse({ body, payment: livePayment(runId, idempotencyKey) })
    assert.equal(response.authorization.maxIntelFeeUsdc, 0.001)
    assert.equal(response.authorization.maxDepositUsdc, 0.1)
    assert.equal(response.authorization.spentTodayUsdc, 0)
    assert.equal(response.verification.ok, true)
    assert.equal((await verifyMarketProof({ proof: response.proof, offer: DEMO_OFFERS[0], authorization: response.authorization, payment: response.payment, runId, idempotencyKey, expectedMode: 'live' })).ok, true)
    assert.equal((await verifyMarketProof({ proof: response.proof, offer: DEMO_OFFERS[0], authorization: { ...response.authorization, targetCard: 'tampered' }, payment: response.payment, runId, idempotencyKey, expectedMode: 'live' })).ok, false)
  } finally {
    restore()
  }
}))

test('P0 Arc RPC default uses .network endpoint', () => {
  assert.equal(RPC_URL, 'https://rpc.testnet.arc.network')
})

test('P0 reserve receipt timeout returns reconciliation_required and preserves submitted tx metadata', async () => withEnv({
  ARC_EXECUTION_MODE: 'live',
  RESERVATION_ESCROW_ADDRESS: '0xE500000000000000000000000000000000000001',
  AGENT_WALLET_ADDRESS: '0xA9E0000000000000000000000000000000000001',
  POLICY_PROOF_SIGNING_SECRET: 'live-policy-proof-test-secret',
  SLABSCOUT_STATE_FILE: `/tmp/slabscout-live-mvp-${process.pid}-reserve-timeout.json`,
}, async () => {
  const runId = 'run_reserve_timeout'
  const idempotencyKey = 'idem_reserve_timeout'
  const signal = { ...(await getReplaySignal({ offer: DEMO_OFFERS[0], authorization: { ...DEFAULT_AUTHORIZATION, requireMarketProof: false } })), dataMode: 'live' }
  const authorization = { ...DEFAULT_AUTHORIZATION, requireMarketProof: false }
  const decision = evaluateSignal({ signal, offer: DEMO_OFFERS[0], authorization })
  const proof = buildPolicyProof({ runId, idempotencyKey, signal, offer: DEMO_OFFERS[0], authorization, decision })
  const submittedTx = `0x${'e'.repeat(64)}`
  const escrow = await reserveEscrow({
    runId,
    idempotencyKey,
    offer: DEMO_OFFERS[0],
    proof,
    authorization,
    dataMode: 'live',
    decision,
    walletExecute: async (_args) => ({ txHash: submittedTx, circleTransactionId: 'circle_tx_reserve' }),
    arcOps: {
      assertArcChain: async () => ARC_TESTNET_CHAIN_ID,
      getReservation: async () => ({ status: 0 }),
      getAllowance: async () => 100000000n,
      waitForReceipt: async () => { throw new Error('Timed out waiting for Arc receipt') },
      validateReservedEvent: () => null,
    },
  })
  assert.equal(escrow.status, 'reconciliation_required')
  assert.equal(escrow.operation, 'reserve')
  assert.equal(escrow.txHash, submittedTx)
  assert.equal(escrow.circleTransactionId, 'circle_tx_reserve')
  assert.match(escrow.externalIdempotencyKey, new RegExp(`${runId}:reserve:0x[a-f0-9]{64}`))
}))

test('P0 unauthorized audit fallback redacts full audit details', async () => withEnv({ SLABSCOUT_OPERATOR_TOKEN: 'correct' }, async () => {
  const express = require('../backend/node_modules/express')
  const scout = require('../backend/routes/scout')
  appendAudit({ runId: 'run_audit', offerId: DEMO_OFFERS[0].id, action: 'RESERVE', executionStatus: 'chain-confirmed', proofHash: `0x${'f'.repeat(64)}`, checks: [{ id: 'secret-check', details: 'full detail' }], paymentReceiptId: 'receipt_secret' })
  const app = express()
  app.use('/api/scout', scout)
  const res = await request(app)
  assert.equal(res.status, 200)
  assert.equal(res.body.redacted, true)
  assert.equal(res.body.audits[0].runId, 'run_audit')
  assert.equal(res.body.audits[0].checks, undefined)
  assert.equal(res.body.audits[0].paymentReceiptId, undefined)
}))
