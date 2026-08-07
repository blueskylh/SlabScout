const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')

const { DEFAULT_AUTHORIZATION, DEMO_OFFERS, ARC_TESTNET_CHAIN_ID, ARC_TESTNET_USDC_ADDRESS } = require('../packages/shared')
const { replayCardDetail, replayFmvSeries, replayTrades, replayCertLookup, replayIndices } = require('../packages/shared/demo-fixtures')
const { buildPolicyProof, verifyMarketProof } = require('../packages/market-proof')
const { getReplaySignal } = require('../packages/renaiss-client')
const { evaluateSignal } = require('../packages/policy-engine')
const { resetStateForTests, getBudgetHold } = require('../backend/lib/state-store')
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

function request(app, { path = '/api/scout/audits', method = 'GET', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const payload = body ? JSON.stringify(body) : ''
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers } }, (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => server.close(() => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null })))
      })
      req.on('error', (error) => server.close(() => reject(error)))
      if (payload) req.write(payload)
      req.end()
    })
  })
}

function proofBody(overrides = {}) {
  return {
    mode: 'live',
    offerId: DEMO_OFFERS[0].id,
    runId: 'run_x402_preflight',
    idempotencyKey: 'idem_x402_preflight',
    authorization: DEFAULT_AUTHORIZATION,
    ...overrides,
  }
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
  assert.match(app, /reconciliationActive/)
  assert.match(app, /Manual reconciliation required/)
  assert.match(app, /mode === 'live' && !reconciliation\) setPendingLiveIdempotencyKey\(null\)/)
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
  const cliSource = fs.readFileSync('backend/lib/circle-cli.js', 'utf8')
  const servicesPaySource = cliSource.match(/async function circleServicesPay[\s\S]*?async function circleWalletExecute/)?.[0] || ''
  assert.doesNotMatch(servicesPaySource, /--idempotency-key/)
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

test('P0 unknown offerId and bad authorization fail before x402 gateway', async () => withEnv({ MARKET_PROOF_SELLER_ADDRESS: '0x7000000000000000000000000000000000000001' }, async () => {
  const express = require('../backend/node_modules/express')
  let gatewayCalls = 0
  const app = express()
  app.use(express.json())
  app.use('/api/market-proof', marketProofRoute.createProofRouter({ gatewayMiddlewareFactory: () => (_req, _res, next) => { gatewayCalls += 1; next() } }))
  const unknown = await request(app, { path: '/api/market-proof/prove', method: 'POST', body: proofBody({ offerId: 'unknown-offer' }) })
  assert.equal(unknown.status, 400)
  assert.equal(gatewayCalls, 0)
  const badAuth = await request(app, { path: '/api/market-proof/prove', method: 'POST', body: proofBody({ authorization: { ...DEFAULT_AUTHORIZATION, maxIntelFeeUsdc: -1 } }) })
  assert.equal(badAuth.status, 400)
  assert.equal(gatewayCalls, 0)
}))


test('P0 x402 preflight rejects identity mismatch, expired offer, bad signing, missing Renaiss, and bad price before gateway', async () => {
  const express = require('../backend/node_modules/express')
  async function postWithEnv(body, env, offers = undefined) {
    return withEnv(env, async () => {
      let gatewayCalls = 0
      const app = express()
      app.use(express.json())
      app.use('/api/market-proof', marketProofRoute.createProofRouter({ offers, gatewayMiddlewareFactory: () => (_req, _res, next) => { gatewayCalls += 1; next() } }))
      const res = await request(app, { path: '/api/market-proof/prove', method: 'POST', body })
      return { ...res, gatewayCalls }
    })
  }
  const validEnv = { MARKET_PROOF_SIGNING_SECRET: 'live-market-proof-test-secret', RENAISS_API_KEY: 'test-key', RENAISS_API_SECRET: 'test-secret', MARKET_PROOF_SELLER_ADDRESS: '0x7000000000000000000000000000000000000001', MARKET_PROOF_PRICE_USDC: '0.001' }
  const mismatch = await postWithEnv(proofBody({ authorization: { ...DEFAULT_AUTHORIZATION, certNumber: '00000000' } }), validEnv)
  assert.equal(mismatch.status, 400)
  assert.equal(mismatch.gatewayCalls, 0)
  const expiredOffer = { ...DEMO_OFFERS[0], expiresAt: '2020-01-01T00:00:00.000Z' }
  const expired = await postWithEnv(proofBody(), validEnv, [expiredOffer])
  assert.equal(expired.status, 400)
  assert.equal(expired.gatewayCalls, 0)
  const missingSecret = await postWithEnv(proofBody(), { ...validEnv, MARKET_PROOF_SIGNING_SECRET: undefined })
  assert.equal(missingSecret.status, 503)
  assert.equal(missingSecret.gatewayCalls, 0)
  const missingRenaiss = await postWithEnv(proofBody(), { ...validEnv, RENAISS_API_KEY: undefined })
  assert.equal(missingRenaiss.status, 503)
  assert.equal(missingRenaiss.gatewayCalls, 0)
  const invalidPrice = await postWithEnv(proofBody(), { ...validEnv, MARKET_PROOF_PRICE_USDC: '-1' })
  assert.equal(invalidPrice.status, 400)
  assert.equal(invalidPrice.gatewayCalls, 0)
  const overCap = await postWithEnv(proofBody(), { ...validEnv, MARKET_PROOF_PRICE_USDC: '0.002' })
  assert.equal(overCap.status, 400)
  assert.equal(overCap.gatewayCalls, 0)
})

