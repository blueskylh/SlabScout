const { DEMO_CARD, DEMO_TARGET } = require('./index')

const replayCardDetail = Object.freeze({
  id: DEMO_TARGET.targetItemId,
  game: 'pokemon',
  name: 'Reshiram & Charizard-GX',
  setName: 'Tag All Stars',
  setCode: 'SM12A',
  cardNumber: '16',
  language: 'Japanese',
  imageUrl: 'https://bhshyxmgzwogzgcf.public.blob.vercel-storage.com/cards/pokemon_sm12a_16_ja_6e7fdc9a80544034bc028fb64209c688_sm.png?v=1d9dfea4',
  imageUrlLg: 'https://bhshyxmgzwogzgcf.public.blob.vercel-storage.com/cards/pokemon_sm12a_16_ja_6e7fdc9a80544034bc028fb64209c688_lg.png?v=509697e3',
  company: 'PSA',
  grade: '10 Gem Mint',
  gradeLabel: 'PSA 10',
  priceUsdCents: 10858,
  deltas: { d7: -3.91, d30: -1.9, d365: 53.62 },
  confidence: 'medium',
  sourceCount: 2,
  observationCount: 11,
  observationWindowDays: 7,
  totalObservationCount: 2131,
  updatedAt: '2026-08-07T06:39:57.887Z',
  lastSaleAt: '2026-08-05T00:00:00.000Z',
  refreshing: true,
  sourceBreakdown: [
    { source: 'snkrdunk', displayName: 'SNKRDUNK', category: 'public', count: 9, medianUsdCents: 10377 },
    { source: 'site_a', displayName: 'Site A', category: 'public', count: 2, medianUsdCents: 13020 },
  ],
  methods: [
    { method: 'median', label: 'Median', priceUsdCents: 10536, confidence: 'medium', sourceCount: 2, observationCount: 11 },
    { method: 'mean', label: 'Mean', priceUsdCents: 10858, confidence: 'medium', sourceCount: 2, observationCount: 11 },
    { method: 'vwap', label: 'VWAP', priceUsdCents: 10791, confidence: 'medium', sourceCount: 2, observationCount: 11 },
  ],
  href: DEMO_CARD.href,
  pageUrl: `https://index.renaissos.com${DEMO_CARD.href}`,
})

const replayFmvSeries = Object.freeze({
  windowDays: 30,
  fmvWindowDays: 7,
  gradeLabel: 'PSA 10',
  series: [
    { method: 'median', label: 'Median', points: [
      { t: '2026-07-08T00:00:00.000Z', usdCents: 11190 },
      { t: '2026-07-15T00:00:00.000Z', usdCents: 12405 },
      { t: '2026-07-22T00:00:00.000Z', usdCents: 11709 },
      { t: '2026-07-29T00:00:00.000Z', usdCents: 11211 },
      { t: '2026-08-02T00:00:00.000Z', usdCents: 10296 },
      { t: '2026-08-05T00:00:00.000Z', usdCents: 10109 },
      { t: '2026-08-07T00:00:00.000Z', usdCents: 10536 },
    ] },
    { method: 'mean', label: 'Mean', points: [
      { t: '2026-07-08T00:00:00.000Z', usdCents: 11287 },
      { t: '2026-07-15T00:00:00.000Z', usdCents: 12630 },
      { t: '2026-07-22T00:00:00.000Z', usdCents: 11804 },
      { t: '2026-07-29T00:00:00.000Z', usdCents: 11364 },
      { t: '2026-08-02T00:00:00.000Z', usdCents: 10392 },
      { t: '2026-08-05T00:00:00.000Z', usdCents: 10490 },
      { t: '2026-08-07T00:00:00.000Z', usdCents: 10858 },
    ] },
    { method: 'vwap', label: 'VWAP', points: [
      { t: '2026-07-08T00:00:00.000Z', usdCents: 11220 },
      { t: '2026-07-15T00:00:00.000Z', usdCents: 12544 },
      { t: '2026-07-22T00:00:00.000Z', usdCents: 11790 },
      { t: '2026-07-29T00:00:00.000Z', usdCents: 11320 },
      { t: '2026-08-02T00:00:00.000Z', usdCents: 10330 },
      { t: '2026-08-05T00:00:00.000Z', usdCents: 10210 },
      { t: '2026-08-07T00:00:00.000Z', usdCents: 10791 },
    ] },
  ],
})

const replayTrades = Object.freeze({
  trades: [
    { kind: 'transaction', source: 'snkrdunk', displayName: 'SNKRDUNK', priceUsdCents: 10109, observedAt: '2026-08-05T00:00:00.000Z' },
    { kind: 'transaction', source: 'snkrdunk', displayName: 'SNKRDUNK', priceUsdCents: 10296, observedAt: '2026-08-03T00:00:00.000Z' },
    { kind: 'transaction', source: 'snkrdunk', displayName: 'SNKRDUNK', priceUsdCents: 10296, observedAt: '2026-08-02T20:00:00.000Z' },
    { kind: 'listing', source: 'snkrdunk', displayName: 'SNKRDUNK', priceUsdCents: 11929, observedAt: '2026-08-05T02:25:42.607Z' },
  ],
  total: 4,
  sourceCounts: { snkrdunk: 4 },
})

const replayCertLookup = Object.freeze({
  cert: 'PSA80396943',
  certNumber: DEMO_TARGET.certNumber,
  company: 'PSA',
  found: true,
  grade: '10 Gem Mint',
  gradeLabel: 'PSA 10',
  itemId: DEMO_TARGET.targetItemId,
  renaissItemId: DEMO_TARGET.targetRenaissItemId,
  card: {
    id: DEMO_TARGET.targetItemId,
    href: DEMO_TARGET.targetHref,
    name: 'Reshiram & Charizard-GX',
    setName: 'Tag All Stars',
    company: 'PSA',
    gradeLabel: 'PSA 10',
  },
  observedAt: '2026-08-07T06:39:57.887Z',
})

const replayIndices = Object.freeze({ indices: [
  { game: 'pokemon', label: 'Pokémon · Index', value: 12209.93, deltas: { d7: -1.14, d30: -3.79, d365: 47.91 }, updatedAt: '2026-08-04T00:00:00.000Z' },
] })

module.exports = { replayCardDetail, replayFmvSeries, replayTrades, replayCertLookup, replayIndices }
