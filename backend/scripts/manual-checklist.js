const checklist = [
  'No Renaiss/Circle/private keys in tracked source files.',
  'Renaiss client is backend-only and has replay fallback, timeout, retry, and 5 minute cache.',
  'Policy engine is deterministic and keeps RESERVE/INVESTIGATE/REJECT separate.',
  'Listings are excluded from MarketProof transaction sample.',
  'Refreshing Renaiss data triggers MarketProof before any escrow reservation.',
  'Circle and Arc adapters default to deterministic mock mode unless live envs are explicitly wired.',
  'Frontend uses relative API helper, not absolute /api URLs.',
  'Arc Testnet and demo/mock disclosures are visible in README and UI.',
]

console.log('SlabScout manual review checklist')
for (const [idx, item] of checklist.entries()) console.log(`${idx + 1}. ${item}`)
