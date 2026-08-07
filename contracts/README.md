# ReservationEscrow

Minimal Arc Testnet escrow for SlabScout.

- Asset: USDC-style ERC-20 with 6 decimals.
- Functions: `reserve`, `release`, `refund`.
- Safety boundaries: max reservation amount in constructor, non-zero proof hash,
  one reservation per offer ID, timeout refund path.
- The hackathon app defaults to deterministic mock transactions unless Circle
  Agent Wallet execution is explicitly configured on the backend.
