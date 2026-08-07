const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')

const {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_USDC_ADDRESS,
  DEFAULT_AUTHORIZATION,
  DEMO_OFFERS,
  DEMO_TARGET,
} = require('../packages/shared')
const { validateAuthorization, validateOffer, validateRuntimeConfig } = require('../packages/shared/validation')
const { getReplaySignal, getCardSignal } = require('../packages/renaiss-client')
const { evaluateSignal, finalizeWithProof } = require('../packages/policy-engine')
const {
  buildMarketProof,
  verifyMarketProof,
  verifyPaymentReceipt,
  assertLiveSigningSecret,
  DEFAULT_SIGNING_SECRET,
} = require('../packages/market-proof')
const { runScout, selectOffer } = require('../backend/lib/scout-agent')
const { resetStateForTests } = require('../backend/lib/state-store')

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

function replayPayment(runId = 'run_test', idempotencyKey = 'idem_test') {
  const now = new Date().toISOString()
  return {
    paymentKind: 'MarketProofPayment',
    runId,
    idempotencyKey,
    offerId: DEMO_OFFERS[0].id,
    targetItemId: DEMO_OFFERS[0].targetItemId,
    targetHref: DEMO_OFFERS[0].targetHref,
    payerWallet: null,
    payeeService: 'slabscout-market-proof-replay-service',
    network: 'Arc Testnet',
    chainId: ARC_TESTNET_CHAIN_ID,
    asset: 'USDC',
    usdcAddress: ARC_TESTNET_USDC_ADDRESS,
    amountUsdc: 0.001,
    receiptId: `replay_pay_${crypto.randomBytes(8).toString('hex')}`,
    circlePaymentId: null,
    txHash: null,
    paidAt: now,
    providerStatus: 'simulated',
    confirmed: false,
    simulated: true,
    replayAccepted: true,
  }
}

test.beforeEach(() => resetStateForTests())

test('P0-A constants use Arc Testnet production values', () => {
  assert.equal(ARC_TESTNET_CHAIN_ID, 5042002)
  assert.equal(ARC_TESTNET_USDC_ADDRESS, '0x3600000000000000000000000000000000000000')
  assert.equal(DEMO_TARGET.certNumber, '80396943')
})

test('P0-A.2 validates structural identity, expiry, caps, modes, and seller address', () => {
  assert.equal(validateAuthorization(DEFAULT_AUTHORIZATION).ok, true)
  assert.equal(validateOffer(DEMO_OFFERS[0], new Date('2026-08-07T00:00:00.000Z')).ok, true)
  assert.equal(validateRuntimeConfig({ CIRCLE_MODE: 'mock', ARC_EXECUTION_MODE: 'mock' }).ok, true)

  const overCap = validateAuthorization({ ...DEFAULT_AUTHORIZATION, maxIntelFeeUsdc: 0.01, maxDepositUsdc: 0.5 })
  assert.equal(overCap.ok, false)
  assert.match(overCap.errors.join('\n'), /maxIntelFeeUsdc/)
  assert.match(overCap.errors.join('\n'), /maxDepositUsdc/)

  const invalid = { ...DEMO_OFFERS[0], targetItemId: undefined, targetHref: undefined, sellerAddress: '0x123', expiresAt: '2020-01-01T00:00:00.000Z', askUsd: -1 }
  const result = validateOffer(invalid, new Date('2026-08-07T00:00:00.000Z'))
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /targetItemId/)
  assert.match(result.errors.join('\n'), /sellerAddress/)
  assert.match(result.errors.join('\n'), /expired/)
  assert.match(result.errors.join('\n'), /askUsd/)
})

test('P0-A.2 replay Renaiss signal uses real cert identity and transaction-only samples', async () => {
  const signal = await getReplaySignal({ offer: DEMO_OFFERS[0], authorization: DEFAULT_AUTHORIZATION })
  assert.equal(signal.dataMode, 'replay')
  assert.equal(signal.identity.certFound, true)
  assert.equal(signal.identity.certMatchesOffer, true)
  assert.equal(signal.identity.certLookup.certNumber, '80396943')
  assert.equal(signal.identity.certLookup.itemId, DEMO_TARGET.targetItemId)
  assert.equal(signal.identity.certLookup.href, DEMO_TARGET.targetHref)
  assert.ok(signal.trades.recent.length >= 1)
  assert.equal(signal.trades.sampleMode, 'transaction')
  assert.ok(signal.trades.recent.every((trade) => trade.kind === 'transaction'))
  assert.ok(signal.trades.recent.every((trade) => trade.observedAt))
})

