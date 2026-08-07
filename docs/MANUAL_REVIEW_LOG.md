# SlabScout manual review log

The requested review loop was performed as source-reading passes, not as a substitute for runtime tests. Each pass had a distinct objective and triggered fixes where needed.

1. **Secret boundary pass** — verified no provided Renaiss key, API secret, or SSH private key is written into source; added `.gitignore` and env examples with placeholders only.
2. **Renaiss API pass** — checked OpenAPI-derived endpoint usage and backend-only headers for `/v1/cards`, `/trades`, `/fmv-series`, and `/indices`; documented mappings in `docs/OPENAPI_NOTES.md`.
3. **Replay/live data pass** — read `packages/renaiss-client` for timeout, retry, cache, fallback, and normalized fields; ensured replay responses are explicitly marked.
4. **Policy math pass** — read `packages/policy-engine` line by line for confidence ranking, source/sample thresholds, last-sale age, offer discount, method deviation, and budget limits.
5. **Refresh/proof pass** — verified `refreshing=true` and `requireMarketProof=true` produce `INVESTIGATE` first and only become `RESERVE` after proof hash exists.
6. **Nanopayment pass** — read `backend/lib/circle-adapters.js` and `packages/market-proof`; made non-paid live-adapter status block escrow instead of pretending payment succeeded.
7. **Escrow contract pass** — read `contracts/ReservationEscrow.sol`; added `InvalidRefundTime` guard and confirmed state changes happen before transfers on release/refund.
8. **Frontend flow pass** — read `App.tsx` and every SlabScout component; checked mode toggle, offer selection, auth edits, timeline, proof, escrow, audit, and disclosure display.
9. **Surf Studio routing pass** — read `frontend/src/lib/api.ts`, `vite.config.ts`, and `index.html`; kept relative API routing for non-root base paths and updated title/lang.
10. **Final consistency pass** — re-read changed backend/packages/frontend/contract files, checked placeholder addresses are valid-looking EVM addresses, and re-ran a source secret search plus JS syntax parsing.

Supplementary smoke validation after the manual passes confirmed the replay reserve branch returns `RESERVE` with proof + escrow, while the overpriced and low-confidence branches return `REJECT` without proof or escrow.

## Second manual review loop

A second requested source-reading loop was performed without using runtime checks as the review mechanism. Fixes from this loop are reflected in the current code.

1. **Shared config pass** — re-read demo authorization, offers, confidence rank, money helpers, and stable JSON; confirmed placeholder addresses are valid-looking EVM addresses and no secrets are present.
2. **Replay fixture pass** — re-read Renaiss-shaped card detail, FMV series, trades, and index fixture; confirmed transaction rows and listing rows remain distinguishable.
3. **Renaiss client pass** — re-read config, cache, timeout, fetch, normalization, Live/Replay fallback; fixed non-`Error` fallback message handling.
4. **Policy engine pass** — re-read every hard gate; added finite/positive numeric guards and an explicit `valuation-present` hard gate so missing median/mean/VWAP cannot slip through price checks.
5. **MarketProof pass** — re-read proof payload, hash, signature, and outlier logic; confirmed listings are still excluded from completed-trade sample.
6. **Agent orchestration pass** — re-read authorization merge, offer selection, timeline, proof-before-escrow, and audit creation; hardened null/invalid authorization handling and live-payment block behavior.
7. **Payment/escrow adapter pass** — re-read Circle/Arc adapters; added positive-number validation for MarketProof fee, deposit, chain ID fallback, and proof-hash requirement before escrow.
8. **Backend route pass** — re-read demo, scout, market-proof, status routes; made standalone MarketProof route return a payment-required response instead of issuing proof when payment is not actually `paid`.
9. **Frontend UX pass** — re-read App and every SlabScout component; fixed stale result display when mode/offer/auth changes, safer API error parsing, cleaner null percentage rendering, safer date label, and receipt display in timeline.
10. **Contract/docs/env pass** — re-read escrow contract, env examples, README, API notes, and this log; confirmed Arc Testnet/mock boundaries are documented and kept real credentials out of tracked files.

## P0-A implementation pass

After the MVP specification review, P0-A was implemented and source-reviewed:

