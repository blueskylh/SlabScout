const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { EVM_ADDRESS_RE } = require('../../packages/shared/constants')

const execFileAsync = promisify(execFile)
const MAX_OUTPUT_BYTES = 64 * 1024
const CIRCLE_CLI_VERIFIED_VERSION_RANGE = '0.0.6'
const PRIVATE_KEY_LABEL = 'OPENSSH PRIVATE KEY'
const SECRET_PATTERNS = [
  new RegExp(`-----BEGIN ${PRIVATE_KEY_LABEL}-----[\\s\\S]*?-----END ${PRIVATE_KEY_LABEL}-----`, 'g'),
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /(?:CIRCLE_API_KEY|RENAISS_API_KEY|RENAISS_API_SECRET|API_KEY|API_SECRET|PRIVATE_KEY|TOKEN)=([^\s]+)/gi,
  /\b(?:rsk|rk|sk|pk)_[A-Za-z0-9_-]{12,}\b/g,
]

function circleBin() {
  return process.env.CIRCLE_CLI_BIN || 'circle'
}

function sanitize(text = '') {
  let out = String(text).slice(0, MAX_OUTPUT_BYTES)
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, (match) => {
    const eq = match.indexOf('=')
    return eq > 0 ? `${match.slice(0, eq + 1)}[REDACTED]` : '[REDACTED]'
  })
  return out
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

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value || null
  return parseJsonOutput(value) || value
}

function normalizeCircleEnvelope(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, data: null, error: 'Circle CLI output is not a JSON object', envelope: null }
  const hasEnvelope = Object.prototype.hasOwnProperty.call(parsed, 'data') || Object.prototype.hasOwnProperty.call(parsed, 'success') || Object.prototype.hasOwnProperty.call(parsed, 'error')
  const ok = parsed.success === true || parsed.ok === true || (!parsed.error && !parsed.errors)
  return {
    ok,
    data: hasEnvelope ? parsed.data : parsed,
    error: parsed.error || parsed.message || (Array.isArray(parsed.errors) ? parsed.errors.join('; ') : null),
    envelope: parsed,
    cliVersion: parsed.version || parsed.cliVersion || parsed.data?.version || null,
  }
}

function networkStatus(data = {}, key) {
  const direct = data[key]
  if (direct && typeof direct === 'object') return direct
  const upper = data[key.toUpperCase()]
  if (upper && typeof upper === 'object') return upper
  const chainStatus = Array.isArray(data.chains)
    ? data.chains.find((chain) => String(chain.name || chain.network || chain.chain || '').toLowerCase() === key)
    : null
  return chainStatus || {}
}

function normalizeWalletStatus(parsed) {
  const envelope = normalizeCircleEnvelope(parsed)
  const data = envelope.data && typeof envelope.data === 'object' && !Array.isArray(envelope.data) ? envelope.data : {}
  const mainnet = networkStatus(data, 'mainnet')
  const testnet = networkStatus(data, 'testnet')
  return {
    ...envelope,
    ok: Boolean(envelope.ok && testnet.tokenStatus === 'VALID'),
    data: { ...data, mainnet, testnet },
  }
}

function circleTestnetSessionOk(status) {
  const normalized = status?.normalized || normalizeWalletStatus(status?.parsed || status)
  return Boolean(normalized?.ok === true && normalized.data?.testnet?.tokenStatus === 'VALID')
}

function normalizeWalletList(parsed) {
  const envelope = normalizeCircleEnvelope(parsed)
  const data = envelope.data && typeof envelope.data === 'object' && !Array.isArray(envelope.data) ? envelope.data : {}
  const wallets = Array.isArray(data.wallets) ? data.wallets : []
  return { ...envelope, ok: Boolean(envelope.ok && Array.isArray(data.wallets)), data: { ...data, wallets } }
}

function walletAddressOf(wallet) {
  return wallet?.address || wallet?.wallet || wallet?.walletIdAddress || wallet?.evmAddress || null
}

