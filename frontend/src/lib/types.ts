export type DecisionAction = 'RESERVE' | 'INVESTIGATE' | 'REJECT'
export type CheckStatus = 'pass' | 'warn' | 'fail'

export interface Authorization {
  targetCard: string
  maxOfferUsd: number
  maxPriceVsMedianPct: number
  minConfidence: string
  minSourceCount: number
  minObservationCount: number
  maxLastSaleAgeDays: number
  maxMethodDeviationPct: number
  maxIntelFeeUsdc: number
  maxDepositUsdc: number
  dailyBudgetUsdc: number
  spentTodayUsdc: number
  requireMarketProof: boolean
}

export interface Offer {
  id: string
  title: string
  askUsd: number
  depositUsdc: number
  sellerAddress: string
  expiresAt: string
  imageConfidence: string
  certFound: boolean
  forceLowConfidence?: boolean
  narrative: string
}

export interface Signal {
  dataMode: string
  dataAsOf: string
  liveError?: string
  card: {
    id: string
    name: string
    setName: string
    setCode?: string
    cardNumber?: string
    variation?: string
    language?: string
    gradeLabel: string
    imageUrl?: string
    href: string
    pageUrl: string
  }
  identity: {
    imageConfidence: string
    certFound: boolean
    forcedLowConfidence?: boolean
  }
  valuation: {
    priceUsd: number | null
    medianUsd: number | null
    meanUsd: number | null
    vwapUsd: number | null
    deltas: Record<string, number>
    methods: Array<{ method: string; label: string; priceUsd: number | null; confidence: string; sourceCount: number; observationCount: number }>
  }
  quality: {
    confidence: string
    sourceCount: number
    observationCount: number
    observationWindowDays: number
    totalObservationCount: number
    lastSaleAt: string
    refreshing: boolean
    updatedAt: string
    sourceBreakdown: Array<{ displayName: string; category: string; count: number; medianUsd: number | null }>
  }
  trades: {
    completedCount: number
    listingCount: number
    recent: Array<{ kind: string; source: string; priceUsd: number; soldAt: string | null }>
  }
  trend: Array<{ method: string; label: string; points: Array<{ t: string; usd: number }> }>
  marketBackdrop: Array<{ game: string; label: string; value: number; deltas: Record<string, number>; updatedAt: string }>
  derived: { maxAuthorizedAskUsd: number | null }
}

export interface PolicyCheck {
  id: string
  label: string
  status: CheckStatus
  severity: 'hard' | 'soft'
  details: string
}

export interface Decision {
  action: DecisionAction
  policyVersion: string
  checkedAt: string
  checks: PolicyCheck[]
  metrics: Record<string, number | null>
  explanation: string
}

export interface PaymentReceipt {
  status: string
  receiptId: string
  amountUsdc: number
  asset: string
  network: string
  paidAt: string
  command?: string
  note?: string
}

export interface MarketProof {
  proofVersion: string
  generatedAt: string
  proofHash: string
  signature: string
  medianUsd: number | null
  meanUsd: number | null
  vwapUsd: number | null
  suggestedMaxUsd: number | null
  sourceCount: number
  observationCount: number
  listingRowsExcluded: number
  outliers: string[]
}

export interface EscrowReceipt {
  status: string
  txHash: string
  offerHash: string
  buyer: string
  seller: string
  escrow: string
  chainId: number
  amountUsdc: number
  proofHash: string
  event?: string
  note?: string
}

export interface TimelineItem {
  stage: string
  status: 'done' | 'warn' | 'blocked'
  note: string
  at: string
  txHash?: string
  receiptId?: string
}

export interface ScoutRunResult {
  runId: string
  status: string
  mode: string
  authorization: Authorization
  offer: Offer
  signal: Signal
  preliminary: Decision
  payment: PaymentReceipt | null
  proof: MarketProof | null
  finalDecision: Decision
  escrow: EscrowReceipt | null
  timeline: TimelineItem[]
  audit: { auditId: string; savedAt: string; action: string; proofHash: string | null; escrowTxHash: string | null }
}

export interface DemoConfig {
  app: string
  defaultMode: string
  defaultAuthorization: Authorization
  offers: Offer[]
  replaySignal: Signal
  disclosures: string[]
}