test('P0 legal x402 request keeps identical capped authorization before and after gateway', async () => withEnv({
  MARKET_PROOF_SIGNING_SECRET: 'live-market-proof-test-secret',
  RENAISS_API_KEY: 'rk_test',
  RENAISS_API_SECRET: 'rsk_test',
  CIRCLE_AGENT_WALLET_ADDRESS: '0xA9E0000000000000000000000000000000000001',
  MARKET_PROOF_SELLER_ADDRESS: '0x7000000000000000000000000000000000000001',
}, async () => {
  const restore = mockRenaissFetch()
  try {
    const express = require('../backend/node_modules/express')
    let gatewayCalls = 0
    let preGatewayAuth = null
    const app = express()
    app.use(express.json())
    app.use('/api/market-proof', marketProofRoute.createProofRouter({ gatewayMiddlewareFactory: () => (req, _res, next) => {
      gatewayCalls += 1
      preGatewayAuth = JSON.stringify(req.validatedProofRequest.authorization)
      req.payment = { verified: true, payer: '0xA9E0000000000000000000000000000000000001', amount: '1000', network: `eip155:${ARC_TESTNET_CHAIN_ID}`, transaction: `0x${'8'.repeat(64)}` }
      next()
    } }))
    const body = proofBody({ authorization: { ...DEFAULT_AUTHORIZATION, maxIntelFeeUsdc: 0.5, maxDepositUsdc: 0.5, spentTodayUsdc: 999 } })
    const result = await request(app, { path: '/api/market-proof/prove', method: 'POST', body })
    assert.equal(result.status, 200)
    assert.equal(gatewayCalls, 1)
    assert.equal(JSON.stringify(result.body.authorization), preGatewayAuth)
    assert.equal(result.body.authorization.maxIntelFeeUsdc, 0.001)
    assert.equal(result.body.authorization.maxDepositUsdc, 0.1)
    assert.equal(result.body.authorization.spentTodayUsdc, 0)
  } finally {
    restore()
  }
}))