function circleWalletListHasAddress(walletList, expectedAddress) {
  if (!expectedAddress) return false
  const normalized = walletList?.normalized || normalizeWalletList(walletList?.parsed || walletList)
  const expected = String(expectedAddress).toLowerCase()
  return (normalized?.data?.wallets || []).some((wallet) => String(walletAddressOf(wallet) || '').toLowerCase() === expected)
}

function normalizeEstimate(parsed) {
  const envelope = normalizeCircleEnvelope(parsed)
  const data = envelope.data && typeof envelope.data === 'object' && !Array.isArray(envelope.data) ? envelope.data : {}
  // Circle CLI 0.0.6 returns the fee estimate itself, not a simulation result or
  // a canExecute/paymaster flag: { data: { blockchain, medium, ...4337Fees } }.
  // A zero exit code plus that documented shape is the only positive signal.
  const hasMediumFee = data.medium && typeof data.medium === 'object' && !Array.isArray(data.medium) &&
    ['gasLimit', 'baseFee', 'priorityFee', 'maxFee', 'networkFee']
      .some((field) => data.medium[field] !== undefined && data.medium[field] !== null && data.medium[field] !== '')
  const hasAccountAbstractionFee = ['callGasLimit', 'verificationGasLimit', 'preVerificationGas']
    .some((field) => data[field] !== undefined && data[field] !== null && data[field] !== '')
  const estimated = typeof data.blockchain === 'string' && Boolean(hasMediumFee || hasAccountAbstractionFee)
  return { ...envelope, ok: Boolean(envelope.ok && estimated), data, estimated }
}

function normalizeServicesPayResult(result) {
  const parsed = result?.parsed || parseJsonOutput(result?.stdout || '')
  const envelope = normalizeCircleEnvelope(parsed)
  const data = envelope.data && typeof envelope.data === 'object' ? envelope.data : {}
  const response = parseMaybeJson(data.response || parsed?.response || parsed)
  const sellerResponse = response && typeof response === 'object'
    ? { ...response, payment: response.payment || data.payment || parsed?.payment || null }
    : null
  return {
    ok: Boolean(envelope.ok && sellerResponse),
    sellerResponse,
    payment: sellerResponse?.payment || data.payment || parsed?.payment || null,
    envelope,
  }
}

function extractTxHash(parsed, stdout = '') {
  const candidates = [
    parsed?.txHash,
    parsed?.transactionHash,
    parsed?.transaction,
    parsed?.receipt?.transactionHash,
    parsed?.result?.txHash,
    parsed?.result?.transactionHash,
    parsed?.data?.txHash,
    parsed?.data?.transactionHash,
    parsed?.data?.transaction,
    parsed?.data?.receipt?.transactionHash,
    String(stdout).match(/0x[a-fA-F0-9]{64}/)?.[0],
  ].filter(Boolean)
  return candidates.find((value) => /^0x[a-fA-F0-9]{64}$/.test(String(value))) || null
}

function extractCircleTransactionId(parsed) {
  return parsed?.data?.id || parsed?.data?.transactionId || parsed?.id || parsed?.transactionId || parsed?.circleTransactionId || null
}

function transactionIdOf(transaction) {
  return transaction?.id || transaction?.transactionId || transaction?.circleTransactionId || null
}

function txHashOfTransaction(transaction) {
  return transaction?.txHash || transaction?.transactionHash || transaction?.hash || transaction?.receipt?.transactionHash || null
}

function normalizeTransactionList(parsed) {
  const envelope = normalizeCircleEnvelope(parsed)
  const data = envelope.data && typeof envelope.data === 'object' && !Array.isArray(envelope.data) ? envelope.data : {}
  const transactions = Array.isArray(data.transactions) ? data.transactions : []
  const nextCursor = data.nextCursor || data.next_cursor || data.pagination?.nextCursor || data.pagination?.next_cursor || parsed?.nextCursor || parsed?.next_cursor || null
  return { ...envelope, ok: Boolean(envelope.ok && Array.isArray(data.transactions)), data: { ...data, transactions, nextCursor } }
}

