const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')

const { DEFAULT_AUTHORIZATION, DEMO_OFFERS, ARC_TESTNET_CHAIN_ID, ARC_TESTNET_USDC_ADDRESS } = require('../packages/shared')
const { replayCardDetail, replayFmvSeries, replayTrades, replayCertLookup, replayIndices } = require('../packages/shared/demo-fixtures')
const { buildPolicyProof, verifyMarketProof } = require('../packages/market-proof')
const { getReplaySignal } = require('../packages/renaiss-client')
const { evaluateSignal } = require('../packages/policy-engine')
const { resetStateForTests, getBudgetHold, getIdempotencyRunId, getReconciliationContext } = require('../backend/lib/state-store')
const { appendAudit } = require('../backend/lib/audit-log')
const { reserveEscrow } = require('../backend/lib/circle-adapters')
const { RPC_URL } = require('../backend/lib/arc-rpc')
const {
  sanitize,
  extractTxHash,
  normalizeServicesPayResult,
  normalizeWalletStatus,
  circleTestnetSessionOk,
  circleWalletControlsAddress,
  CIRCLE_CLI_VERIFIED_VERSION_RANGE,
} = require('../backend/lib/circle-cli')
const marketProofRoute = require('../backend/routes/market-proof')
const { assertLiveSpendPreflight, deterministicOfferHash, amountMinorUsdc } = require('../backend/lib/live-spend-preflight')
const { resolveReconciliation } = require('../backend/lib/reconciliation')

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

const TEST_AGENT_WALLET = '0xA9E0000000000000000000000000000000000001'
const TEST_ESCROW = '0xE500000000000000000000000000000000000001'
const TEST_SELLER = '0x7000000000000000000000000000000000000001'

function circleStatusFixture({ testnetTokenStatus = 'VALID', mainnetTokenStatus = 'VALID', walletAddress = TEST_AGENT_WALLET, paymasterStatus = 'AVAILABLE' } = {}) {
  return {
    success: true,
    data: {
      mainnet: { tokenStatus: mainnetTokenStatus, walletAddress: '0x1111111111111111111111111111111111111111' },
      testnet: { tokenStatus: testnetTokenStatus, walletAddress, paymasterStatus },
    },
  }
}

function normalizedCircleStatus(options = {}) {
  const parsed = circleStatusFixture(options)
  return { ok: true, parsed, normalized: normalizeWalletStatus(parsed) }
}

function healthyLiveEnv(suffix = 'healthy') {
  return {
    SLABSCOUT_OPERATOR_TOKEN: 'op',
    SLABSCOUT_STATE_FILE: `/tmp/slabscout-live-mvp-${process.pid}-${suffix}.json`,
    SLABSCOUT_DEFAULT_MODE: 'replay',
    CIRCLE_MODE: 'live',
    ARC_EXECUTION_MODE: 'live',
    RENAISS_API_KEY: 'test-key',
    RENAISS_API_SECRET: 'test-secret',
    MARKET_PROOF_SIGNING_SECRET: 'live-market-proof-test-secret',
    POLICY_PROOF_SIGNING_SECRET: 'live-policy-proof-test-secret',
    CIRCLE_AGENT_WALLET_ADDRESS: TEST_AGENT_WALLET,
    AGENT_WALLET_ADDRESS: TEST_AGENT_WALLET,
    MARKET_PROOF_SERVICE_URL: 'https://marketproof.example.test/prove',
    MARKET_PROOF_SELLER_ADDRESS: TEST_SELLER,
    RESERVATION_ESCROW_ADDRESS: TEST_ESCROW,
    SELLER_WALLET_ADDRESS: TEST_SELLER,
    ARC_CHAIN_ID: String(ARC_TESTNET_CHAIN_ID),
    ARC_USDC_ADDRESS: ARC_TESTNET_USDC_ADDRESS,
    MARKET_PROOF_PRICE_USDC: '0.001',
  }
}

function healthyPreflightArc(overrides = {}) {
  return {
    RPC_URL,
    assertArcChain: async () => ARC_TESTNET_CHAIN_ID,
    getCode: async () => '0x60016001',
    getEscrowUsdc: async () => ARC_TESTNET_USDC_ADDRESS,
    getEscrowMaxReservationAmount: async () => 1000000n,
    getReservation: async () => ({ status: 0 }),
    getTokenBalance: async () => 1000000n,
    getNativeBalance: async () => 0n,
    ...overrides,
  }
}