test('P0-A.2 policy rejects Pikachu authorization paired with Charizard offer and executes nothing', async () => {
  const pikachuAuth = {
    ...DEFAULT_AUTHORIZATION,
    targetCard: 'Pikachu · invalid mismatch fixture',
    targetItemId: '11111111-1111-4111-8111-111111111111',
    targetHref: '/card/pokemon/base/58-pikachu-psa-10-english-11111111',
  }
  const result = await runScout({ mode: 'replay', offerId: DEMO_OFFERS[0].id, authorization: pikachuAuth })
  assert.equal(result.finalDecision.action, 'REJECT')
  assert.equal(result.payment, null)
  assert.equal(result.escrow, null)
  assert.ok(result.finalDecision.hardFails.some((item) => item.id === 'identity'))
})

test('P0-A.2 policy rejects targetCard display tampering even when structural IDs match', async () => {
  const badAuth = { ...DEFAULT_AUTHORIZATION, targetCard: 'Same cert but wrong display target' }
  const result = await runScout({ mode: 'replay', offerId: DEMO_OFFERS[0].id, authorization: badAuth })
  assert.equal(result.finalDecision.action, 'REJECT')
  assert.equal(result.payment, null)
  assert.equal(result.escrow, null)
})

test('P0-A.2 invalid cert is a REJECT live signal, not replay fallback', async () => {
  const prevFetch = global.fetch
  global.fetch = async (url) => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: 'invalid_cert' }), headers: { get: () => null }, url })
  try {
    const offer = { ...DEMO_OFFERS[0], certNumber: 'BAD-CERT-0000' }
    const authorization = { ...DEFAULT_AUTHORIZATION, certNumber: 'BAD-CERT-0000' }
    const signal = await getCardSignal({ mode: 'live', offer, authorization })
    assert.equal(signal.dataMode, 'live')
    assert.equal(signal.identity.certFound, false)
    assert.notEqual(signal.dataMode, 'REPLAY_FALLBACK')
    const decision = evaluateSignal({ signal, offer, authorization, now: new Date('2026-08-07T00:00:00.000Z') })
    assert.equal(decision.action, 'REJECT')
  } finally {
    global.fetch = prevFetch
  }
})

test('P0-A.2 Renaiss 5xx fallback blocks payment and escrow', async () => withEnv({ MARKET_PROOF_SIGNING_SECRET: 'live-test-secret', SLABSCOUT_OPERATOR_TOKEN: 'op', SLABSCOUT_STATE_FILE: `/tmp/slabscout-test-${process.pid}-5xx.json` }, async () => {
  const prevFetch = global.fetch
  global.fetch = async (url) => ({ ok: false, status: 500, text: async () => 'server error', headers: { get: () => null }, url })
  try {
    const result = await runScout({ mode: 'live', offerId: DEMO_OFFERS[0].id, idempotencyKey: 'live-5xx-test', authorization: DEFAULT_AUTHORIZATION, operatorAuthorized: true })
    assert.equal(result.signal.dataMode, 'REPLAY_FALLBACK')
    assert.equal(result.finalDecision.action, 'REJECT')
    assert.equal(result.payment, null)
    assert.equal(result.escrow, null)
    assert.equal(result.executionStatus, 'replay-fallback-blocked')
  } finally {
    global.fetch = prevFetch
  }
}))

test('P0-A.2 unknown/missing offerId and arbitrary body.offer are rejected', () => {
  assert.throws(() => selectOffer({}), /offerId is required/)
  assert.throws(() => selectOffer({ offerId: 'unknown-offer' }), /Unknown offerId/)
  assert.throws(() => selectOffer({ offer: { ...DEMO_OFFERS[0], sellerAddress: '0x5000000000000000000000000000000000000999' } }), /body.offer is not accepted/)
})

