# Renaiss API notes used by SlabScout

OpenAPI source: https://api.renaissos.com/v1/openapi.json

SlabScout only calls Renaiss from the backend. The browser never receives the
API key or secret. The main surfaces used by the demo are:

- `GET /v1/search?q=...` to discover card slugs and candidate cards.
- `GET /v1/cards/{game}/{set}/{card}` to load card identity, FMV methods,
  confidence, source counts, observation counts, `lastSaleAt`, and `refreshing`.
- `GET /v1/cards/{game}/{set}/{card}/trades` to inspect observations. The app
  filters out `kind=listing` when producing MarketProof; listings do not count
  as completed sales in the deterministic policy.
- `GET /v1/cards/{game}/{set}/{card}/fmv-series?window=30` to show trend
  consistency across median, mean, and VWAP.
- `GET /v1/indices` for market backdrop only. Index movement never overrides a
  single-card hard rule.

The checked demo card is:

`/card/pokemon/pokemon-japanese-cll-trading-card-game-classic-charizard-ho-oh-ex-deck/003-charizard-psa-10-japanese-2800094f`

The replay fixture stores a real Renaiss-shaped snapshot and marks it clearly as
replay data in API responses.
