# Renaiss API notes used by SlabScout

OpenAPI source: https://api.renaissos.com/v1/openapi.json

SlabScout only calls Renaiss from the backend. The browser never receives the
API key or secret. The main surfaces used by the demo are:

- `GET /v1/search?q=...` to discover card slugs and candidate cards.
- `GET /v1/cards/{game}/{set}/{card}` to load card identity, FMV methods,
  confidence, source counts, observation counts, `lastSaleAt`, and `refreshing`.
- `GET /v1/graded/{cert}` is called first in live mode. SlabScout treats the returned `itemId` and `card.href` as the identity truth. Terminal cert errors (`400/401/404`) are policy rejects, not replay fallback.
- `GET /v1/cards/{game}/{set}/{card}/trades?scope=grade&source=snkrdunk` to inspect graded-card observations. The app normalizes `observedAt`, keeps only `kind=transaction` rows in the MarketProof sample, and marks source rows as `aggregate-only` if no transaction row is exposed.
- `GET /v1/cards/{game}/{set}/{card}/fmv-series?window=30` to show trend
  consistency across median, mean, and VWAP.
- `GET /v1/graded/{cert}` also records `found`, grading company, grade label, item ID, href, and whether the cert/detail/offer/authorization all match structurally.
- `GET /v1/indices` for market backdrop only. Index movement never overrides a
  single-card hard rule.

The checked demo card is:

`/card/pokemon/tag-all-stars/16-reshiram-charizard-gx-psa-10-japanese-6e7fdc9a`

The checked demo certificate is PSA `80396943`.

The replay fixture stores a real Renaiss-shaped snapshot and marks it clearly as
replay data in API responses.