test('P0-A policy rejects missing valuation instead of passing price checks', () => {
  const signal = {
    dataMode: 'replay',
    identity: { certFound: true, certMatchesOffer: true, imageConfidence: 'high', certNumber: '80396943' },
    valuation: { medianUsd: null, meanUsd: null, vwapUsd: null },
    quality: { confidence: 'prime', sourceCount: 2, observationCount: 10, lastSaleAt: '2026-08-06T00:00:00.000Z', refreshing: false },
  }
  const decision = evaluateSignal({ signal, offer: DEMO_OFFERS[0], authorization: DEFAULT_AUTHORIZATION, now: new Date('2026-08-07T00:00:00.000Z') })
  assert.equal(decision.action, 'REJECT')
  assert.ok(decision.hardFails.some((item) => item.id === 'valuation-present'))
})

test('P0-A.2 MarketProof verifier ignores caller verified flags and fails proof tampering', async () => {
  const runId = 'run_marketproof'
  const idempotencyKey = 'idem_marketproof'
  const signal = await getReplaySignal({ offer: DEMO_OFFERS[0], authorization: DEFAULT_AUTHORIZATION })
  const payment = replayPayment(runId, idempotencyKey)
  const proof = buildMarketProof({ signal, offer: DEMO_OFFERS[0], authorization: DEFAULT_AUTHORIZATION, payment, runId, idempotencyKey })
  const verified = await verifyMarketProof({ proof, offer: DEMO_OFFERS[0], authorization: DEFAULT_AUTHORIZATION, payment, runId, idempotencyKey, expectedMode: 'replay', now: new Date(proof.generatedAt) })
  assert.equal(verified.ok, true)
  assert.match(proof.proofHash, /^0x[a-fA-F0-9]{64}$/)
  assert.equal((await finalizeWithProof({ signal, offer: DEMO_OFFERS[0], authorization: DEFAULT_AUTHORIZATION, proof: verified.proof, payment, runId, idempotencyKey, expectedMode: 'replay', now: new Date(proof.generatedAt) })).action, 'RESERVE')

  const randomHash = `0x${crypto.randomBytes(32).toString('hex')}`
  assert.equal((await verifyMarketProof({ proof: { proofKind: 'MarketProof', proofHash: randomHash, verified: true, verification: { ok: true } }, offer: DEMO_OFFERS[0], authorization: DEFAULT_AUTHORIZATION, payment, runId, idempotencyKey, expectedMode: 'replay', now: new Date(proof.generatedAt) })).ok, false)
  assert.equal((await verifyMarketProof({ proof: { ...proof, signature: `hmac-sha256:${'a'.repeat(64)}` }, offer: DEMO_OFFERS[0], authorization: DEFAULT_AUTHORIZATION, payment, runId, idempotencyKey, expectedMode: 'replay', now: new Date(proof.generatedAt) })).ok, false)
  assert.equal((await verifyMarketProof({ proof: { ...proof, askUsd: 94 }, offer: DEMO_OFFERS[0], authorization: DEFAULT_AUTHORIZATION, payment, runId, idempotencyKey, expectedMode: 'replay', now: new Date(proof.generatedAt) })).ok, false)
  assert.equal((await verifyMarketProof({ proof: { ...proof, offerId: 'other-offer' }, offer: DEMO_OFFERS[0], authorization: DEFAULT_AUTHORIZATION, payment, runId, idempotencyKey, expectedMode: 'replay', now: new Date(proof.generatedAt) })).ok, false)
  assert.equal((await verifyMarketProof({ proof: { ...proof, cardIdentity: { ...proof.cardIdentity, certNumber: '00000000' } }, offer: DEMO_OFFERS[0], authorization: DEFAULT_AUTHORIZATION, payment, runId, idempotencyKey, expectedMode: 'replay', now: new Date(proof.generatedAt) })).ok, false)
  assert.equal((await verifyMarketProof({ proof: { ...proof, paymentReceipt: { ...proof.paymentReceipt, amountUsdc: 0.002 } }, offer: DEMO_OFFERS[0], authorization: DEFAULT_AUTHORIZATION, payment, runId, idempotencyKey, expectedMode: 'replay', now: new Date(proof.generatedAt) })).ok, false)
  assert.equal((await verifyMarketProof({ proof: { ...proof, generatedAt: new Date(Date.now() + 120_000).toISOString() }, offer: DEMO_OFFERS[0], authorization: DEFAULT_AUTHORIZATION, payment, runId, idempotencyKey, expectedMode: 'replay' })).ok, false)
  assert.equal((await verifyMarketProof({ proof: { ...proof, sourceUpdatedAt: '2020-01-01T00:00:00.000Z' }, offer: DEMO_OFFERS[0], authorization: DEFAULT_AUTHORIZATION, payment, runId, idempotencyKey, expectedMode: 'replay' })).ok, false)
  const forgedMode = { ...proof, dataMode: 'replay' }
  assert.equal((await verifyMarketProof({ proof: forgedMode, offer: DEMO_OFFERS[0], authorization: DEFAULT_AUTHORIZATION, payment, runId, idempotencyKey, expectedMode: 'live' })).ok, false)
})