function normalizeVersion(stdout = '') {
  const match = String(stdout).match(/(\d+\.\d+\.\d+)/)
  return match ? match[1] : null
}

function circleCliVersionSupported(version) {
  return version === CIRCLE_CLI_VERIFIED_VERSION_RANGE
}

async function runCircle(args, { timeoutMs = 90_000 } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(circleBin(), args, {
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      env: process.env,
    })
    const clippedStdout = String(stdout || '').slice(0, MAX_OUTPUT_BYTES)
    const clippedStderr = String(stderr || '').slice(0, MAX_OUTPUT_BYTES)
    return { ok: true, stdout: clippedStdout, stderr: clippedStderr, sanitizedStderr: sanitize(clippedStderr), args: args.map((arg) => sanitize(arg)) }
  } catch (error) {
    const rawStdout = String(error.stdout || '').slice(0, MAX_OUTPUT_BYTES)
    const parsed = parseJsonOutput(rawStdout)
    if (error.code === 'ENOENT') {
      const err = new Error('Circle CLI is not installed or not on PATH')
      err.statusCode = 503
      err.code = 'circle-cli-missing'
      throw err
    }
    const message = sanitize(`${error.message}\n${rawStdout}\n${error.stderr || ''}`)
    const err = new Error(`Circle CLI failed: ${message}`)
    err.statusCode = 502
    err.code = error.killed || error.signal === 'SIGTERM' ? 'circle-cli-timeout' : (error.code || 'circle-cli-failed')
    err.exitCode = error.code
    err.stdout = sanitize(rawStdout)
    err.stderr = sanitize(error.stderr || '')
    err.parsed = parsed
    err.txHash = extractTxHash(parsed, rawStdout)
    err.circleTransactionId = extractCircleTransactionId(parsed)
    throw err
  }
}

function assertEvmAddress(value, field) {
  if (typeof value !== 'string' || !EVM_ADDRESS_RE.test(value) || /^0x0{40}$/i.test(value)) throw new Error(`${field} must be a valid non-zero EVM address`)
}

async function circleCliVersion() {
  const result = await runCircle(['--version'], { timeoutMs: 15_000 })
  const version = normalizeVersion(`${result.stdout}\n${result.stderr}`)
  return { ...result, version, supported: circleCliVersionSupported(version) }
}

async function circleWalletStatus() {
  const result = await runCircle(['wallet', 'status', '--type', 'agent', '--output', 'json'], { timeoutMs: 30_000 })
  const parsed = parseJsonOutput(result.stdout)
  return { ...result, parsed, normalized: normalizeWalletStatus(parsed) }
}

async function circleWalletList({ chain = 'ARC-TESTNET', type = 'agent' } = {}) {
  const result = await runCircle(['wallet', 'list', '--chain', chain, '--type', type, '--output', 'json'], { timeoutMs: 30_000 })
  const parsed = parseJsonOutput(result.stdout)
  return { ...result, parsed, normalized: normalizeWalletList(parsed) }
}

async function circleGatewayBalance({ address, chain = 'ARC-TESTNET' }) {
  assertEvmAddress(address, 'address')
  const result = await runCircle(['gateway', 'balance', '--address', address, '--chain', chain, '--output', 'json'], { timeoutMs: 30_000 })
  return { ...result, parsed: parseJsonOutput(result.stdout), normalized: normalizeCircleEnvelope(parseJsonOutput(result.stdout)) }
}

async function circleServicesPay({ url, address, chain = 'ARC-TESTNET', maxAmountUsdc, method = 'POST', data, timeoutSeconds = 60 }) {
  assertEvmAddress(address, 'address')
  const args = ['services', 'pay', url, '--quiet', '--address', address, '--chain', chain, '--max-amount', String(maxAmountUsdc), '--method', method, '--timeout', String(timeoutSeconds), '--output', 'json']
  if (data !== undefined) args.push('--data', JSON.stringify(data))
  const result = await runCircle(args, { timeoutMs: (timeoutSeconds + 15) * 1000 })
  const parsed = parseJsonOutput(result.stdout)
  return { ...result, parsed, servicesPay: normalizeServicesPayResult({ ...result, parsed }) }
}

