const checklist = [
  'No Renaiss/Circle/private keys in tracked source files.',
  'Renaiss client is backend-only, calls /v1/graded/{cert} first in live mode, and labels non-cert live failures as REPLAY_FALLBACK.',
  'Invalid/401/404 cert lookups reject and never switch to replay fallback.',
  'Public API accepts trusted offerId only; body.offer is rejected.',
  'Live scout runs require an operator token before Renaiss/Circle/Arc work.',
  'Policy engine is deterministic and keeps policy decision separate from execution status.',
  'Listings are excluded from MarketProof transaction sample; aggregate-only source rows are labelled explicitly.',
  'MarketProof is verified by canonical hash, timing-safe HMAC, offer/cert/price/payment/mode binding, expiry, and data TTL.',
  'Payment receipts are verified structurally; status=paid is not trusted by itself.',
  'PolicyProof is separate from MarketProof and is only used when requireMarketProof=false.',
  'Replay takes priority over live Circle/Arc env and never calls a wallet.',
  'Replay/mocks never return confirmed=true, chainConfirmed=true, live tx hash, block number, or explorer evidence.',
  'Frontend uses relative API helper, not absolute /api URLs.',
  'Arc Testnet and demo/mock/replay disclosures are visible in README and UI.',
]

console.log('SlabScout manual review checklist')
for (const [idx, item] of checklist.entries()) console.log(`${idx + 1}. ${item}`)