test('P0-A.2 payment verifier rejects paid string, replay, asset, amount, and reused receipt errors', async () => {
  const runId = 'run_payment'
  const idempotencyKey = 'idem_payment'
  const badPaid = { ...replayPayment(runId, idempotencyKey), status: 'paid', providerStatus: 'confirmed', confirmed: false, simulated: false, replayAccepted: false, receiptId: 'live_receipt' }
  assert.equal((await verifyPaymentReceipt({ payment: badPaid, runId, idempotencyKey, offer: DEMO_OFFERS[0], authorization: DEFAULT_AUTHORIZATION, expectedMode: 'live' })).ok, false)
  assert.equal((await verifyPaymentReceipt({ payment: { ...replayPayment(runId, idempotencyKey), amountUsdc: 0.002 }, runId, idempotencyKey, offer: DEMO_OFFERS[0], authorization: DEFAULT_AUTHORIZATION, expectedMode: 'replay' })).ok, false)
  assert.equal((await verifyPaymentReceipt({ payment: { ...replayPayment(runId, idempotencyKey), usdcAddress: '0x3600000000000000000000000000000000000001' }, runId, idempotencyKey, offer: DEMO_OFFERS[0], authorization: DEFAULT_AUTHORIZATION, expectedMode: 'replay' })).ok, false)
  assert.equal((await verifyPaymentReceipt({ payment: replayPayment(runId, idempotencyKey), runId, idempotencyKey, offer: DEMO_OFFERS[0], authorization: DEFAULT_AUTHORIZATION, expectedMode: 'replay', isReceiptUsed: () => true })).ok, false)
})

test('P0-A live mode refuses default MarketProof signing secret', () => withEnv({ MARKET_PROOF_SIGNING_SECRET: undefined }, async () => {
  assert.throws(() => assertLiveSigningSecret('live'), /MARKET_PROOF_SIGNING_SECRET/)
  process.env.MARKET_PROOF_SIGNING_SECRET = DEFAULT_SIGNING_SECRET
  assert.throws(() => assertLiveSigningSecret('live'), /MARKET_PROOF_SIGNING_SECRET/)
  process.env.MARKET_PROOF_SIGNING_SECRET = 'not-default-for-test'
  assert.doesNotThrow(() => assertLiveSigningSecret('live'))
}))

test('P0-A.2 bad chain or USDC config fails call-time validation', async () => {
  await withEnv({ ARC_CHAIN_ID: '1' }, async () => {
    const config = validateRuntimeConfig(process.env)
    assert.equal(config.ok, false)
    assert.match(config.errors.join('\n'), /ARC_CHAIN_ID/)
    await assert.rejects(() => runScout({ mode: 'replay', offerId: DEMO_OFFERS[0].id }), /ARC_CHAIN_ID/)
  })
  await withEnv({ ARC_USDC_ADDRESS: '0x3600000000000000000000000000000000000001' }, async () => {
    const config = validateRuntimeConfig(process.env)
    assert.equal(config.ok, false)
    assert.match(config.errors.join('\n'), /ARC_USDC_ADDRESS/)
  })
})

test('P0-A.2 replay takes priority over live Circle/Arc env and never returns live confirmations', async () => withEnv({
  CIRCLE_MODE: 'live',
  ARC_EXECUTION_MODE: 'live',
  ARC_CHAIN_ID: '5042002',
  ARC_USDC_ADDRESS: '0x3600000000000000000000000000000000000000',
  RESERVATION_ESCROW_ADDRESS: undefined,
  AGENT_WALLET_ADDRESS: undefined,
}, async () => {
  const result = await runScout({ mode: 'replay', offerId: DEMO_OFFERS[0].id })
  assert.equal(result.finalDecision.action, 'RESERVE')
  assert.equal(result.payment.status, 'replay-payment-simulated')
  assert.equal(result.payment.confirmed, false)
  assert.equal(result.payment.simulated, true)
  assert.equal(result.escrow.status, 'replay-escrow-simulated')
  assert.equal(result.escrow.chainConfirmed, false)
  assert.equal(result.escrow.txHash, null)
  assert.equal(result.executionStatus, 'replay-simulated')
}))

