const http = require('node:http')
const express = require('../backend/node_modules/express')
const demo = require('../backend/routes/demo')
const scout = require('../backend/routes/scout')
const status = require('../backend/routes/status')
const marketProof = require('../backend/routes/market-proof')
const { resetStateForTests } = require('../backend/lib/state-store')
const { resetRateLimitForTests } = require('../backend/lib/rate-limit')

function request(port, path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers } }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        let parsed = null
        try { parsed = data ? JSON.parse(data) : null } catch { parsed = data }
        resolve({ status: res.statusCode, body: parsed })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function main() {
  resetStateForTests()
  resetRateLimitForTests()
  const app = express()
  app.use(express.json())
  app.use('/api/status', status)
  app.use('/api/demo', demo)
  app.use('/api/scout', scout)
  app.use('/api/market-proof', marketProof)
  const server = app.listen(0)
  const port = server.address().port
  try {
    const statusRes = await request(port, '/api/status')
    if (statusRes.status !== 200) throw new Error(`/api/status expected 200, got ${statusRes.status}`)
    const demoRes = await request(port, '/api/demo')
    if (demoRes.status !== 200) throw new Error(`/api/demo expected 200, got ${demoRes.status}`)
    const replay = await request(port, '/api/scout/run', { method: 'POST', body: { mode: 'replay', offerId: 'offer-reshizard-95', idempotencyKey: 'smoke-replay' } })
    if (replay.status !== 200 || replay.body?.finalDecision?.action !== 'RESERVE') throw new Error('valid replay run failed')
    const unknown = await request(port, '/api/scout/run', { method: 'POST', body: { mode: 'replay', offerId: 'unknown-offer' } })
    if (unknown.status !== 400) throw new Error(`unknown offer expected 400, got ${unknown.status}`)
    const live = await request(port, '/api/scout/run', { method: 'POST', body: { mode: 'live', offerId: 'offer-reshizard-95' } })
    if (![401, 403].includes(live.status)) throw new Error(`unauthorized live expected 401/403, got ${live.status}`)
    console.log('Backend smoke checks passed')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
