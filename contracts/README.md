# ReservationEscrow

Arc Testnet escrow for SlabScout refundable deposits. It only locks the demo deposit and never pays the full physical card price.

- Asset: Arc Testnet USDC, 6 decimals, expected address `0x3600000000000000000000000000000000000000`.
- Default cap for deployment: `100_000` minor units = `0.10 USDC`.
- Functions: `reserve`, `release`, `refund`.
- Safety boundaries: max reservation amount, non-zero offer/proof/seller, seller cannot equal buyer, one reservation per offer ID, timeout refund path, SafeERC20-style false-return checks.
- Replay/mock adapters must not display `chainConfirmed=true`, tx hashes, block numbers, or explorer links.

## Local contract checks

```bash
cd contracts
forge build
forge test -vvv
```

## Deployment

Deployment script: `script/DeployReservationEscrow.s.sol`.

Required environment:

```bash
ARC_USDC_ADDRESS=0x3600000000000000000000000000000000000000
MAX_RESERVATION_AMOUNT_USDC_6_DECIMALS=100000
```

The deploy script requires `block.chainid == 5042002` and rejects any other chain.
