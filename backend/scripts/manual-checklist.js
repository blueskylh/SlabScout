const checklist = [
  'No Renaiss/Circle/private keys in tracked source files.',
  'Renaiss client is backend-only, calls /v1/graded/{cert} first in live mode, and labels non-cert live failures as REPLAY_FALLBACK.',
  'Invalid/401/404 cert lookups reject and never switch to replay fallback.',
  'Policy engine is deterministic and keeps policy decision separate from execution status.',
  'Listings are excluded from MarketProof transaction sample; aggregate-only source rows are labelled explicitly.',
  'MarketProof is verified by canonical hash, timing-safe HMAC, offer/cert/price/payment binding, expiry, and data TTL.',
  'Replay takes priority over live Circle/Arc env and never calls a wallet.',
  'Circle and Arc adapters default to deterministic mock/replay mode unless live envs are explicitly wired.',
  'Frontend uses relative API helper, not absolute /api URLs.',
  'Arc Testnet and demo/mock/replay disclosures are visible in README and UI.',
]

console.log('SlabScout manual review checklist')
for (const [idx, item] of checklist.entries()) console.log(`${idx + 1}. ${item}`)
