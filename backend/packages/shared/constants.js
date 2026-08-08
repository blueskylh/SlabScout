const ARC_TESTNET_CHAIN_ID = 5042002
const ARC_TESTNET_USDC_ADDRESS = '0x3600000000000000000000000000000000000000'
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const DEFAULT_MARKET_PROOF_PRICE_USDC = 0.001
const DEFAULT_ESCROW_DEPOSIT_USDC = 0.1
const MAX_MARKET_PROOF_FEE_USDC = 0.001
const MAX_ESCROW_DEPOSIT_USDC = 0.1
const ARC_TESTNET_NAME = 'Arc Testnet'

const DEMO_TARGET = Object.freeze({
  certNumber: '80396943',
  targetItemId: '6e7fdc9a-8054-4034-bc02-8fb64209c688',
  targetRenaissItemId: '81d9d2d5-9adf-4f16-9bae-7fafabcce4ae',
  targetHref: '/card/pokemon/tag-all-stars/16-reshiram-charizard-gx-psa-10-japanese-6e7fdc9a',
  targetCard: 'Reshiram & Charizard-GX · Tag All Stars · Japanese · PSA 10',
  company: 'PSA',
  gradeLabel: 'PSA 10',
})

const DATA_MODES = Object.freeze(['replay', 'live'])
const EXECUTION_MODES = Object.freeze(['mock', 'live'])
const CONFIDENCE_LEVELS = Object.freeze(['none', 'low', 'medium', 'high', 'prime'])
const PROOF_HASH_RE = /^0x[a-fA-F0-9]{64}$/
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

module.exports = {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_USDC_ADDRESS,
  ZERO_ADDRESS,
  DEFAULT_MARKET_PROOF_PRICE_USDC,
  DEFAULT_ESCROW_DEPOSIT_USDC,
  MAX_MARKET_PROOF_FEE_USDC,
  MAX_ESCROW_DEPOSIT_USDC,
  ARC_TESTNET_NAME,
  DEMO_TARGET,
  DATA_MODES,
  EXECUTION_MODES,
  CONFIDENCE_LEVELS,
  PROOF_HASH_RE,
  EVM_ADDRESS_RE,
}