- Arc constants were corrected to chain ID `5042002` and USDC `0x3600000000000000000000000000000000000000`.
- Renaiss trade lookup was changed to `scope=grade`; trade normalization now prefers `observedAt`, and replay/MarketProof samples expose transaction rows separately from listings.
- Certificate lookup normalization was added, including `found`, card name, grade label, observed timestamp, and target-card match checks.
- Offer and authorization validation now covers target card, cert number, expiry, confidence enums, numeric bounds, and EVM seller address format.
- Live mode now rejects the built-in MarketProof signing secret.
- Mock adapters no longer fabricate live transaction hashes. Replay receipts are labelled as replay fixtures and do not include live explorer URLs.
- Node tests with assertions were added under `tests/p0a.test.js`.

Known boundary: Circle/Arc live execution is intentionally adapter-gated. The default replay path uses labelled replay confirmations until server-side Circle Agent Wallet credentials, real payment receipt verification, deployed escrow address, and Arc Testnet transaction confirmation are configured.

## P0-A.1 correctness pass

This pass was limited to the requested correctness fixes and intentionally did not integrate real Circle payment or live Arc escrow execution.

1. **Structural identity pass** — replaced the fake demo cert with real PSA cert `80396943`, added target item/href fields, and re-read authorization/offer/cert/detail matching so mismatched cards reject before payment.
2. **Renaiss semantics pass** — re-read live client flow to ensure `/v1/graded/{cert}` is requested first, terminal cert errors (`400/401/404`) become hard rejects instead of replay fallback, source timestamps are split, and trade samples are either transaction-backed or explicitly `aggregate-only`.
3. **Proof verification pass** — re-read MarketProof payload construction and added canonical-payload hash reconstruction, full 32-byte hash validation, timing-safe HMAC comparison, and offer/cert/price/payment/TTL binding checks.
4. **Policy/budget pass** — re-read hard gates and budget math; `requireMarketProof=false` no longer budgets the 0.001 USDC intel fee, and `finalizeWithProof` only accepts verified proofs.
5. **State-machine pass** — re-read orchestration and adapters so replay takes priority over live Circle/Arc env, `REPLAY_FALLBACK` blocks real payment, unknown offers do not fall back to Seller A, and replay execution status is not displayed as real success.
6. **Config/docs/CI pass** — re-read runtime validation, env examples, README copy, Circle CLI syntax, and added GitHub Actions coverage for test/lint/type-check/build.

## Final MVP hardening pass

This pass implemented all safety work that does not require external Circle credentials, funded Arc Testnet wallet, live x402 service, deployed escrow address, or production database.

1. **Proof trust-boundary pass** — re-read MarketProof, PolicyProof, policy finalize, and escrow adapter code. `verified`/`verification.ok` are now display-only fields; execution boundaries recompute canonical hashes, HMAC signatures, mode, offer/cert/payment/TTL bindings.
2. **Payment trust-boundary pass** — replay payments now use `simulated/replayAccepted` with `confirmed=false`; the verifier rejects `status=paid` without provider confirmation and full receipt binding.
3. **Public API pass** — `/api/scout/run` rejects arbitrary `body.offer`, uses trusted offer IDs only, adds live operator-token protection, and rate-limits requests.
4. **Renaiss data pass** — source freshness no longer uses cert lookup time as market data freshness; fallback remains explicitly blocked from payment and escrow.
5. **State/idempotency pass** — added server-side state store for idempotency, budget holds, payment/proof/reservation records, and fail-closed live persistence checks.
6. **Frontend truthfulness pass** — split MarketProof and PolicyProof display, fixed Seller B color logic, removed default INVESTIGATE before run, and kept replay/confirmed states distinct.
7. **Contract pass** — converted the Solidity fixture into a Foundry project with SafeERC20-style transfer checks, deployment script, and coverage for reserve/release/refund failure modes.
8. **CI/docs pass** — added backend smoke, secret scan, Foundry CI steps, manual live workflow, and the architecture/threat/deployment/demo/deck/submission docs.

Known boundary: real Circle Agent Wallet/x402 and real Arc reserve remain fail-closed until external credentials, Testnet USDC, a deployed escrow address, and persistent production state are provided.