test('P0-A.2 requireMarketProof=false uses PolicyProof and does not budget proof fee', async () => {
  const result = await runScout({
    mode: 'replay',
    offerId: DEMO_OFFERS[0].id,
    authorization: { requireMarketProof: false, dailyBudgetUsdc: 0.1005, maxDepositUsdc: 0.1 },
  })
  assert.equal(result.finalDecision.action, 'RESERVE')
  assert.equal(result.payment, null)
  assert.equal(result.proof.proofKind, 'PolicyProof')
  assert.equal(result.finalDecision.metrics.plannedIntelFeeUsdc, 0)
  assert.equal(result.finalDecision.metrics.plannedRunSpendUsdc, 0.1)
})

test('P0-A.2 source sample is transaction-backed or explicitly aggregate-only; listings never enter transaction sample', async () => {
  const signal = await getReplaySignal({ offer: DEMO_OFFERS[0], authorization: DEFAULT_AUTHORIZATION })
  assert.ok(signal.trades.sampleMode === 'transaction' || signal.trades.sampleMode === 'aggregate-only')
  if (signal.trades.sampleMode === 'transaction') assert.ok(signal.trades.recent.every((trade) => trade.kind === 'transaction'))
  else assert.equal(signal.trades.recent.length, 0)
})

test('P0-A.2 same idempotencyKey returns cached result and does not pay twice', async () => {
  const first = await runScout({ mode: 'replay', offerId: DEMO_OFFERS[0].id, idempotencyKey: 'idem-repeat' })
  const second = await runScout({ mode: 'replay', offerId: DEMO_OFFERS[0].id, idempotencyKey: 'idem-repeat' })
  assert.equal(second.idempotentReplay, true)
  assert.equal(second.runId, first.runId)
  assert.equal(second.payment.receiptId, first.payment.receiptId)
})

function request(app, { method = 'POST', path = '/api/scout/run', body = {}, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const payload = JSON.stringify(body)
      const req = require('node:http').request({
        hostname: '127.0.0.1',
        port: server.address().port,
        path,
        method,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
      }, (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          server.close(() => {
            try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }) }
            catch { resolve({ status: res.statusCode, body: data }) }
          })
        })
      })
      req.on('error', (error) => server.close(() => reject(error)))
      req.write(payload)
      req.end()
    })
  })
}

function scoutApp() {
  const express = require('../backend/node_modules/express')
  const scout = require('../backend/routes/scout')
  const app = express()
  app.use(express.json())
  app.use('/api/scout', scout)
  return app
}

test('P0-1 HTTP mode/auth regression: default live requires token before external calls', async () => withEnv({ SLABSCOUT_DEFAULT_MODE: 'live', SLABSCOUT_OPERATOR_TOKEN: 'correct', MARKET_PROOF_SIGNING_SECRET: 'live-test-secret' }, async () => {
  const prevFetch = global.fetch
  let called = false
  global.fetch = async () => { called = true; throw new Error('should not call external') }
  try {
    const res = await request(scoutApp(), { body: { offerId: DEMO_OFFERS[0].id, idempotencyKey: 'http-default-live' } })
    assert.equal(res.status, 401)
    assert.equal(called, false)
  } finally {
    global.fetch = prevFetch
  }
}))

test('P0-1 HTTP mode/auth regression: live-cache is rejected before Renaiss', async () => withEnv({ SLABSCOUT_OPERATOR_TOKEN: 'correct', MARKET_PROOF_SIGNING_SECRET: 'live-test-secret' }, async () => {
  const prevFetch = global.fetch
  let called = false
  global.fetch = async () => { called = true; throw new Error('should not call external') }
  try {
    const res = await request(scoutApp(), { body: { mode: 'live-cache', offerId: DEMO_OFFERS[0].id, idempotencyKey: 'http-live-cache' } })
    assert.equal(res.status, 400)
    assert.equal(called, false)
  } finally {
    global.fetch = prevFetch
  }
}))

