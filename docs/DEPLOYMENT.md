# SlabScout Deployment Guide

## Required runtime boundaries

SlabScout must run only on Arc Testnet for any on-chain action.

```bash
ARC_CHAIN_ID=5042002
ARC_USDC_ADDRESS=0x3600000000000000000000000000000000000000
MARKET_PROOF_PRICE_USDC=0.001
```

Never put secrets in frontend `VITE_` variables, README, tests, logs, or fixtures.

## Backend environment

Required for all deployments:

```bash
BACKEND_PORT=3001
SLABSCOUT_DEFAULT_MODE=replay
RENAISS_API_BASE_URL=https://api.renaissos.com
RENAISS_API_KEY=<server secret>
RENAISS_API_SECRET=<server secret>
MARKET_PROOF_SIGNING_SECRET=<non-default server secret>
POLICY_PROOF_SIGNING_SECRET=<non-default server secret>
SLABSCOUT_OPERATOR_TOKEN=<operator token for live mode>
SLABSCOUT_STATE_FILE=/var/lib/slabscout/state.json
```

Live Circle/x402 readiness:

```bash
CIRCLE_MODE=live
CIRCLE_API_KEY=<server secret>
CIRCLE_AGENT_WALLET_ADDRESS=<Arc Testnet wallet>
MARKET_PROOF_SERVICE_URL=<x402 service URL>
MARKET_PROOF_PAYEE=<service/payee id>
```

Live Arc escrow readiness:

```bash
ARC_EXECUTION_MODE=live
AGENT_WALLET_ADDRESS=<Arc Testnet wallet>
RESERVATION_ESCROW_ADDRESS=<deployed escrow contract>
SELLER_WALLET_ADDRESS=<seller testnet address>
```

If any live variable is missing, backend returns `live-unavailable/config-missing` or rejects unauthorized live requests. It must not silently mock success.

## Frontend environment

```bash
BASE_PATH=/
BACKEND_PORT=3001
```

The operator token, if used in a demo, is typed at runtime and kept only in browser memory. It is sent as `x-slabscout-operator-token` over HTTPS.

## Contract deployment

Install Foundry, then:

```bash
cd contracts
forge build
forge test -vvv
```

Deploy only on Arc Testnet:

```bash
ARC_USDC_ADDRESS=0x3600000000000000000000000000000000000000 \
MAX_RESERVATION_AMOUNT_USDC_6_DECIMALS=100000 \
forge script script/DeployReservationEscrow.s.sol \
  --rpc-url <ARC_TESTNET_RPC_URL> \
  --private-key <DEPLOYER_PRIVATE_KEY_FROM_SECRET_MANAGER> \
  --broadcast
```

Record after deployment:

- contract address
- deployment tx hash
- block number
- explorer URL

Do not deploy on mainnet. The script checks `block.chainid == 5042002` and USDC address.

## Circle Agent Wallet / x402 flow

The production adapter must use official Circle server-side SDK/API/Agent Stack and must not shell out to CLI as a production dependency. Required behavior:

1. Query Agent Wallet address and Arc Testnet USDC balance.
2. Request MarketProof service and parse 402 requirements.
3. Compare amount/asset/chain/payee with authorization.
4. Submit payment with idempotency key.
5. Re-confirm provider status and tx/receipt.
6. Re-request MarketProof after payment.
7. Verify proof before escrow.

Current repository fails closed until these credentials and final adapter methods are configured.

## Verification checklist

```bash
npm --prefix backend ci --no-audit --no-fund
npm --prefix frontend ci --no-audit --no-fund
npm run secret-scan
npm test
npm run lint
npm --prefix frontend run lint
npm run type-check
BACKEND_PORT=3001 BASE_PATH=/ npm run build
BACKEND_PORT=3001 BASE_PATH=/ npm run smoke:backend
cd contracts && forge build && forge test -vvv
```

## Deployment smoke

- `GET /api/status` returns 200 and lists missing live env if any.
- `GET /api/demo` returns 200.
- Replay `POST /api/scout/run` with `offer-reshizard-95` returns policy `RESERVE` and execution `replay-simulated`.
- Unknown offer returns 400.
- Live run without operator token returns 401/403 before Renaiss/Circle/Arc.
