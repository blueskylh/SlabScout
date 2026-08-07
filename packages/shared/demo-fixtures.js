const { DEMO_CARD } = require('./index')

const replayCardDetail = Object.freeze({
  id: '2800094f-0e7a-4e08-85e8-6dfea5f49318',
  game: 'pokemon',
  type: 'POKEMON',
  name: 'Charizard',
  setName: 'Pokemon Japanese Cll-Trading Card Game Classic Charizard & HO-Oh EX Deck',
  setCode: 'CLL',
  cardNumber: '003',
  variation: 'Base',
  rarity: null,
  language: 'Japanese',
  imageUrl: 'https://bhshyxmgzwogzgcf.public.blob.vercel-storage.com/cards/pokemon_cll_003_ja_2800094f0e7a4e0885e86dfea5f49318_sm.webp?v=a70ae171',
  imageUrlLg: 'https://bhshyxmgzwogzgcf.public.blob.vercel-storage.com/cards/pokemon_cll_003_ja_2800094f0e7a4e0885e86dfea5f49318_lg.webp?v=998ee1a7',
  company: 'PSA',
  grade: '10 Gem Mint',
  gradeLabel: 'PSA 10',
  priceUsdCents: 40355,
  deltas: { d7: -1.12, d30: -8.05, d365: 62.24 },
  confidence: 'prime',
  sourceCount: 2,
  observationCount: 37,
  observationWindowDays: 7,
  totalObservationCount: 2396,
  updatedAt: '2026-08-07T08:24:23.429Z',
  lastSaleAt: '2026-08-06T19:00:00.000Z',
  refreshing: true,
  sourceBreakdown: [
    { source: 'site_s', bucket: 'public', category: 'public', displayName: 'Site S', count: 30, medianUsdCents: 39515, overviewUrl: null },
    { source: 'site_a', bucket: 'public', category: 'public', displayName: 'Site A', count: 7, medianUsdCents: 43957, overviewUrl: null },
  ],
  methods: [
    { method: 'median', scorerVersion: 'v6-usd-median-4tier', label: 'Median', priceUsdCents: 39443, confidence: 'prime', sourceCount: 2, observationCount: 37 },
    { method: 'mean', scorerVersion: 'v5-usd-mean-4tier', label: 'Mean', priceUsdCents: 40355, confidence: 'prime', sourceCount: 2, observationCount: 37 },
    { method: 'vwap', scorerVersion: 'v7-usd-vwap-4tier', label: 'VWAP', priceUsdCents: 40104, confidence: 'prime', sourceCount: 2, observationCount: 37 },
  ],
  href: DEMO_CARD.href,
  pageUrl: `https://index.renaissos.com${DEMO_CARD.href}`,
})

const replayFmvSeries = Object.freeze({
  windowDays: 30,
  fmvWindowDays: 7,
  gradeLabel: 'PSA 10',
  series: [
    {
      method: 'median',
      label: 'Median',
      points: [
        { t: '2026-07-08T00:00:00.000Z', usdCents: 42104 },
        { t: '2026-07-15T00:00:00.000Z', usdCents: 42333 },
        { t: '2026-07-22T00:00:00.000Z', usdCents: 41221 },
        { t: '2026-07-29T00:00:00.000Z', usdCents: 38972 },
        { t: '2026-08-02T00:00:00.000Z', usdCents: 39790 },
        { t: '2026-08-05T00:00:00.000Z', usdCents: 39930 },
        { t: '2026-08-07T00:00:00.000Z', usdCents: 39443 },
      ],
    },
    {
      method: 'mean',
      label: 'Mean',
      points: [
        { t: '2026-07-08T00:00:00.000Z', usdCents: 43021 },
        { t: '2026-07-15T00:00:00.000Z', usdCents: 43152 },
        { t: '2026-07-22T00:00:00.000Z', usdCents: 42182 },
        { t: '2026-07-29T00:00:00.000Z', usdCents: 40701 },
        { t: '2026-08-02T00:00:00.000Z', usdCents: 40138 },
        { t: '2026-08-05T00:00:00.000Z', usdCents: 40444 },
        { t: '2026-08-07T00:00:00.000Z', usdCents: 40355 },
      ],
    },
    {
      method: 'vwap',
      label: 'VWAP',
      points: [
        { t: '2026-07-08T00:00:00.000Z', usdCents: 43144 },
        { t: '2026-07-15T00:00:00.000Z', usdCents: 42976 },
        { t: '2026-07-22T00:00:00.000Z', usdCents: 42164 },
        { t: '2026-07-29T00:00:00.000Z', usdCents: 40831 },
        { t: '2026-08-02T00:00:00.000Z', usdCents: 40251 },
        { t: '2026-08-05T00:00:00.000Z', usdCents: 40164 },
        { t: '2026-08-07T00:00:00.000Z', usdCents: 40104 },
      ],
    },
  ],
})

const replayTrades = Object.freeze({
  trades: [
    { kind: 'transaction', source: 'site_s', priceUsdCents: 39000, observedAt: '2026-08-06T19:00:00.000Z' },
    { kind: 'transaction', source: 'site_s', priceUsdCents: 40100, observedAt: '2026-08-06T13:10:00.000Z' },
    { kind: 'transaction', source: 'site_a', priceUsdCents: 43957, observedAt: '2026-08-05T20:30:00.000Z' },
    { kind: 'listing', source: 'site_a', priceUsdCents: 99, observedAt: null },
    { kind: 'listing', source: 'site_s', priceUsdCents: 40558, observedAt: null },
  ],
  total: 37,
  sourceCounts: { site_s: 30, site_a: 7 },
})



const replayCertLookup = Object.freeze({
  cert: 'DEMO-CERT-CHARIZARD-PSA10',
  found: true,
  company: 'PSA',
  gradeLabel: 'PSA 10',
  name: 'Charizard',
  setName: 'Pokemon Japanese Cll-Trading Card Game Classic Charizard & HO-Oh EX Deck',
  cardNumber: '003',
  language: 'Japanese',
  observedAt: '2026-08-07T08:24:23.429Z',
})

const replayIndices = Object.freeze({
  indices: [
    {
      game: 'pokemon',
      label: 'Pokémon · Index',
      value: 12209.93,
      base: 10000,
      deltas: { d7: -1.14, d30: -3.79, d365: 47.91 },
      constituentCount: 50,
      rebalance: 'Monthly',
      updatedAt: '2026-08-04T00:00:00.000Z',
    },
    {
      game: 'one-piece',
      label: 'One Piece · Index',
      value: 21002.04,
      base: 10000,
      deltas: { d7: -8.23, d30: -18.8, d365: 226.34 },
      constituentCount: 50,
      rebalance: 'Monthly',
      updatedAt: '2026-08-04T00:00:00.000Z',
    },
  ],
})

module.exports = {
  replayCardDetail,
  replayFmvSeries,
  replayTrades,
  replayCertLookup,
  replayIndices,
}
