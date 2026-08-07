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

`SLABSCOUT_STATE_FILE` is required for live execution. The current MVP state backend is a single-instance JSON file with an in-process write queue; do not run multiple live backend writers against the same file. `DATABASE_URL` is intentionally not treated as implemented persistence in this branch.

Live Circle Agent Wallet / x402 readiness:

```bash
CIRCLE_MODE=live
CIRCLE_CLI_BIN=circle
CIRCLE_CLI_TIMEOUT_SECONDS=60
CIRCLE_AGENT_WALLET_ADDRESS=<Arc Testnet agent wallet>
MARKET_PROOF_SERVICE_URL=<public https URL for /api/market-proof/prove>
MARKET_PROOF_SELLER_ADDRESS=<seller wallet receiving x402 payments>
CIRCLE_GATEWAY_FACILITATOR_URL=https://gateway-api-testnet.circle.com
```

The Circle CLI must be installed on the backend host and already authenticated to the intended testnet Agent Wallet context. The app invokes the CLI through `execFile` with argument arrays, not shell string concatenation. The parser is verified against Circle CLI `0.0.6` JSON envelopes and parses raw stdout before sanitizing error/log output.

Live Arc escrow readiness:

```bash
ARC_EXECUTION_MODE=live
ARC_RPC_URL=https://rpc.testnet.arc.network
AGENT_WALLET_ADDRESS=<same funded Arc Testnet agent wallet>
RESERVATION_ESCROW_ADDRESS=<deployed escrow contract>
SELLER_WALLET_ADDRESS=<seller testnet address>
ESCROW_REFUND_AFTER_SECONDS=604800
```

If any live variable is missing, backend returns `live-unavailable/config-missing`, `live-unavailable/circle-cli-missing`, or `reconciliation_required`, and must not silently mock success.

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

Live MarketProof payment uses Circle Gateway nanopayments / x402 seller middleware:

1. `/api/scout/run` verifies live operator auth and claims `idempotencyKey` before any external call.
2. The buyer side calls Circle CLI: `circle services pay <MARKET_PROOF_SERVICE_URL> --address <CIRCLE_AGENT_WALLET_ADDRESS> --chain ARC-TESTNET --max-amount 0.001 ...`.
3. `/api/market-proof/prove` is protected by `createGatewayMiddleware` from `@circle-fin/x402-batching/server`, restricted to `eip155:5042002`.
4. After the gateway verifies/settles payment, the seller endpoint refetches Renaiss data server-side and signs MarketProof.
5. The buyer side re-verifies the returned payment receipt and MarketProof before escrow.

Any unknown Circle CLI result or submitted transaction receipt timeout enters `reconciliation_required`; operators must reconcile externally before retrying with a new idempotency key. Budget holds remain marked as reconciliation-held rather than released as ordinary failures.

## Arc escrow flow

Live reserve uses Circle CLI wallet execution plus Arc RPC verification:

1. Verify MarketProof or PolicyProof at the escrow boundary.
2. Check Arc RPC chain ID is `5042002`.
3. Check whether the offerHash is already reserved; if yes, return `reconciliation_required` instead of sending a duplicate tx.
4. Check USDC allowance from Agent Wallet to `ReservationEscrow`.
5. If allowance is insufficient, call `approve(address,uint256)` through Circle CLI and wait for the tx receipt.
6. Call `reserve(bytes32,address,uint256,bytes32,uint64)` through Circle CLI with external idempotency key `<run-id>:reserve:<offer-hash>`. Approval uses `<run-id>:approve:<offer-hash>`.
7. Wait for the reserve receipt and decode the `Reserved` event.
8. Mark `chain-confirmed` only if receipt status and every event field match the expected offerHash, buyer, seller, amount, proofHash and refundAfter.

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

## Manual live E2E

GitHub workflow `Live E2E (manual, secrets-gated)` runs readiness only by default. It spends testnet USDC only when manually dispatched with `confirm_spend=I_UNDERSTAND_SPEND_TESTNET_USDC` and all live secrets are configured. The script emits payment ID, proof hash, escrow tx hash, block and explorer evidence only if the deployed API returns `chain-confirmed`.

## Deployment smoke

- `GET /api/status` returns 200 and lists missing live env if any.
- `GET /api/demo` returns 200.
- Replay `POST /api/scout/run` with `offer-reshizard-95` returns policy `RESERVE` and execution `replay-simulated`.
- Unknown offer returns 400.
- `body.offer` returns 400.
- Invalid mode such as `live-cache` returns 400 before external calls.
- Live run without operator token returns 401/403 before Renaiss/Circle/Arc.
- Live run without explicit `idempotencyKey` returns 400 before Renaiss/Circle/Arc.