test('P0-1 HTTP mode/auth regression: missing, wrong, and correct live tokens', async () => withEnv({ SLABSCOUT_OPERATOR_TOKEN: 'correct', MARKET_PROOF_SIGNING_SECRET: 'live-test-secret', SLABSCOUT_DEFAULT_MODE: 'replay', SLABSCOUT_STATE_FILE: `/tmp/slabscout-test-${process.pid}-http-live.json` }, async () => {
  const app = scoutApp()
  const missing = await request(app, { body: { mode: 'live', offerId: DEMO_OFFERS[0].id, idempotencyKey: 'missing-token' } })
  assert.equal(missing.status, 401)
  const wrong = await request(app, { body: { mode: 'live', offerId: DEMO_OFFERS[0].id, idempotencyKey: 'wrong-token' }, headers: { 'x-slabscout-operator-token': 'wrong' } })
  assert.equal(wrong.status, 403)

  const prevFetch = global.fetch
  global.fetch = async (url) => ({ ok: false, status: 500, text: async () => 'server error', headers: { get: () => null }, url })
  try {
    const correct = await request(app, { body: { mode: 'live', offerId: DEMO_OFFERS[0].id, idempotencyKey: 'correct-token' }, headers: { 'x-slabscout-operator-token': 'correct' } })
    assert.equal(correct.status, 200)
    assert.equal(correct.body.signal.dataMode, 'REPLAY_FALLBACK')
  } finally {
    global.fetch = prevFetch
  }
}))

test('P0-4 signed proofs with bad cert flags or targetCard mismatch are rejected', async () => {
  const runId = 'run_bad_cert_flags'
  const idempotencyKey = 'idem_bad_cert_flags'
  const signal = await getReplaySignal({ offer: DEMO_OFFERS[0], authorization: DEFAULT_AUTHORIZATION })
  const payment = replayPayment(runId, idempotencyKey)
  const certMismatchSignal = { ...signal, identity: { ...signal.identity, certMatchesOffer: false } }
  const certMismatchProof = buildMarketProof({ signal: certMismatchSignal, offer: DEMO_OFFERS[0], authorization: DEFAULT_AUTHORIZATION, payment, runId, idempotencyKey })
  assert.equal((await verifyMarketProof({ proof: certMismatchProof, offer: DEMO_OFFERS[0], authorization: DEFAULT_AUTHORIZATION, payment, runId, idempotencyKey, expectedMode: 'replay' })).ok, false)

  const certMissingSignal = { ...signal, identity: { ...signal.identity, certFound: false } }
  const certMissingProof = buildMarketProof({ signal: certMissingSignal, offer: DEMO_OFFERS[0], authorization: DEFAULT_AUTHORIZATION, payment, runId, idempotencyKey })
  assert.equal((await verifyMarketProof({ proof: certMissingProof, offer: DEMO_OFFERS[0], authorization: DEFAULT_AUTHORIZATION, payment, runId, idempotencyKey, expectedMode: 'replay' })).ok, false)

  const proof = buildMarketProof({ signal, offer: DEMO_OFFERS[0], authorization: DEFAULT_AUTHORIZATION, payment, runId, idempotencyKey })
  const badAuth = { ...DEFAULT_AUTHORIZATION, targetCard: 'Different target label' }
  assert.equal((await verifyMarketProof({ proof, offer: DEMO_OFFERS[0], authorization: badAuth, payment, runId, idempotencyKey, expectedMode: 'replay' })).ok, false)
  const fakeVerification = { ok: true, proofKind: 'MarketProof', proof: { ...proof, proofHash: `0x${'1'.repeat(64)}`, runId, offerId: DEMO_OFFERS[0].id, idempotencyKey } }
  assert.equal((await finalizeWithProof({ signal, offer: DEMO_OFFERS[0], authorization: DEFAULT_AUTHORIZATION, proof: { ...proof, proofHash: `0x${'1'.repeat(64)}` }, payment, runId, idempotencyKey, expectedMode: 'replay', proofVerification: fakeVerification })).action, 'REJECT')
})

