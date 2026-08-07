const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { EVM_ADDRESS_RE } = require('../../packages/shared/constants')

const execFileAsync = promisify(execFile)
const MAX_OUTPUT_BYTES = 64 * 1024
const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /rsk_[A-Za-z0-9_-]+/g,
  /rk_[A-Za-z0-9_-]+/g,
  /0x[a-fA-F0-9]{64}/g,
]

function circleBin() {
  return process.env.CIRCLE_CLI_BIN || 'circle'
}

function sanitize(text = '') {
  let out = String(text).slice(0, MAX_OUTPUT_BYTES)
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[REDACTED]')
  return out
}

async function runCircle(args, { timeoutMs = 90_000 } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(circleBin(), args, {
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      env: process.env,
    })
    return { ok: true, stdout: sanitize(stdout), stderr: sanitize(stderr), args: args.map((arg) => sanitize(arg)) }
  } catch (error) {
    if (error.code === 'ENOENT') {
      const err = new Error('Circle CLI is not installed or not on PATH')
      err.statusCode = 503
      err.code = 'circle-cli-missing'
      throw err
    }
    const message = sanitize(`${error.message}\n${error.stdout || ''}\n${error.stderr || ''}`)
    const err = new Error(`Circle CLI failed: ${message}`)
    err.statusCode = 502
    err.code = error.code || 'circle-cli-failed'
    err.exitCode = error.code
    err.stdout = sanitize(error.stdout || '')
    err.stderr = sanitize(error.stderr || '')
    throw err
  }
}

function parseJsonOutput(stdout) {
  const text = String(stdout || '').trim()
  if (!text) return null
  try { return JSON.parse(text) } catch {}
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) {
    try { return JSON.parse(text.slice(first, last + 1)) } catch {}
  }
  return null
}

function extractTxHash(parsed, stdout = '') {
  const candidates = [
    parsed?.txHash,
    parsed?.transactionHash,
    parsed?.transaction,
    parsed?.receipt?.transactionHash,
    parsed?.result?.txHash,
    parsed?.result?.transactionHash,
    String(stdout).match(/0x[a-fA-F0-9]{64}/)?.[0],
  ].filter(Boolean)
  return candidates.find((value) => /^0x[a-fA-F0-9]{64}$/.test(String(value))) || null
}

function assertEvmAddress(value, field) {
  if (typeof value !== 'string' || !EVM_ADDRESS_RE.test(value) || /^0x0{40}$/i.test(value)) throw new Error(`${field} must be a valid non-zero EVM address`)
}

async function circleWalletStatus() {
  const result = await runCircle(['wallet', 'status', '--type', 'agent', '--output', 'json'], { timeoutMs: 30_000 })
  return { ...result, parsed: parseJsonOutput(result.stdout) }
}

async function circleGatewayBalance({ address, chain = 'ARC-TESTNET' }) {
  assertEvmAddress(address, 'address')
  const result = await runCircle(['gateway', 'balance', '--address', address, '--chain', chain, '--output', 'json'], { timeoutMs: 30_000 })
  return { ...result, parsed: parseJsonOutput(result.stdout) }
}

async function circleServicesPay({ url, address, chain = 'ARC-TESTNET', maxAmountUsdc, method = 'POST', data, timeoutSeconds = 60 }) {
  assertEvmAddress(address, 'address')
  const args = ['services', 'pay', url, '--address', address, '--chain', chain, '--max-amount', String(maxAmountUsdc), '--method', method, '--timeout', String(timeoutSeconds), '--output', 'json']
  if (data !== undefined) args.push('--data', JSON.stringify(data))
  const result = await runCircle(args, { timeoutMs: (timeoutSeconds + 15) * 1000 })
  return { ...result, parsed: parseJsonOutput(result.stdout) }
}

async function circleWalletExecute({ signature, params = [], contract, address, chain = 'ARC-TESTNET', rpcUrl }) {
  assertEvmAddress(contract, 'contract')
  assertEvmAddress(address, 'address')
  const args = ['wallet', 'execute', signature, ...params.map(String), '--contract', contract, '--address', address, '--chain', chain, '--output', 'json']
  if (rpcUrl) args.push('--rpc-url', rpcUrl)
  const result = await runCircle(args, { timeoutMs: 120_000 })
  const parsed = parseJsonOutput(result.stdout)
  return { ...result, parsed, txHash: extractTxHash(parsed, result.stdout) }
}

module.exports = {
  sanitize,
  runCircle,
  parseJsonOutput,
  extractTxHash,
  circleWalletStatus,
  circleGatewayBalance,
  circleServicesPay,
  circleWalletExecute,
}
