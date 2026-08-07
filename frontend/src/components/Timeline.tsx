import type { TimelineItem } from '../lib/types'
import { StatusPill } from './StatusPill'

export function Timeline({ items }: { items: TimelineItem[] }) {
  return (
    <section className="rounded-[28px] border border-border-strong bg-bg-base p-5 shadow-sm">
      <h2 className="text-lg font-black text-fg-base">代理决策轨迹</h2>
      <div className="mt-5 space-y-3">
        {items.map((item, index) => (
          <div key={`${item.stage}-${index}`} className="flex gap-3 rounded-2xl border border-border-strong bg-bg-chat p-4">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-10 text-sm font-black text-brand-100">{index + 1}</div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-black text-fg-base">{item.stage}</div>
                <StatusPill tone={item.status}>{item.status}</StatusPill>
              </div>
              <p className="mt-1 text-sm leading-6 text-fg-subtle">{item.note}</p>
              {item.txHash ? <p className="mt-1 break-all font-mono text-xs text-fg-muted">tx {item.txHash}</p> : null}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
