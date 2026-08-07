# SlabScout Pitch Deck Content

## 1. Problem

Autonomous agents are about to participate in high-friction markets, but they cannot safely spend user funds based on seller claims or stale web pages. Collectible cards are a compact example: identity, grade, recent sales, and market context must be verified before money moves.

## 2. Why agents need paid intelligence

Free data is often incomplete, delayed, or unverifiable. A useful wallet agent needs to buy small pieces of intelligence, bind that intelligence to the exact transaction, and prove that the spend stayed inside user authorization.

## 3. Product

SlabScout is a USDC agent for graded card deal screening. It does not buy the physical card or pay the full price. It only:

- pays up to `0.001 USDC` for MarketProof;
- locks up to `0.10 USDC` refundable deposit in Arc Testnet escrow;
- rejects overpriced, low-quality, invalid-cert, fallback, and unauthorized flows.

## 4. Architecture

Authorization → trusted offer store → Renaiss cert-first identity → card/FMVs/trades → deterministic policy → Circle/x402 MarketProof payment → proof verifier → Arc escrow → persistent audit.

Key security principle: every spend boundary re-verifies inputs. UI display fields like `verified` or `paid` are never trusted.

## 5. Renaiss integration

Current target:

- PSA cert: `80396943`
- itemId: `6e7fdc9a-8054-4034-bc02-8fb64209c688`
- href: `/card/pokemon/tag-all-stars/16-reshiram-charizard-gx-psa-10-japanese-6e7fdc9a`

Live mode calls `/v1/graded/{cert}` first, then card detail, FMV series, and grade-scoped trades. Listings are excluded from transaction samples; aggregate-only data is labelled.

## 6. Circle / Arc programmable money flow

Circle/x402 payment is the paid intelligence step. The agent must bind runId, idempotencyKey, offerId, payer, payee, chain, USDC address, amount, provider confirmation, Circle payment ID or tx hash, and paidAt.

Arc escrow is the commitment step. The contract locks a capped refundable USDC deposit and emits a `Reserved` event. UI only displays chain-confirmed after a real tx receipt and event match.

## 7. Demo evidence

Three paths:

1. Seller A discount: INVESTIGATE → simulated/verified MarketProof path → RESERVE policy → simulated escrow in replay.
2. Seller B overpriced: REJECT, zero payment.
3. Seller C low quality: REJECT, zero payment.

Live evidence placeholders to fill after deployment: Circle payment ID/tx, MarketProof hash, Arc tx hash, block, contract, explorer URL.

## 8. Security and risk controls

- Public API rejects arbitrary offer payloads.
- Operator token required for live mode.
- No mainnet: chainId and USDC address are hard-checked.
- Replay never returns `confirmed=true` or `chainConfirmed=true`.
- MarketProof and PolicyProof are separate.
- Idempotency and budget state prevent duplicate spend.
- Secret scan in CI blocks committed API keys/private keys.

## 9. Market / roadmap

Start with collectible slabs because identity and appraisal are clear. Extend to other agent-purchased intelligence markets:

- token-gated research proofs;
- insurance/escrow pre-checks;
- authenticated appraisal APIs;
- small paid oracle results;
- cross-agent service purchases.

Roadmap: real Circle Agent Wallet adapter, deployed Arc escrow, seller EIP-712 offers, database-backed authorization dashboard, multiple card categories.

## 10. Team / ask

Ask: Arc/Circle credits, Testnet liquidity, x402 service support, and Renaiss API production access to finish live evidence and publish the MVP URL/video.