function healthyPreflightCircle(options = {}) {
  return { circleWalletStatus: async () => normalizedCircleStatus(options) }
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

test('P0 circle-cli normalizes wallet execute, services pay, and real 0.0.6 status envelopes', () => {
  const txHash = `0x${'c'.repeat(64)}`
  assert.equal(extractTxHash({ data: { txHash } }), txHash)
  const seller = { payment: { receiptId: 'receipt_1' }, proof: { proofHash: `0x${'d'.repeat(64)}` } }
  const enveloped = normalizeServicesPayResult({ parsed: { success: true, data: { response: JSON.stringify(seller), payment: { receiptId: 'receipt_outer' } } } })
  assert.equal(enveloped.ok, true)
  assert.equal(enveloped.sellerResponse.proof.proofHash, seller.proof.proofHash)
  const quiet = normalizeServicesPayResult({ parsed: seller })
  assert.equal(quiet.ok, true)
  assert.equal(quiet.sellerResponse.payment.receiptId, 'receipt_1')

  const valid = { parsed: circleStatusFixture() }
  valid.normalized = normalizeWalletStatus(valid.parsed)
  assert.equal(valid.normalized.data.testnet.tokenStatus, 'VALID')
  assert.equal(circleTestnetSessionOk(valid), true)
  assert.equal(circleWalletControlsAddress(valid, TEST_AGENT_WALLET), true)
  const expired = { parsed: circleStatusFixture({ testnetTokenStatus: 'EXPIRED' }) }
  expired.normalized = normalizeWalletStatus(expired.parsed)
  assert.equal(circleTestnetSessionOk(expired), false)
  const notLoggedIn = { parsed: circleStatusFixture({ testnetTokenStatus: 'NOT_LOGGED_IN' }) }
  notLoggedIn.normalized = normalizeWalletStatus(notLoggedIn.parsed)
  assert.equal(circleTestnetSessionOk(notLoggedIn), false)
  const mainnetOnly = { parsed: circleStatusFixture({ mainnetTokenStatus: 'VALID', testnetTokenStatus: 'NOT_LOGGED_IN' }) }
  mainnetOnly.normalized = normalizeWalletStatus(mainnetOnly.parsed)
  assert.equal(circleTestnetSessionOk(mainnetOnly), false)
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

test('P0 live readiness is operator-protected and read-only injectable', async () => withEnv(healthyLiveEnv('readiness'), async () => {
  const status = require('../backend/routes/status')
  const readiness = await status._internals.collectLiveReadiness({
    circle: {
      circleCliVersion: async () => ({ version: '0.0.6', supported: true }),
      circleWalletStatus: async () => normalizedCircleStatus(),
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


test('P0 live readiness HTTP requires operator token and returns 200 for read-only checks', async () => withEnv(healthyLiveEnv('readiness-http'), async () => {
  const express = require('../backend/node_modules/express')
  const status = require('../backend/routes/status')
  const app = express()
  app.use('/api/status', status.createStatusRouter({
    circle: {
      circleCliVersion: async () => ({ version: '0.0.6', supported: true }),
      circleWalletStatus: async () => normalizedCircleStatus(),
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

test('P0 live readiness is false for CLI ok=false, empty/zero balance, and wrong CLI version', async () => withEnv(healthyLiveEnv('readiness-false'), async () => {
  const status = require('../backend/routes/status')
  async function readiness({ version = { version: '0.0.6', supported: true }, wallet = normalizedCircleStatus(), balance = { normalized: { ok: true, data: { total: 1 } } } }) {
    return status._internals.collectLiveReadiness({
      circle: {
        circleCliVersion: async () => version,
        circleWalletStatus: async () => wallet,
        circleGatewayBalance: async () => balance,
      },
      arc: { RPC_URL, assertArcChain: async () => ARC_TESTNET_CHAIN_ID, getCode: async () => '0x60016001' },
    })
  }
  assert.equal((await readiness({ wallet: { normalized: { ok: false, data: { testnet: { tokenStatus: 'EXPIRED' } } } } })).ok, false)
  assert.equal((await readiness({ balance: { normalized: { ok: true, data: {} } } })).ok, false)
  assert.equal((await readiness({ balance: { normalized: { ok: true, data: { total: 0 } } } })).ok, false)
  assert.equal((await readiness({ version: { version: '0.0.5', supported: false } })).ok, false)
}))


test('P0 readiness is false when live config is missing even if read-only externals are healthy', async () => withEnv({ ...healthyLiveEnv('readiness-config-missing'), MARKET_PROOF_SIGNING_SECRET: undefined }, async () => {
  const status = require('../backend/routes/status')
  const readiness = await status._internals.collectLiveReadiness({
    circle: { circleCliVersion: async () => ({ version: '0.0.6', supported: true }), circleWalletStatus: async () => normalizedCircleStatus(), circleGatewayBalance: async () => ({ normalized: { ok: true, data: { total: 1 } } }) },
    arc: { RPC_URL, assertArcChain: async () => ARC_TESTNET_CHAIN_ID, getCode: async () => '0x60016001' },
  })
  const config = readiness.checks.find((check) => check.label === 'live-config')
  assert.equal(readiness.ok, false)
  assert.equal(config.ok, false)
  assert.ok(config.value.liveMissing.includes('MARKET_PROOF_SIGNING_SECRET(non-default)'))
}))

test('P0 readiness is false and liveMissing is exact when payment or escrow mode is not live', async () => withEnv({ ...healthyLiveEnv('readiness-modes'), CIRCLE_MODE: 'mock', ARC_EXECUTION_MODE: 'mock' }, async () => {
  const status = require('../backend/routes/status')
  const summary = status._internals.liveConfigSummary()
  assert.equal(summary.liveConfigComplete, false)
  assert.ok(summary.liveMissing.includes('CIRCLE_MODE=live'))
  assert.ok(summary.liveMissing.includes('ARC_EXECUTION_MODE=live'))
  const readiness = await status._internals.collectLiveReadiness({
    circle: { circleCliVersion: async () => ({ version: '0.0.6', supported: true }), circleWalletStatus: async () => normalizedCircleStatus(), circleGatewayBalance: async () => ({ normalized: { ok: true, data: { total: 1 } } }) },
    arc: { RPC_URL, assertArcChain: async () => ARC_TESTNET_CHAIN_ID, getCode: async () => '0x60016001' },
  })
  assert.equal(readiness.ok, false)
}))

test('P0 readiness is false when unresolved reconciliation exists', async () => withEnv(healthyLiveEnv('readiness-unresolved'), async () => {
  const status = require('../backend/routes/status')
  const stateStore = require('../backend/lib/state-store')
  await stateStore.claimIdempotency({ runId: 'run_ready_unresolved', idempotencyKey: 'idem_ready_unresolved', offerId: DEMO_OFFERS[0].id, mode: 'live' })
  await stateStore.reserveBudget({ runId: 'run_ready_unresolved', owner: 'operator:live', amountUsdc: 0.1, dailyBudgetUsdc: 1, budgetImpact: true })
  await stateStore.releaseBudget('run_ready_unresolved', 'reconciliation-held')
  const readiness = await status._internals.collectLiveReadiness({
    circle: { circleCliVersion: async () => ({ version: '0.0.6', supported: true }), circleWalletStatus: async () => normalizedCircleStatus(), circleGatewayBalance: async () => ({ normalized: { ok: true, data: { total: 1 } } }) },
    arc: { RPC_URL, assertArcChain: async () => ARC_TESTNET_CHAIN_ID, getCode: async () => '0x60016001' },
  })
  const unresolved = readiness.checks.find((check) => check.label === 'unresolved-reconciliation')
  assert.equal(readiness.ok, false)
  assert.equal(unresolved.ok, false)
  assert.equal(unresolved.value.count, 1)
}))


test('P0 LiveSpendPreflight blocks wallet balance, wrong escrow USDC, low max amount, existing reservation, and unresolved before x402', async () => withEnv(healthyLiveEnv('spend-preflight'), async () => {
  async function blocked(arcOverrides = {}, stateOverrides = {}) {
    let servicesPayCalls = 0
    let walletExecuteCalls = 0
    await assert.rejects(() => assertLiveSpendPreflight({
      offer: DEMO_OFFERS[0],
      authorization: DEFAULT_AUTHORIZATION,
      circle: healthyPreflightCircle(),
      arc: healthyPreflightArc(arcOverrides),
      state: { listUnresolvedReconciliations: async () => [], ...stateOverrides },
    }), /live|USDC|Reservation|balance|reconciliation/i)
    assert.equal(servicesPayCalls, 0)
    assert.equal(walletExecuteCalls, 0)
  }
  await blocked({ getTokenBalance: async () => 99999n })
  await blocked({ getEscrowUsdc: async () => '0x3600000000000000000000000000000000000001' })
  await blocked({ getEscrowMaxReservationAmount: async () => 99999n })
  await blocked({ getReservation: async () => ({ status: 1 }) })
  await blocked({}, { listUnresolvedReconciliations: async () => [{ runId: 'run_unresolved' }] })
}))

test('P0 direct POST /api/scout/run cannot bypass Arc preflight before services pay', async () => withEnv({ ...healthyLiveEnv('direct-post-preflight'), CIRCLE_CLI_BIN: `/tmp/slabscout-circle-${process.pid}.js` }, async () => {
  const { encodeFunctionResult, parseAbi } = require('../backend/node_modules/viem')
  const express = require('../backend/node_modules/express')
  const scout = require('../backend/routes/scout')
  const logPath = `/tmp/slabscout-circle-${process.pid}.log`
  const circleBin = process.env.CIRCLE_CLI_BIN
  fs.writeFileSync(circleBin, `#!/usr/bin/env node
const fs = require('node:fs')
const log = ${JSON.stringify(logPath)}
const args = process.argv.slice(2)
fs.appendFileSync(log, args.join(' ') + '\\n')
if (args.join(' ') === 'wallet status --type agent --output json') {
  console.log(${JSON.stringify(JSON.stringify(circleStatusFixture()))})
  process.exit(0)
}
console.log(JSON.stringify({ success: true, data: {} }))
`)
  fs.chmodSync(circleBin, 0o700)
  const prevFetch = global.fetch
  const escrowAbi = parseAbi(['function usdc() view returns (address)'])
  global.fetch = async (url, options = {}) => {
    const bodyText = String(options.body || '')
    if (bodyText.includes('jsonrpc')) {
      const body = JSON.parse(bodyText)
      if (body.method === 'eth_chainId') return { ok: true, json: async () => ({ result: `0x${ARC_TESTNET_CHAIN_ID.toString(16)}` }) }
      if (body.method === 'eth_getCode') return { ok: true, json: async () => ({ result: '0x60016001' }) }
      if (body.method === 'eth_call') return { ok: true, json: async () => ({ result: encodeFunctionResult({ abi: escrowAbi, functionName: 'usdc', result: '0x3600000000000000000000000000000000000001' }) }) }
    }
    const href = String(url)
    let body = replayCardDetail
    if (href.includes('/v1/graded/')) body = replayCertLookup
    else if (href.includes('/fmv-series')) body = replayFmvSeries
    else if (href.includes('/trades')) body = replayTrades
    else if (href.endsWith('/v1/indices')) body = replayIndices
    return { ok: true, status: 200, text: async () => JSON.stringify(body), headers: { get: () => null }, url: href }
  }
  try {
    const app = express()
    app.use(express.json())
    app.use('/api/scout', scout)
    const res = await request(app, { path: '/api/scout/run', method: 'POST', headers: { 'x-slabscout-operator-token': 'op' }, body: { mode: 'live', offerId: DEMO_OFFERS[0].id, idempotencyKey: 'idem_direct_post_preflight', authorization: DEFAULT_AUTHORIZATION } })
    assert.equal(res.status, 409)
    const log = fs.readFileSync(logPath, 'utf8')
    assert.match(log, /wallet status --type agent --output json/)
    assert.doesNotMatch(log, /services pay/)
    assert.doesNotMatch(log, /wallet execute/)
  } finally {
    global.fetch = prevFetch
    fs.rmSync(circleBin, { force: true })
    fs.rmSync(logPath, { force: true })
  }
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
    assert.equal(await getIdempotencyRunId('idem_new_blocked'), null)
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


test('P1 reconciliation resolve confirms Arc reservation and duplicate resolve is safe', async () => withEnv(healthyLiveEnv('resolve-confirmed'), async () => {
  const stateStore = require('../backend/lib/state-store')
  const runId = 'run_resolve_confirmed'
  const idempotencyKey = 'idem_resolve_confirmed'
  const offerHash = deterministicOfferHash(DEMO_OFFERS[0])
  const amountMinor = amountMinorUsdc(DEMO_OFFERS[0].depositUsdc).toString()
  const proofHash = `0x${'f'.repeat(64)}`
  await stateStore.claimIdempotency({ runId, idempotencyKey, offerId: DEMO_OFFERS[0].id, mode: 'live' })
  await stateStore.reserveBudget({ runId, owner: 'operator:live', amountUsdc: 0.101, dailyBudgetUsdc: 1, budgetImpact: true })
  await stateStore.claimPaymentIntent({ runId, idempotencyKey, offerId: DEMO_OFFERS[0].id, owner: 'operator:live', amountUsdc: 0.001, budgetImpact: true })
  await stateStore.recordReservation({ runId, offerHash, status: 'reconciliation_required', escrow: TEST_ESCROW, usdc: ARC_TESTNET_USDC_ADDRESS, buyer: TEST_AGENT_WALLET, seller: TEST_SELLER, amountMinor, proofHash, operation: 'reserve' }, { owner: 'operator:live' })
  await stateStore.markRunStage(runId, 'reconciliation-required', { offerHash, operation: 'reserve' })
  await stateStore.releaseBudget(runId, 'reconciliation-held')
  const result = await resolveReconciliation({
    runId,
    arc: { RPC_URL, assertArcChain: async () => ARC_TESTNET_CHAIN_ID, getEscrowUsdc: async () => ARC_TESTNET_USDC_ADDRESS, getReservation: async () => ({ status: 1, buyer: TEST_AGENT_WALLET, seller: TEST_SELLER, amount: BigInt(amountMinor), proofHash }) },
    circle: {},
  })
  assert.equal(result.status, 'reconciled-confirmed')
  const context = await getReconciliationContext(runId)
  assert.equal(context.budgetHold.status, 'settled')
  assert.equal(context.paymentIntent.status, 'reconciled-confirmed')
  assert.equal(context.reservation.status, 'chain-confirmed')
  const duplicate = await resolveReconciliation({ runId, arc: {}, circle: {} })
  assert.equal(duplicate.status, 'already_resolved')
}))

test('P1 reconciliation resolve marks reverted and not-submitted from authoritative checks', async () => withEnv(healthyLiveEnv('resolve-reverted'), async () => {
  const stateStore = require('../backend/lib/state-store')
  async function seed(runId, idempotencyKey, extra = {}) {
    const offerHash = deterministicOfferHash(DEMO_OFFERS[0])
    await stateStore.claimIdempotency({ runId, idempotencyKey, offerId: DEMO_OFFERS[0].id, mode: 'live' })
    await stateStore.reserveBudget({ runId, owner: 'operator:live', amountUsdc: 0.101, dailyBudgetUsdc: 1, budgetImpact: true })
    await stateStore.claimPaymentIntent({ runId, idempotencyKey, offerId: DEMO_OFFERS[0].id, owner: 'operator:live', amountUsdc: 0.001, budgetImpact: false })
    await stateStore.recordReservation({ runId, offerHash, status: 'reconciliation_required', escrow: TEST_ESCROW, usdc: ARC_TESTNET_USDC_ADDRESS, buyer: TEST_AGENT_WALLET, seller: TEST_SELLER, amountMinor: amountMinorUsdc(DEMO_OFFERS[0].depositUsdc).toString(), proofHash: `0x${'f'.repeat(64)}`, operation: 'reserve', ...extra }, { owner: 'operator:live' })
    await stateStore.markRunStage(runId, 'reconciliation-required', { offerHash, operation: 'reserve', ...extra })
    await stateStore.releaseBudget(runId, 'reconciliation-held')
  }
  await seed('run_resolve_reverted', 'idem_resolve_reverted', { txHash: `0x${'1'.repeat(64)}` })
  const reverted = await resolveReconciliation({
    runId: 'run_resolve_reverted',
    arc: { RPC_URL, assertArcChain: async () => ARC_TESTNET_CHAIN_ID, getEscrowUsdc: async () => ARC_TESTNET_USDC_ADDRESS, getReservation: async () => ({ status: 0 }), getTransactionReceipt: async () => ({ status: '0x0' }) },
    circle: {},
  })
  assert.equal(reverted.outcome, 'reverted')
  assert.equal((await getReconciliationContext('run_resolve_reverted')).budgetHold.status, 'released')

  await seed('run_resolve_not_submitted', 'idem_resolve_not_submitted', { circleTransactionId: 'circle_not_submitted' })
  const notSubmitted = await resolveReconciliation({
    runId: 'run_resolve_not_submitted',
    arc: { RPC_URL, assertArcChain: async () => ARC_TESTNET_CHAIN_ID, getEscrowUsdc: async () => ARC_TESTNET_USDC_ADDRESS, getReservation: async () => ({ status: 0 }) },
    circle: { circleTransactionStatus: async () => ({ normalized: { ok: true, data: { status: 'NOT_SUBMITTED' } } }) },
  })
  assert.equal(notSubmitted.outcome, 'not-submitted')
  assert.equal((await getReconciliationContext('run_resolve_not_submitted')).paymentIntent.status, 'reconciled-not-submitted')
}))

test('P1 reconciliation resolve keeps ambiguous state and rejects wrong token', async () => withEnv(healthyLiveEnv('resolve-ambiguous'), async () => {
  const stateStore = require('../backend/lib/state-store')
  const offerHash = deterministicOfferHash(DEMO_OFFERS[0])
  async function seed(runId, usdc = ARC_TESTNET_USDC_ADDRESS) {
    await stateStore.claimIdempotency({ runId, idempotencyKey: `idem_${runId}`, offerId: DEMO_OFFERS[0].id, mode: 'live' })
    await stateStore.reserveBudget({ runId, owner: 'operator:live', amountUsdc: 0.101, dailyBudgetUsdc: 1, budgetImpact: true })
    await stateStore.recordReservation({ runId, offerHash, status: 'reconciliation_required', escrow: TEST_ESCROW, usdc, buyer: TEST_AGENT_WALLET, seller: TEST_SELLER, amountMinor: amountMinorUsdc(DEMO_OFFERS[0].depositUsdc).toString(), proofHash: `0x${'f'.repeat(64)}`, operation: 'reserve', txHash: `0x${'2'.repeat(64)}` }, { owner: 'operator:live' })
    await stateStore.markRunStage(runId, 'reconciliation-required', { offerHash, operation: 'reserve', txHash: `0x${'2'.repeat(64)}` })
    await stateStore.releaseBudget(runId, 'reconciliation-held')
  }
  await seed('run_resolve_ambiguous')
  const ambiguous = await resolveReconciliation({
    runId: 'run_resolve_ambiguous',
    arc: { RPC_URL, assertArcChain: async () => ARC_TESTNET_CHAIN_ID, getEscrowUsdc: async () => ARC_TESTNET_USDC_ADDRESS, getReservation: async () => ({ status: 0 }), getTransactionReceipt: async () => null },
    circle: {},
  })
  assert.equal(ambiguous.status, 'still_ambiguous')
  assert.equal((await getReconciliationContext('run_resolve_ambiguous')).budgetHold.status, 'reconciliation-held')

  await seed('run_resolve_wrong_token', '0x3600000000000000000000000000000000000001')
  await assert.rejects(() => resolveReconciliation({ runId: 'run_resolve_wrong_token', arc: {}, circle: {} }), /token mismatch/)
  assert.equal((await getReconciliationContext('run_resolve_wrong_token')).budgetHold.status, 'reconciliation-held')
}))

test('P1 reconciliation resolve endpoint rejects client-declared outcomes', async () => withEnv(healthyLiveEnv('resolve-route'), async () => {
  const express = require('../backend/node_modules/express')
  const scout = require('../backend/routes/scout')
  const app = express()
  app.use(express.json())
  app.use('/api/scout', scout)
  const res = await request(app, { path: '/api/scout/reconciliations/run_any/resolve', method: 'POST', headers: { 'x-slabscout-operator-token': 'op' }, body: { outcome: 'confirmed' } })
  assert.equal(res.status, 400)
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
