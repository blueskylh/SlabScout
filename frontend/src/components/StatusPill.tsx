import type { ReactNode } from 'react'
import type { CheckStatus, DecisionAction } from '../lib/types'

type PillTone = CheckStatus | DecisionAction | 'done' | 'warn' | 'blocked' | string

const toneClass: Record<string, string> = {
  pass: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
  fail: 'bg-red-500/10 text-red-600 border-red-500/20',
  warn: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
  done: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
  blocked: 'bg-red-500/10 text-red-600 border-red-500/20',
  RESERVE: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
  INVESTIGATE: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
  REJECT: 'bg-red-500/10 text-red-600 border-red-500/20',
}

export function StatusPill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-bold ${toneClass[tone] || 'bg-bg-subtle text-fg-subtle border-border-contrast'}`}>
      {children}
    </span>
  )
}