async function circleWalletExecuteEstimate({ signature, params = [], contract, address, chain = 'ARC-TESTNET', rpcUrl }) {
  assertEvmAddress(contract, 'contract')
  assertEvmAddress(address, 'address')
  const args = ['wallet', 'execute', signature, ...params.map(String), '--contract', contract, '--address', address, '--chain', chain, '--estimate', '--output', 'json']
  if (rpcUrl) args.push('--rpc-url', rpcUrl)
  const result = await runCircle(args, { timeoutMs: 45_000 })
  const parsed = parseJsonOutput(result.stdout)
  return { ...result, parsed, normalized: normalizeEstimate(parsed) }
}

async function circleTransactionList({ address, chain = 'ARC-TESTNET', operation = 'execute', limit = 50, cursor = null } = {}) {
  assertEvmAddress(address, 'address')
  const args = ['transaction', 'list', '--address', address, '--chain', chain, '--operation', operation, '--limit', String(limit), '--output', 'json']
  if (cursor) args.push('--cursor', String(cursor))
  const result = await runCircle(args, { timeoutMs: 30_000 })
  const parsed = parseJsonOutput(result.stdout)
  return { ...result, parsed, normalized: normalizeTransactionList(parsed) }
}

async function findCircleExecuteTransaction({ address, transactionId, chain = 'ARC-TESTNET', limit = 50 } = {}) {
  if (!transactionId || typeof transactionId !== 'string') throw new Error('transactionId is required')
  let cursor = null
  const pages = []
  do {
    const page = await circleTransactionList({ address, chain, operation: 'execute', limit, cursor })
    const normalized = page.normalized
    pages.push({ cursor, count: normalized.data.transactions.length })
    const found = normalized.data.transactions.find((transaction) => transactionIdOf(transaction) === transactionId)
    if (found) return { found: true, transaction: found, txHash: txHashOfTransaction(found), pages, normalized }
    cursor = normalized.data.nextCursor || null
  } while (cursor)
  return { found: false, transaction: null, txHash: null, pages }
}

async function circleWalletExecute({ signature, params = [], contract, address, chain = 'ARC-TESTNET', rpcUrl, idempotencyKey }) {
  assertEvmAddress(contract, 'contract')
  assertEvmAddress(address, 'address')
  const args = ['wallet', 'execute', signature, ...params.map(String), '--contract', contract, '--address', address, '--chain', chain, '--output', 'json']
  if (idempotencyKey) args.push('--idempotency-key', String(idempotencyKey))
  if (rpcUrl) args.push('--rpc-url', rpcUrl)
  const result = await runCircle(args, { timeoutMs: 120_000 })
  const parsed = parseJsonOutput(result.stdout)
  const normalized = normalizeCircleEnvelope(parsed)
  return { ...result, parsed, normalized, txHash: extractTxHash(parsed, result.stdout), circleTransactionId: extractCircleTransactionId(parsed) }
}

module.exports = {
  CIRCLE_CLI_VERIFIED_VERSION_RANGE,
  sanitize,
  runCircle,
  parseJsonOutput,
  normalizeCircleEnvelope,
  normalizeServicesPayResult,
  normalizeWalletStatus,
  normalizeWalletList,
  normalizeEstimate,
  normalizeTransactionList,
  circleTestnetSessionOk,
  circleWalletListHasAddress,
  extractTxHash,
  extractCircleTransactionId,
  normalizeVersion,
  circleCliVersionSupported,
  circleCliVersion,
  circleWalletStatus,
  circleWalletList,
  circleGatewayBalance,
  circleServicesPay,
  circleWalletExecuteEstimate,
  circleTransactionList,
  findCircleExecuteTransaction,
  circleWalletExecute,
}
