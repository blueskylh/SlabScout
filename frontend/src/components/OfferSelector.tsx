import type { Offer } from '../lib/types'
import { StatusPill } from './StatusPill'

interface Props {
  offers: Offer[]
  selectedOfferId: string
  onSelect: (id: string) => void
}

export function OfferSelector({ offers, selectedOfferId, onSelect }: Props) {
  return (
    <section className="rounded-[28px] border border-border-strong bg-bg-base p-5 shadow-sm">
      <h2 className="text-lg font-black text-fg-base">卖家报价分支</h2>
      <p className="mt-1 text-sm leading-6 text-fg-subtle">演示必须同时证明代理会花钱，也会拒绝不合规报价。</p>
      <div className="mt-5 grid gap-3">
        {offers.map((offer) => {
          const active = offer.id === selectedOfferId
          return (
            <button
              key={offer.id}
              type="button"
              onClick={() => onSelect(offer.id)}
              className={`rounded-2xl border p-4 text-left transition ${active ? 'border-brand-100 bg-brand-10' : 'border-border-strong bg-bg-chat hover:border-border-contrast'}`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="font-black text-fg-base">{offer.title}</div>
                <StatusPill tone={offer.forceLowConfidence ? 'warn' : offer.askUsd > 400 ? 'fail' : 'pass'}>
                  ${offer.askUsd}
                </StatusPill>
              </div>
              <p className="mt-2 text-sm leading-6 text-fg-subtle">{offer.narrative}</p>
              <div className="mt-3 flex flex-wrap gap-2 text-xs text-fg-subtle">
                <span className="rounded-full bg-bg-subtle px-2 py-1">deposit {offer.depositUsdc} USDC</span>
                <span className="rounded-full bg-bg-subtle px-2 py-1">image {offer.imageConfidence}</span>
                <span className="rounded-full bg-bg-subtle px-2 py-1">cert {offer.certFound ? 'found' : 'missing'}</span>
              </div>
            </button>
          )
        })}
      </div>
    </section>
  )
}
