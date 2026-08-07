# SlabScout Submission Checklist

## Public links

- [ ] Online MVP URL: **待用户补充**
- [ ] Demo video: **待用户补充**
- [ ] Deck: `docs/PITCH_DECK.md` or exported deck link
- [x] Public repository: `https://github.com/blueskylh/SlabScout`
- [ ] GitHub Actions CI run: **push 后补充链接**

## Arc Testnet evidence

- [ ] Escrow contract address: **待部署**
- [ ] Deployment tx hash: **待部署**
- [ ] Reserve tx hash: **待 Circle Agent Wallet + Testnet USDC + deployed escrow**
- [ ] Block number: **待真实交易**
- [ ] Explorer URL: **待真实交易**
- [ ] Decoded `Reserved` event matches offerId/buyer/seller/amount/proofHash

## Circle / x402 evidence

- [ ] Circle CLI installed/logged in on backend host
- [ ] Circle Agent Wallet configured
- [ ] Arc Testnet USDC Gateway/wallet balance verified
- [ ] x402 MarketProof service URL configured
- [ ] MarketProof seller address configured
- [ ] Payment amount exactly `0.001 USDC`
- [ ] Receipt binds runId/idempotencyKey/offerId/target/payee/chain/asset/amount
- [ ] Provider status confirmed/settled

## Demo paths

- [x] Seller A: INVESTIGATE → MarketProof path → RESERVE policy
- [x] Seller B: REJECT, zero payment
- [x] Seller C: REJECT, zero payment
- [x] Invalid cert: REJECT, no fallback
- [x] Renaiss 5xx fallback: no payment, no escrow
- [x] Invalid mode/live-cache rejected before external calls
- [x] Missing or wrong live operator token rejected before external calls
- [x] Live run requires explicit idempotencyKey
- [x] Replay never displays real paid/reserved/tx evidence

## Tests and CI

- [x] Node unit tests — 56/56 passing locally, run twice consecutively
- [x] Backend/source syntax lint
- [x] Frontend ESLint
- [x] TypeScript type-check
- [x] Frontend production build
- [x] Backend smoke test script
- [x] Secret scan
- [x] Foundry project files and tests added
- [ ] Foundry tests run in local environment: **blocked here because `forge` is not installed**
- [ ] CI green after push: **待本轮 push 后 GitHub Actions run**
- [ ] Manual live E2E: readiness-only by default; spending run requires `confirm_spend=I_UNDERSTAND_SPEND_TESTNET_USDC`

## Documentation

- [x] README updated
- [x] `docs/ARCHITECTURE.md`
- [x] `docs/THREAT_MODEL.md`
- [x] `docs/DEPLOYMENT.md`
- [x] `docs/DEMO_SCRIPT.md`
- [x] `docs/PITCH_DECK.md`
- [x] `docs/SUBMISSION_CHECKLIST.md`

## Blockers before Final MVP claim

- [ ] Real Circle Agent Wallet credentials
- [ ] Funded Arc Testnet USDC wallet
- [ ] x402 MarketProof service endpoint/payee
- [ ] Deployed Arc Testnet escrow contract
- [ ] Writable single-instance `SLABSCOUT_STATE_FILE` or future database implementation
- [ ] Public deployment URL
- [ ] 3-minute video
- [ ] Real transaction/explorer evidence