test('P0-4 live payment verifier rejects attacker payer/payee and provider mismatch', async () => withEnv({
  CIRCLE_AGENT_WALLET_ADDRESS: '0xA9E0000000000000000000000000000000000001',
  MARKET_PROOF_SELLER_ADDRESS: '0x7000000000000000000000000000000000000001',
}, async () => {
  const runId = 'run_live_payment'
  const idempotencyKey = 'idem_live_payment'
  const livePayment = {
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
    chainId: 5042002,
    asset: 'USDC',
    usdcAddress: '0x3600000000000000000000000000000000000000',
    amountUsdc: 0.001,
    receiptId: 'settlement_live_test',
    circlePaymentId: 'settlement_live_test',
    txHash: `0x${'2'.repeat(64)}`,
    paidAt: new Date().toISOString(),
    providerStatus: 'settled',
    confirmed: true,
    simulated: false,
    replayAccepted: false,
  }
  assert.equal((await verifyPaymentReceipt({ payment: livePayment, runId, idempotencyKey, offer: DEMO_OFFERS[0], authorization: DEFAULT_AUTHORIZATION, expectedMode: 'live' })).ok, true)
  assert.equal((await verifyPaymentReceipt({ payment: { ...livePayment, payerWallet: '0xA9E0000000000000000000000000000000000002' }, runId, idempotencyKey, offer: DEMO_OFFERS[0], authorization: DEFAULT_AUTHORIZATION, expectedMode: 'live' })).ok, false)
  assert.equal((await verifyPaymentReceipt({ payment: { ...livePayment, payeeAddress: '0x7000000000000000000000000000000000000002' }, runId, idempotencyKey, offer: DEMO_OFFERS[0], authorization: DEFAULT_AUTHORIZATION, expectedMode: 'live' })).ok, false)
  assert.equal((await verifyPaymentReceipt({ payment: { ...livePayment, providerStatus: 'pending' }, runId, idempotencyKey, offer: DEMO_OFFERS[0], authorization: DEFAULT_AUTHORIZATION, expectedMode: 'live' })).ok, false)
  assert.equal((await verifyPaymentReceipt({ payment: { ...livePayment, providerNetwork: 'eip155:8453' }, runId, idempotencyKey, offer: DEMO_OFFERS[0], authorization: DEFAULT_AUTHORIZATION, expectedMode: 'live' })).ok, false)
}))

test('P0-5 live mode requires explicit idempotencyKey before external calls', async () => withEnv({ MARKET_PROOF_SIGNING_SECRET: 'live-test-secret', SLABSCOUT_OPERATOR_TOKEN: 'op' }, async () => {
  const prevFetch = global.fetch
  let called = false
  global.fetch = async () => { called = true; throw new Error('should not call external') }
  try {
    await assert.rejects(() => runScout({ mode: 'live', offerId: DEMO_OFFERS[0].id, authorization: DEFAULT_AUTHORIZATION, operatorAuthorized: true }), /idempotencyKey/)
    assert.equal(called, false)
  } finally {
    global.fetch = prevFetch
  }
}))


test('P0-5 live mode requires writable state file before external calls', async () => withEnv({ MARKET_PROOF_SIGNING_SECRET: 'live-test-secret', SLABSCOUT_STATE_FILE: undefined }, async () => {
  const prevFetch = global.fetch
  let called = false
  global.fetch = async () => { called = true; throw new Error('should not call external') }
  try {
    await assert.rejects(() => runScout({ mode: 'live', offerId: DEMO_OFFERS[0].id, idempotencyKey: 'missing-state', authorization: DEFAULT_AUTHORIZATION, operatorAuthorized: true }), /SLABSCOUT_STATE_FILE/)
    assert.equal(called, false)
  } finally {
    global.fetch = prevFetch
  }
}))

test('P0-5 concurrent live payment intents for same offer cannot both claim', async () => {
  const stateStore = require('../backend/lib/state-store')
  const first = stateStore.claimPaymentIntent({ runId: 'run_a', idempotencyKey: 'idem_a', offerId: DEMO_OFFERS[0].id, owner: 'operator:live', amountUsdc: 0.001, budgetImpact: true })
  const second = stateStore.claimPaymentIntent({ runId: 'run_b', idempotencyKey: 'idem_b', offerId: DEMO_OFFERS[0].id, owner: 'operator:live', amountUsdc: 0.001, budgetImpact: true })
  const results = await Promise.allSettled([first, second])
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1)
  assert.equal(results.filter((item) => item.status === 'rejected').length, 1)
})
