# SlabScout

[![CI](https://github.com/blueskylh/SlabScout/actions/workflows/ci.yml/badge.svg)](https://github.com/blueskylh/SlabScout/actions/workflows/ci.yml)

| Submission item | Status |
|---|---|
| Online MVP URL | **待用户补充** |
| Demo video | **待用户补充** |
| Deck | `docs/PITCH_DECK.md` |
| Arc Testnet contract | **待部署后补充** |
| Example Circle/Arc tx | **待真实 Testnet 执行后补充** |
| CI | GitHub Actions configured; link above |

SlabScout is an Arc Agentic Economy hackathon project: a bounded USDC agent that reads Renaiss OS Index card signals, makes deterministic policy decisions, pays for MarketProof only when authorized, and then reserves a refundable Arc Testnet escrow deposit only after proof verification.

The product is intentionally scoped to a 3-minute MVP demo. It does **not** buy a physical card and does **not** pay the full card price. Real-fund scope is capped to:

- MarketProof: max `0.001 USDC`.
- Escrow deposit: max `0.10 USDC`.
- Chain: Arc Testnet only, chain ID `5042002`.

## Repository layout

```text
backend/                 Surf Studio backend runtime and API routes
frontend/                Vite + React Surf Studio frontend
packages/renaiss-client  Backend-only Renaiss API wrapper, cache, cert-first live flow
packages/policy-engine   Pure deterministic rule engine
packages/market-proof    MarketProof / PolicyProof builders and verifiers
packages/shared          Shared constants, demo allowlist, validation
contracts/               Foundry ReservationEscrow project and tests
scripts/                 CI smoke / lint / secret scan helpers
docs/                    Architecture, threat model, deployment, demo, deck, checklist
```

## Current implementation status

Implemented after baseline `c14a5b4`:

- Real demo identity: PSA cert `80396943`, itemId `6e7fdc9a-8054-4034-bc02-8fb64209c688`, href `/card/pokemon/tag-all-stars/16-reshiram-charizard-gx-psa-10-japanese-6e7fdc9a`.
- Live Renaiss mode is cert-first and treats returned `itemId` + `card.href` as identity truth.
- `400 / 401 / 404` cert errors are hard `REJECT`, not replay fallback.
- Network/5xx Renaiss fallback is `REPLAY_FALLBACK` and blocks payment/proof/escrow.
- Public `/api/scout/run` accepts only trusted `offerId`; `body.offer` is rejected.
- Live `/api/scout/run` requires an operator token with timing-safe comparison before any paid/live action.
- MarketProof verifier ignores caller-supplied `verified` / `verification.ok`; it recalculates canonical hash, HMAC, offer/cert/payment/TTL/mode bindings.
- Payment verifier rejects `status=paid` unless provider confirmation, receipt/tx, chain, asset, payer/payee, idempotency and amount bindings pass.
- Replay payment uses `replay-payment-simulated`, `confirmed=false`, `simulated=true`; replay escrow uses `chainConfirmed=false` and no tx/explorer evidence.
- `requireMarketProof=false` uses independent `PolicyProof`, not MarketProof.
- Server-side state store covers idempotency, payment/proof/reservation records and budget holds. Live execution fails closed if persistent state is not configured.
- Foundry contract project, deployment script and escrow tests were added.
- CI includes deterministic frontend/backend install, Node tests, lint, frontend checks, build, backend smoke, Foundry build/test and secret scan.

Not yet complete because external credentials/funds/deployment are missing:

- Real Circle Agent Wallet/x402 payment adapter is fail-closed until Circle credentials, wallet, x402 MarketProof service and Testnet USDC are provided.
- Real Arc escrow reserve execution is fail-closed until the escrow contract is deployed and Agent Wallet approve/reserve execution is configured.
- Public MVP URL, video, deck export link and real tx evidence are pending user/deployment steps.

## Demo paths

- Seller A (`offer-reshizard-95`): compliant discount path. Replay shows `INVESTIGATE → simulated MarketProof → RESERVE policy → replay escrow simulation` without fake paid/tx evidence.
- Seller B (`offer-reshizard-120`): overpriced path. `REJECT`, zero payment.
- Seller C (`offer-low-confidence`): weak data/identity-quality path. `REJECT`, zero payment.

## Environment

Never commit real credentials. Copy examples and configure secrets only in backend/deployment env.

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

Required for local replay:

- `BACKEND_PORT`

Required for live readiness:

- `SLABSCOUT_OPERATOR_TOKEN`
- `SLABSCOUT_STATE_FILE` or `DATABASE_URL`
- `RENAISS_API_KEY` / `RENAISS_API_SECRET`
- `MARKET_PROOF_SIGNING_SECRET` / `POLICY_PROOF_SIGNING_SECRET`
- `CIRCLE_API_KEY`, Agent Wallet address, x402 MarketProof service/payee
- `RESERVATION_ESCROW_ADDRESS`, `AGENT_WALLET_ADDRESS`

Renaiss and Circle secrets must remain backend-only. Do not create `VITE_` variables for them.

## Local development

```bash
npm --prefix backend ci --no-audit --no-fund
npm --prefix frontend ci --no-audit --no-fund
```

Backend:

```bash
cd backend
npm run dev
```

Frontend:

```bash
cd frontend
npm run dev
```

## Checks

```bash
npm run secret-scan
npm test
npm run lint
npm --prefix frontend run lint
npm run type-check
BACKEND_PORT=3001 BASE_PATH=/ npm run build
BACKEND_PORT=3001 BASE_PATH=/ npm run smoke:backend
cd contracts && forge build && forge test -vvv
```

This execution environment does not have `forge` installed; contract tests are configured for CI / local Foundry environments.

## API routes

- `GET /api/status` — runtime status and missing live env list.
- `GET /api/demo` — trusted offers, default authorization, replay signal, disclosures.
- `POST /api/scout/run` — full orchestration. Public replay; live requires `x-slabscout-operator-token`.
- `GET /api/scout/audits` — audit trail.
- `GET /api/market-proof/quote` — proof service quote.
- `POST /api/market-proof/prove` — server-refetch proof generation; rejects client-submitted signal/valuation/trades.

## Contract

`contracts/ReservationEscrow.sol` locks a refundable Arc Testnet USDC deposit with SafeERC20-style transfer checks. The deploy script rejects non-Arc-Testnet chain IDs and wrong USDC address.

## Docs

- `docs/ARCHITECTURE.md`
- `docs/THREAT_MODEL.md`
- `docs/DEPLOYMENT.md`
- `docs/DEMO_SCRIPT.md`
- `docs/PITCH_DECK.md`
- `docs/SUBMISSION_CHECKLIST.md`
- `docs/OPENAPI_NOTES.md`
- `docs/MANUAL_REVIEW_LOG.md`

## Security notes

- Replay/mock never returns real `paid`, `reserved`, tx hash, block number, or explorer evidence.
- Live mode fails closed when operator token, persistent state, Circle config, Renaiss secrets, escrow address, wallet, or Arc Testnet checks are missing.
- Secret scan blocks committed Renaiss/Circle/private keys.
- Mainnet is not supported.
