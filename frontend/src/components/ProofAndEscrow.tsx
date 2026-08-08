import type { EscrowReceipt, MarketProof, PaymentReceipt } from '../lib/types'
import { StatusPill } from './StatusPill'

function shortHash(value?: string | null) {
  if (!value) return '—'
  return `${value.slice(0, 12)}…${value.slice(-8)}`
}

function money(value?: number | null) {
  if (value === null || value === undefined) return '—'
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function paymentTone(payment: PaymentReceipt | null) {
  if (payment?.confirmed === true && ['confirmed', 'settled'].includes(payment.providerStatus || '')) return 'pass'
  return payment ? 'warn' : 'warn'
}

function escrowTone(escrow: EscrowReceipt | null) {
  if (escrow?.txHash && escrow.chainConfirmed) return 'pass'
  return escrow ? 'warn' : 'warn'
}

export function ProofAndEscrow({ payment, proof, escrow }: { payment: PaymentReceipt | null; proof: MarketProof | null; escrow: EscrowReceipt | null }) {
  return (
    <section className="grid gap-4 lg:grid-cols-3">
      <article className="rounded-[28px] border border-border-strong bg-bg-base p-5 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-black text-fg-base">Nanopayment</h2>
          <StatusPill tone={paymentTone(payment)}>{payment ? payment.status : 'not paid'}</StatusPill>
        </div>
        <dl className="mt-4 space-y-3 text-sm">
          <Row label="Amount" value={payment ? `${payment.amountUsdc} ${payment.asset}` : '—'} />
          <Row label="Network" value={payment?.network || 'Arc Testnet'} />
          <Row label="Receipt" value={shortHash(payment?.receiptId)} mono />
        </dl>
      </article>

      <article className="rounded-[28px] border border-border-strong bg-bg-base p-5 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-black text-fg-base">{proof?.proofKind === 'PolicyProof' ? 'PolicyProof' : 'MarketProof'}</h2>
          <StatusPill tone={proof?.verified ? 'pass' : 'warn'}>{proof ? `${proof.proofKind || 'MarketProof'} ${proof.verified ? 'verified' : 'hashed'}` : 'none'}</StatusPill>
        </div>
        <dl className="mt-4 space-y-3 text-sm">
          <Row label="Proof hash" value={shortHash(proof?.proofHash)} mono />
          <Row label="Suggested max" value={proof?.proofKind === 'PolicyProof' ? 'n/a' : money(proof?.suggestedMaxUsd)} />
          <Row label="Excluded listings" value={proof?.proofKind === 'MarketProof' ? String(proof.listingRowsExcluded) : '—'} />
        </dl>
      </article>

      <article className="rounded-[28px] border border-border-strong bg-bg-base p-5 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-black text-fg-base">Arc Escrow</h2>
          <StatusPill tone={escrowTone(escrow)}>{escrow ? escrow.status : 'not reserved'}</StatusPill>
        </div>
        <dl className="mt-4 space-y-3 text-sm">
          <Row label="Deposit" value={escrow ? `${escrow.amountUsdc} USDC` : '—'} />
          <Row label="Tx hash" value={shortHash(escrow?.txHash)} mono />
          <Row label="Chain ID" value={escrow ? String(escrow.chainId) : '5042002'} />
        </dl>
      </article>
    </section>
  )
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border-strong pb-2 last:border-0 last:pb-0">
      <dt className="text-fg-muted">{label}</dt>
      <dd className={`text-right font-bold text-fg-base ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
    </div>
  )
}