test('P0 seller endpoint requires mode live, strict authorization, and returns proof verified by the main agent auth', async () => withEnv({
  MARKET_PROOF_SIGNING_SECRET: 'live-market-proof-test-secret',
  RENAISS_API_KEY: 'rk_test',
  RENAISS_API_SECRET: 'rsk_test',
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

test('P0 live readiness is operator-protected and read-only injectable', async () => withEnv({
  SLABSCOUT_OPERATOR_TOKEN: 'op',
  SLABSCOUT_STATE_FILE: `/tmp/slabscout-live-mvp-${process.pid}-readiness.json`,
  CIRCLE_AGENT_WALLET_ADDRESS: '0xA9E0000000000000000000000000000000000001',
  RESERVATION_ESCROW_ADDRESS: '0xE500000000000000000000000000000000000001',
}, async () => {
  const status = require('../backend/routes/status')
  const readiness = await status._internals.collectLiveReadiness({
    circle: {
      circleCliVersion: async () => ({ version: '0.0.6', supported: true }),
      circleWalletStatus: async () => ({ ok: true, normalized: { ok: true, data: { authenticated: true } } }),
      circleGatewayBalance: async () => ({ ok: true, normalized: { ok: true, data: { total: 1 } } }),
    },
    arc: {
      RPC_URL,
      assertArcChain: async () => ARC_TESTNET_CHAIN_ID,
      getCode: async () => '0x60016001',
    },
  })
  assert.equal(readiness.readinessLevel, 'read-only-live-check')
  assert.equal(readiness.ok, true)
  assert.ok(readiness.checks.some((check) => check.label === 'escrow-bytecode'))
}))


test('P0 live readiness HTTP requires operator token and returns 200 for read-only checks', async () => withEnv({
  SLABSCOUT_OPERATOR_TOKEN: 'op',
  SLABSCOUT_STATE_FILE: `/tmp/slabscout-live-mvp-${process.pid}-readiness-http.json`,
  CIRCLE_AGENT_WALLET_ADDRESS: '0xA9E0000000000000000000000000000000000001',
  RESERVATION_ESCROW_ADDRESS: '0xE500000000000000000000000000000000000001',
}, async () => {
  const express = require('../backend/node_modules/express')
  const status = require('../backend/routes/status')
  const app = express()
  app.use('/api/status', status.createStatusRouter({
    circle: {
      circleCliVersion: async () => ({ version: '0.0.6', supported: true }),
      circleWalletStatus: async () => ({ normalized: { ok: true, data: { authenticated: true } } }),
      circleGatewayBalance: async () => ({ normalized: { ok: true, data: { total: 1 } } }),
    },
    arc: { RPC_URL, assertArcChain: async () => ARC_TESTNET_CHAIN_ID, getCode: async () => '0x60016001' },
  }))
  assert.equal((await request(app, { path: '/api/status/live-readiness' })).status, 401)
  assert.equal((await request(app, { path: '/api/status/live-readiness', headers: { 'x-slabscout-operator-token': 'bad' } })).status, 403)
  const ok = await request(app, { path: '/api/status/live-readiness', headers: { 'x-slabscout-operator-token': 'op' } })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.ok, true)
}))

test('P0 live readiness is false for CLI ok=false, empty/zero balance, and wrong CLI version', async () => withEnv({
  SLABSCOUT_OPERATOR_TOKEN: 'op',
  SLABSCOUT_STATE_FILE: `/tmp/slabscout-live-mvp-${process.pid}-readiness-false.json`,
  CIRCLE_AGENT_WALLET_ADDRESS: '0xA9E0000000000000000000000000000000000001',
  RESERVATION_ESCROW_ADDRESS: '0xE500000000000000000000000000000000000001',
}, async () => {
  const status = require('../backend/routes/status')
  async function readiness({ version = { version: '0.0.6', supported: true }, wallet = { normalized: { ok: true, data: { authenticated: true } } }, balance = { normalized: { ok: true, data: { total: 1 } } } }) {
    return status._internals.collectLiveReadiness({
      circle: {
        circleCliVersion: async () => version,
        circleWalletStatus: async () => wallet,
        circleGatewayBalance: async () => balance,
      },
      arc: { RPC_URL, assertArcChain: async () => ARC_TESTNET_CHAIN_ID, getCode: async () => '0x60016001' },
    })
  }
  assert.equal((await readiness({ wallet: { normalized: { ok: false, data: { authenticated: true } } } })).ok, false)
  assert.equal((await readiness({ balance: { normalized: { ok: true, data: {} } } })).ok, false)
  assert.equal((await readiness({ balance: { normalized: { ok: true, data: { total: 0 } } } })).ok, false)
  assert.equal((await readiness({ version: { version: '0.0.5', supported: false } })).ok, false)
}))

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


test('P0 reserve returns reconciliation_required when walletExecute returns only circleTransactionId', async () => withEnv({
  ARC_EXECUTION_MODE: 'live',
  RESERVATION_ESCROW_ADDRESS: '0xE500000000000000000000000000000000000001',
  AGENT_WALLET_ADDRESS: '0xA9E0000000000000000000000000000000000001',
  POLICY_PROOF_SIGNING_SECRET: 'live-policy-proof-test-secret',
  SLABSCOUT_STATE_FILE: `/tmp/slabscout-live-mvp-${process.pid}-reserve-circle-id.json`,
}, async () => {
  const runId = 'run_reserve_circle_id'
  const idempotencyKey = 'idem_reserve_circle_id'
  const authorization = { ...DEFAULT_AUTHORIZATION, requireMarketProof: false }
  const signal = { ...(await getReplaySignal({ offer: DEMO_OFFERS[0], authorization })), dataMode: 'live' }
  const decision = evaluateSignal({ signal, offer: DEMO_OFFERS[0], authorization })
  const proof = buildPolicyProof({ runId, idempotencyKey, signal, offer: DEMO_OFFERS[0], authorization, decision })
  const escrow = await reserveEscrow({
    runId,
    idempotencyKey,
    offer: DEMO_OFFERS[0],
    proof,
    authorization,
    dataMode: 'live',
    decision,
    walletExecute: async () => ({ circleTransactionId: 'circle_tx_only' }),
    arcOps: {
      assertArcChain: async () => ARC_TESTNET_CHAIN_ID,
      getReservation: async () => ({ status: 0 }),
      getAllowance: async () => 100000000n,
      waitForReceipt: async () => { throw new Error('should not wait without txHash') },
      validateReservedEvent: () => null,
    },
  })
  assert.equal(escrow.status, 'reconciliation_required')
  assert.equal(escrow.circleTransactionId, 'circle_tx_only')
  assert.equal(escrow.txHash, null)
}))

test('P0 non-timeout wallet error with circleTransactionId returns reconciliation_required', async () => withEnv({
  ARC_EXECUTION_MODE: 'live',
  RESERVATION_ESCROW_ADDRESS: '0xE500000000000000000000000000000000000001',
  AGENT_WALLET_ADDRESS: '0xA9E0000000000000000000000000000000000001',
  POLICY_PROOF_SIGNING_SECRET: 'live-policy-proof-test-secret',
  SLABSCOUT_STATE_FILE: `/tmp/slabscout-live-mvp-${process.pid}-reserve-error-circle-id.json`,
}, async () => {
  const runId = 'run_reserve_error_circle_id'
  const idempotencyKey = 'idem_reserve_error_circle_id'
  const authorization = { ...DEFAULT_AUTHORIZATION, requireMarketProof: false }
  const signal = { ...(await getReplaySignal({ offer: DEMO_OFFERS[0], authorization })), dataMode: 'live' }
  const decision = evaluateSignal({ signal, offer: DEMO_OFFERS[0], authorization })
  const proof = buildPolicyProof({ runId, idempotencyKey, signal, offer: DEMO_OFFERS[0], authorization, decision })
  const escrow = await reserveEscrow({
    runId,
    idempotencyKey,
    offer: DEMO_OFFERS[0],
    proof,
    authorization,
    dataMode: 'live',
    decision,
    walletExecute: async () => { const error = new Error('submitted but post-submit query failed'); error.circleTransactionId = 'circle_tx_error'; throw error },
    arcOps: {
      assertArcChain: async () => ARC_TESTNET_CHAIN_ID,
      getReservation: async () => ({ status: 0 }),
      getAllowance: async () => 100000000n,
      waitForReceipt: async () => { throw new Error('should not be reached') },
      validateReservedEvent: () => null,
    },
  })
  assert.equal(escrow.status, 'reconciliation_required')
  assert.equal(escrow.circleTransactionId, 'circle_tx_error')
}))

async function runScoutWithSubmittedReserveError(errorFactory, stateSuffix) {
  const scoutPath = require.resolve('../backend/lib/scout-agent')
  const adapterPath = require.resolve('../backend/lib/circle-adapters')
  delete require.cache[scoutPath]
  const adapters = require('../backend/lib/circle-adapters')
  const originalReserve = adapters.reserveEscrow
  let capturedRunId = null
  adapters.reserveEscrow = async ({ runId }) => {
    capturedRunId = runId
    throw errorFactory(runId)
  }
  const restoreFetch = mockRenaissFetch()
  try {
    const { runScout } = require('../backend/lib/scout-agent')
    await withEnv({
      MARKET_PROOF_SIGNING_SECRET: 'live-market-proof-test-secret',
      POLICY_PROOF_SIGNING_SECRET: 'live-policy-proof-test-secret',
      SLABSCOUT_STATE_FILE: `/tmp/slabscout-${process.pid}-${stateSuffix}.json`,
      SLABSCOUT_OPERATOR_TOKEN: 'op',
    }, async () => {
      await assert.rejects(() => runScout({ mode: 'live', offerId: DEMO_OFFERS[0].id, idempotencyKey: `idem_${stateSuffix}`, authorization: { ...DEFAULT_AUTHORIZATION, requireMarketProof: false }, operatorAuthorized: true }), /submitted/)
      const hold = await getBudgetHold(capturedRunId)
      assert.equal(hold.status, 'reconciliation-held')
    })
  } finally {
    restoreFetch()
    adapters.reserveEscrow = originalReserve
    delete require.cache[scoutPath]
  }
}

test('P0 runScout keeps budget reconciliation-held for submitted circleTransactionId without txHash', async () => {
  await runScoutWithSubmittedReserveError((runId) => {
    const error = new Error(`submitted reserve ${runId}`)
    error.circleTransactionId = 'circle_submitted_only'
    error.operation = 'reserve'
    error.operationSubmitted = true
    return error
  }, 'budget-circle-id')
})

test('P0 runScout keeps budget reconciliation-held for non-timeout submitted metadata error', async () => {
  await runScoutWithSubmittedReserveError((runId) => {
    const error = new Error(`submitted reserve ${runId}`)
    error.submission = { operationSubmitted: true, operation: 'reserve', circleTransactionId: 'circle_submitted_metadata', offerHash: `0x${'9'.repeat(64)}`, externalIdempotencyKey: `${runId}:reserve:0x${'9'.repeat(64)}` }
    return error
  }, 'budget-submission-metadata')
})


test('P0 unresolved reconciliation blocks new live runs before external calls', async () => withEnv({
  MARKET_PROOF_SIGNING_SECRET: 'live-market-proof-test-secret',
  SLABSCOUT_OPERATOR_TOKEN: 'op',
  SLABSCOUT_STATE_FILE: `/tmp/slabscout-live-mvp-${process.pid}-block-unresolved.json`,
}, async () => {
  const stateStore = require('../backend/lib/state-store')
  await stateStore.claimIdempotency({ runId: 'run_unresolved_old', idempotencyKey: 'idem_unresolved_old', offerId: DEMO_OFFERS[0].id, mode: 'live' })
  await stateStore.reserveBudget({ runId: 'run_unresolved_old', owner: 'operator:live', amountUsdc: 0.1, dailyBudgetUsdc: 1, budgetImpact: true })
  await stateStore.releaseBudget('run_unresolved_old', 'reconciliation-held')
  const prevFetch = global.fetch
  let called = false
  global.fetch = async () => { called = true; throw new Error('should not call external') }
  try {
    const { runScout } = require('../backend/lib/scout-agent')
    await assert.rejects(() => runScout({ mode: 'live', offerId: DEMO_OFFERS[0].id, idempotencyKey: 'idem_new_blocked', authorization: DEFAULT_AUTHORIZATION, operatorAuthorized: true }), /Unresolved live reconciliation/)
    assert.equal(called, false)
  } finally {
    global.fetch = prevFetch
  }
}))

test('P0 reconciliation list is operator protected and returns unresolved state', async () => withEnv({
  SLABSCOUT_OPERATOR_TOKEN: 'op',
  SLABSCOUT_STATE_FILE: `/tmp/slabscout-live-mvp-${process.pid}-recon-list.json`,
}, async () => {
  const express = require('../backend/node_modules/express')
  const scout = require('../backend/routes/scout')
  const stateStore = require('../backend/lib/state-store')
  await stateStore.claimIdempotency({ runId: 'run_recon_list', idempotencyKey: 'idem_recon_list', offerId: DEMO_OFFERS[0].id, mode: 'live' })
  await stateStore.reserveBudget({ runId: 'run_recon_list', owner: 'operator:live', amountUsdc: 0.1, dailyBudgetUsdc: 1, budgetImpact: true })
  await stateStore.releaseBudget('run_recon_list', 'reconciliation-held')
  const app = express()
  app.use('/api/scout', scout)
  assert.equal((await request(app, { path: '/api/scout/reconciliations' })).status, 401)
  assert.equal((await request(app, { path: '/api/scout/reconciliations', headers: { 'x-slabscout-operator-token': 'bad' } })).status, 403)
  const ok = await request(app, { path: '/api/scout/reconciliations', headers: { 'x-slabscout-operator-token': 'op' } })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.count, 1)
  assert.equal(ok.body.unresolved[0].runId, 'run_recon_list')
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
