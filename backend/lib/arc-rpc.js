const { encodeFunctionData, decodeFunctionResult, parseAbi, parseEventLogs, getAddress } = require('viem')
const { ARC_TESTNET_CHAIN_ID, ARC_TESTNET_USDC_ADDRESS } = require('../packages/shared')

const RPC_URL = 'https://rpc.testnet.arc.network'
const ERC20_ABI = parseAbi([
  'function allowance(address owner,address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
])
const ESCROW_ABI = parseAbi([
  'function reservations(bytes32 offerId) view returns (address buyer,address seller,uint256 amount,bytes32 proofHash,uint64 refundAfter,uint8 status)',
  'function usdc() view returns (address)',
  'function maxReservationAmount() view returns (uint256)',
  'event Reserved(bytes32 indexed offerId,address indexed buyer,address indexed seller,uint256 amount,bytes32 proofHash,uint64 refundAfter)',
])

async function rpc(method, params, { rpcUrl = process.env.ARC_RPC_URL || RPC_URL } = {}) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = await response.json()
  if (!response.ok || body.error) throw new Error(`Arc RPC ${method} failed: ${body.error?.message || response.status}`)
  return body.result
}

async function assertArcChain({ rpcUrl } = {}) {
  const chainIdHex = await rpc('eth_chainId', [], { rpcUrl })
  const chainId = Number(BigInt(chainIdHex))
  if (chainId !== ARC_TESTNET_CHAIN_ID) throw new Error(`Arc RPC chainId mismatch: ${chainId}`)
  return chainId
}

async function ethCall({ to, data, rpcUrl }) {
  return rpc('eth_call', [{ to, data }, 'latest'], { rpcUrl })
}

async function getAllowance({ owner, spender, token = ARC_TESTNET_USDC_ADDRESS, rpcUrl }) {
  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'allowance', args: [owner, spender] })
  const result = await ethCall({ to: token, data, rpcUrl })
  return decodeFunctionResult({ abi: ERC20_ABI, functionName: 'allowance', data: result })
}

async function getTokenBalance({ owner, token = ARC_TESTNET_USDC_ADDRESS, rpcUrl }) {
  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] })
  const result = await ethCall({ to: token, data, rpcUrl })
  return decodeFunctionResult({ abi: ERC20_ABI, functionName: 'balanceOf', data: result })
}

async function getReservation({ escrow, offerHash, rpcUrl }) {
  const data = encodeFunctionData({ abi: ESCROW_ABI, functionName: 'reservations', args: [offerHash] })
  const result = await ethCall({ to: escrow, data, rpcUrl })
  const decoded = decodeFunctionResult({ abi: ESCROW_ABI, functionName: 'reservations', data: result })
  return { buyer: decoded[0], seller: decoded[1], amount: decoded[2], proofHash: decoded[3], refundAfter: decoded[4], status: Number(decoded[5]) }
}

async function getEscrowUsdc({ escrow, rpcUrl }) {
  const data = encodeFunctionData({ abi: ESCROW_ABI, functionName: 'usdc' })
  const result = await ethCall({ to: escrow, data, rpcUrl })
  return decodeFunctionResult({ abi: ESCROW_ABI, functionName: 'usdc', data: result })
}

async function getEscrowMaxReservationAmount({ escrow, rpcUrl }) {
  const data = encodeFunctionData({ abi: ESCROW_ABI, functionName: 'maxReservationAmount' })
  const result = await ethCall({ to: escrow, data, rpcUrl })
  return decodeFunctionResult({ abi: ESCROW_ABI, functionName: 'maxReservationAmount', data: result })
}

async function getCode({ address, rpcUrl }) {
  return rpc('eth_getCode', [address, 'latest'], { rpcUrl })
}

async function getNativeBalance({ address, rpcUrl }) {
  const result = await rpc('eth_getBalance', [address, 'latest'], { rpcUrl })
  return BigInt(result)
}

async function getTransactionReceipt(txHash, { rpcUrl } = {}) {
  return rpc('eth_getTransactionReceipt', [txHash], { rpcUrl })
}

async function waitForReceipt(txHash, { rpcUrl, timeoutMs = 120_000, intervalMs = 3_000 } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const receipt = await rpc('eth_getTransactionReceipt', [txHash], { rpcUrl })
    if (receipt) return receipt
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`Timed out waiting for Arc receipt ${txHash}`)
}

function normalizeAddress(value) {
  return getAddress(value).toLowerCase()
}

function validateReservedEvent({ receipt, offerHash, buyer, seller, amountMinor, proofHash, refundAfter }) {
  if (!receipt || receipt.status !== '0x1') throw new Error('Arc transaction reverted or receipt missing')
  const logs = parseEventLogs({ abi: ESCROW_ABI, logs: receipt.logs || [], eventName: 'Reserved' })
  const expectedAmount = BigInt(amountMinor)
  const expectedRefundAfter = BigInt(refundAfter)
  const match = logs.find((log) => (
    String(log.args.offerId).toLowerCase() === String(offerHash).toLowerCase() &&
    normalizeAddress(log.args.buyer) === normalizeAddress(buyer) &&
    normalizeAddress(log.args.seller) === normalizeAddress(seller) &&
    BigInt(log.args.amount) === expectedAmount &&
    String(log.args.proofHash).toLowerCase() === String(proofHash).toLowerCase() &&
    BigInt(log.args.refundAfter) === expectedRefundAfter
  ))
  if (!match) throw new Error('Reserved event missing or fields mismatch')
  return match
}

module.exports = {
  RPC_URL,
  assertArcChain,
  getAllowance,
  getTokenBalance,
  getReservation,
  getEscrowUsdc,
  getEscrowMaxReservationAmount,
  getCode,
  getNativeBalance,
  getTransactionReceipt,
  waitForReceipt,
  validateReservedEvent,
}
