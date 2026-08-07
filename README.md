# SlabScout

SlabScout is an Arc Agentic Economy hackathon demo: a USDC agent that reads
Renaiss OS Index card signals, buys a small MarketProof when the policy requires
more confidence, and reserves a refundable deposit through an Arc Testnet escrow.

The product is intentionally scoped to a 3-minute demo:

1. User grants one authorization: target card, max offer, min data confidence,
   MarketProof fee cap, deposit cap, and daily budget.
2. Seller agent submits a card offer.
3. Backend-only Renaiss client reads identity, FMV methods, data quality,
   recent observations, and market backdrop.
4. Deterministic policy returns `RESERVE`, `INVESTIGATE`, or `REJECT`.
5. `INVESTIGATE` buys a 0.001 USDC MarketProof through a Circle nanopayment
   adapter and hashes the proof payload.
6. If the post-proof policy passes, the Arc escrow adapter locks the demo USDC
   deposit and returns a transaction receipt.
7. The UI shows the full audit trail.

## Repository layout

```text
backend/                 Surf Studio backend runtime and API routes
frontend/                Vite + React Surf Studio frontend
packages/renaiss-client  Backend-only Renaiss API wrapper, cache, replay fallback
packages/policy-engine   Pure deterministic rule engine
packages/market-proof    Hash + signature proof builder
packages/shared          Shared demo config and utilities
contracts/               ReservationEscrow.sol and lightweight fixture
```

## Environment

Never commit real credentials. Copy the examples and fill them locally or in Surf
Studio server env settings.

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

Required backend variable:

- `BACKEND_PORT`

Optional but recommended for live mode:

- `RENAISS_API_BASE_URL`
- `RENAISS_API_KEY`
- `RENAISS_API_SECRET`
- `MARKET_PROOF_SIGNING_SECRET`
- `CIRCLE_MODE`
- `ARC_EXECUTION_MODE`
- `RESERVATION_ESCROW_ADDRESS`
- `AGENT_WALLET_ADDRESS`

The supplied Renaiss key must stay in `backend/.env` or Surf Studio server envs.
Do not create `VITE_` variables for it.

## Local development

In two terminals:

```bash
cd backend
bun install
bun run dev
```

```bash
cd frontend
bun install
bun run dev
```

If Bun is unavailable, npm can run the same package scripts after installing the
locked dependencies.

## Demo paths

- Seller A (`offer-charizard-350`) demonstrates the reserve path: Renaiss signal
  passes hard gates, `refreshing=true` / proof-required triggers MarketProof, the
  post-proof policy becomes `RESERVE`, then Arc escrow locks 0.10 USDC.
- Seller B (`offer-charizard-430`) is rejected because the ask is above the
  authorized 90% of 7-day median price.
- Seller C (`offer-low-confidence`) is rejected because identity/data quality is
  below the authorization threshold.

## API routes

- `GET /api/demo` — demo config, replay signal, and disclosures.
- `POST /api/scout/run` — full SlabScout orchestration.
- `GET /api/scout/audits` — in-memory audit trail.
- `GET /api/market-proof/quote` — proof service quote.
- `POST /api/market-proof/prove` — standalone proof generation.
- `GET /api/status` — runtime status.

## Policy V1 hard rules

- Image confidence must be `high`, or certificate lookup must be found.
- Renaiss confidence must meet the authorization minimum (`high` by default;
  `prime` passes).
- `sourceCount >= 2` and `observationCount >= 5`.
- Last completed sale must be within 14 days.
- Offer ask must be no higher than the lesser of user max price and 90% of the
  7-day median.
- Mean and VWAP must be within 15% of the median.
- MarketProof fee, deposit, and total daily spend must remain inside budget.
- `refreshing=true` never goes straight to escrow; it first triggers MarketProof.

## Security notes

- Renaiss credentials are backend-only and ignored in replay mode.
- `.env*`, private keys, logs, and build outputs are gitignored.
- Recent trade rows with `kind=listing` are explicitly excluded from MarketProof.
- Arc Testnet USDC is treated as a 6-decimal ERC-20 in the Solidity contract.
- Circle/Arc adapters default to deterministic mock receipts so the hackathon UI
  is stable. Wire real `circle services pay` and `circle wallet execute` only on
  the server after wallet envs are configured.

## Manual review loop record

See `docs/MANUAL_REVIEW_LOG.md` for the pass-by-pass source reading record. The implementation was reviewed manually across ten passes before handoff:

1. Secret handling and `.gitignore` boundaries.
2. Renaiss endpoint mapping, auth headers, timeout/retry/cache, replay fallback.
3. Policy hard-gate math and RESERVE/INVESTIGATE/REJECT separation.
4. `refreshing=true` handling and proof-before-escrow flow.
5. MarketProof hash, signature, source attribution, and listing exclusion.
6. Circle/Arc adapters and mock-vs-live disclosure boundaries.
7. Solidity escrow state transitions, amount caps, and refund path.
8. Frontend relative API routing for Surf Studio base paths.
9. UI copy: Arc Testnet/demo disclosures and Renaiss attribution.
10. End-to-end code readability, error handling, and audit trail completeness.
