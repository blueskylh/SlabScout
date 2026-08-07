const http = require('node:http')
const https = require('node:https')

const required = ['SLABSCOUT_LIVE_BASE_URL', 'SLABSCOUT_OPERATOR_TOKEN']

function missing() {
  return required.filter((key) => !process.env[key])
}

async function requestJson(url, { method = 'GET', body = null, headers = {}, timeoutMs = 30_000 } = {}) {
  const payload = body ? JSON.stringify(body) : null
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const client = target.protocol === 'https:' ? https : http
    const req = client.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method,
      timeout: timeoutMs,
      headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers },
    }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        let parsed = null
        try { parsed = data ? JSON.parse(data) : null } catch { parsed = { raw: data } }
        resolve({ status: res.statusCode, body: parsed })
      })
    })
    req.on('timeout', () => req.destroy(new Error(`HTTP timeout after ${timeoutMs}ms`)))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function liveReadiness() {
  const url = new URL('/api/status/live-readiness', process.env.SLABSCOUT_LIVE_BASE_URL).toString()
  const response = await requestJson(url, { headers: { 'x-slabscout-operator-token': process.env.SLABSCOUT_OPERATOR_TOKEN }, timeoutMs: Number(process.env.SLABSCOUT_HTTP_TIMEOUT_MS || 30_000) })
  if (response.status !== 200 || response.body?.ok !== true) {
    const error = new Error('remote live readiness failed')
    error.response = response
    throw error
  }
  return response.body
}

async function main() {
  const gaps = missing()
  if (gaps.length > 0) {
    console.error(JSON.stringify({ ok: false, error: 'missing-live-e2e-inputs', missing: gaps }, null, 2))
    process.exit(1)
  }
  const readiness = await liveReadiness()
  if (process.env.SLABSCOUT_READINESS_ONLY === 'true') {
    console.log(JSON.stringify({ ok: true, readiness }, null, 2))
    return
  }
  const idempotencyKey = process.env.SLABSCOUT_LIVE_IDEMPOTENCY_KEY || `live-e2e-${new Date().toISOString().slice(0, 10)}-offer-reshizard-95`
  const url = new URL('/api/scout/run', process.env.SLABSCOUT_LIVE_BASE_URL).toString()
  const response = await requestJson(url, {
    method: 'POST',
    body: { mode: 'live', offerId: 'offer-reshizard-95', idempotencyKey },
    headers: { 'x-slabscout-operator-token': process.env.SLABSCOUT_OPERATOR_TOKEN },
    timeoutMs: Number(process.env.SLABSCOUT_HTTP_TIMEOUT_MS || 120_000),
  })
  if (response.status !== 200) {
    console.error(JSON.stringify({ ok: false, status: response.status, response: response.body }, null, 2))
    process.exit(1)
  }
  const run = response.body
  const evidence = {
    ok: run.executionStatus === 'chain-confirmed',
    runId: run.runId,
    offerId: run.offer?.id,
    idempotencyKey: run.idempotencyKey,
    paymentId: run.payment?.circlePaymentId || run.payment?.receiptId || null,
    payer: run.payment?.payerWallet || null,
    payee: run.payment?.payeeAddress || null,
    amount: run.payment?.amountUsdc || null,
    proofHash: run.proof?.proofHash || null,
    escrow: run.escrow?.escrow || null,
    txHash: run.escrow?.txHash || null,
    block: run.escrow?.blockNumber || null,
    explorerUrl: run.escrow?.arcscanUrl || null,
    escrowEvent: run.escrow?.event || null,
    decodedReservedEvent: run.escrow?.event?.name === 'Reserved' ? run.escrow.event : null,
    timestamps: { paidAt: run.payment?.paidAt || null, reservedAt: run.escrow?.reservedAt || null },
    executionStatus: run.executionStatus,
  }
  console.log(JSON.stringify(evidence, null, 2))
  if (!evidence.ok) process.exit(1)
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message, response: error.response || undefined }, null, 2))
  process.exit(1)
})
