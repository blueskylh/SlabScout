// Frontend i18n. English is the default; Chinese is opt-in via the header toggle
// and persisted to localStorage.
//
// Two kinds of copy live here:
//   1. Static UI chrome — looked up with `t('some.key')` from the dictionary below.
//   2. Agent-produced copy (policy check labels, timeline notes, offer narratives)
//      — the backend emits English on the primary field plus a `*Zh` sibling, so
//      `pick(obj, 'label')` switches language with no re-run of the agent.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type Lang = 'en' | 'zh'

const STORAGE_KEY = 'slabscout.lang'
const DEFAULT_LANG: Lang = 'en'

const en = {
  'lang.toggle': 'Language',
  'hero.tagline':
    'A USDC agent that buys a market proof first, then autonomously reserves a refundable deposit on a card trade. The user authorizes once; a deterministic rule engine decides every payment after that.',
  'mode.live.note':
    'Live calls Renaiss first. Non-cert failures drop into REPLAY_FALLBACK, where real payments and reserves stay blocked.',
  'reconciliation.warning.prefix': 'This live run needs a manual Circle/Arc state check;',
  'reconciliation.warning.run': 'unresolved run={run}.',
  'reconciliation.warning.keep': 'the linked idempotencyKey is retained.',
  'reconciliation.warning.suffix': 'Starting a new live run before reconciling is blocked.',
  'button.running': 'Agent running…',
  'button.reconciliation': 'Manual reconciliation required',
  'button.needToken': 'Live requires operator token',
  'button.run': 'Run SlabScout Agent',
  'input.operatorToken': 'Operator token for live mode',

  'metric.proofFee': 'Proof fee',
  'metric.proofFee.helper': 'Circle nanopayment demo adapter',
  'metric.deposit': 'Demo deposit',
  'metric.deposit.helper': 'Arc escrow reserve amount',
  'metric.ask': 'Offer ask',
  'metric.ask.helper': 'Seller offer',
  'metric.policy': 'Policy',
  'metric.policy.decision': 'Decision: {action}',
  'metric.policy.notRun': 'not-run',
  'metric.execution': 'Execution',
  'metric.execution.helper': 'separate from policy decision',
  'metric.execution.notStarted': 'not-started',

  'decision.preliminary': 'Preliminary ruling',
  'decision.final': 'Final ruling',
  'decision.table.rule': 'Rule',
  'decision.table.status': 'Status',
  'decision.table.details': 'Details',
  'decision.metric.ask': 'Ask',
  'decision.metric.allowed': 'Allowed',
  'decision.metric.discount': 'Discount',
  'decision.metric.saleAge': 'Sale age',

  'audit.title': 'Audit record',
  'audit.desc':
    'Every run retains its policyVersion, rule results, MarketProof hash and Arc transaction hash so the decision can be replayed later.',

  'empty.title': 'Ready to run the first agent decision',
  'empty.desc': 'Pick Seller A for the RESERVE happy path; pick Seller B or C to see the rejection paths.',

  'footer.disclosureLabel': 'Demo disclosure:',
  'footer.disclosure':
    'The Renaiss API key/secret live only in backend env. Arc is shown on Testnet, and the Circle/Arc adapters default to a deterministic mock/replay adapter. Mock/replay results are never presented as a real paid, reserved, tx hash or explorer receipt.',
  'footer.openCard': 'Open Renaiss card page',

  'auth.title': 'One-time purchase authorization',
  'auth.desc': 'The agent may only buy a MarketProof and lock a USDC deposit inside these bounds.',
  'auth.requireProof': 'Require Proof',
  'auth.readonlyIdentity': 'Read-only target identity',
  'auth.field.card': 'Card',
  'auth.field.cert': 'Cert',
  'auth.field.grade': 'Grade',
  'auth.field.itemId': 'Item ID',
  'auth.field.proofFeeCap': 'Proof fee cap',
  'auth.field.depositCap': 'Deposit cap / daily budget',
  'auth.input.maxOffer': 'Max ask USD',
  'auth.input.medianPct': 'Median discount threshold %',
  'auth.input.minConfidence': 'Minimum confidence',
  'auth.input.sourcesSamples': 'Sources / samples',
  'auth.input.intelFeeCap': 'Per-run intel fee cap USDC',
  'auth.input.depositBudget': 'Deposit / daily budget USDC',

  'offers.title': 'Seller offer branches',
  'offers.desc': 'The demo must prove both that the agent will spend, and that it will refuse a non-compliant offer.',

  'signal.median.helper': 'Primary hard-rule anchor price',
  'signal.mean.helper': 'Deviation from median is bounded',
  'signal.vwap.helper': 'Volume-weighted consistency',
  'signal.lastSale': 'last sale {date}',

  'timeline.title': 'Agent decision trail',
} as const

export type MessageKey = keyof typeof en

const zh: Record<MessageKey, string> = {
  'lang.toggle': '语言',
  'hero.tagline': '一个会先买市场证明、再自主锁定卡牌交易订金的 USDC 代理。用户只授权一次，之后由确定性规则引擎决定是否支付。',
  'mode.live.note': 'Live 会优先请求 Renaiss；非证书类故障会进入 REPLAY_FALLBACK，但真实支付/锁仓会被禁止。',
  'reconciliation.warning.prefix': '当前 Live run 需要人工核对 Circle/Arc 状态；',
  'reconciliation.warning.run': '未解决 run={run}。',
  'reconciliation.warning.keep': '保留关联 idempotencyKey。',
  'reconciliation.warning.suffix': '禁止在核对前开启新的 Live run。',
  'button.running': '代理运行中…',
  'button.reconciliation': '需要人工核对',
  'button.needToken': 'Live 模式需要 operator token',
  'button.run': '运行 SlabScout 代理',
  'input.operatorToken': 'Live 模式的 operator token',

  'metric.proofFee': '证明费用',
  'metric.proofFee.helper': 'Circle nanopayment 演示适配器',
  'metric.deposit': '演示订金',
  'metric.deposit.helper': 'Arc escrow 锁定金额',
  'metric.ask': '卖家报价',
  'metric.ask.helper': '卖家报价',
  'metric.policy': '策略版本',
  'metric.policy.decision': '决策：{action}',
  'metric.policy.notRun': '未运行',
  'metric.execution': '执行状态',
  'metric.execution.helper': '与策略决策相互独立',
  'metric.execution.notStarted': '未开始',

  'decision.preliminary': '规则初判',
  'decision.final': '规则复判',
  'decision.table.rule': '规则',
  'decision.table.status': '状态',
  'decision.table.details': '细节',
  'decision.metric.ask': '报价',
  'decision.metric.allowed': '授权上限',
  'decision.metric.discount': '折扣',
  'decision.metric.saleAge': '成交时距',

  'audit.title': '审计凭证',
  'audit.desc': '每次运行保留 policyVersion、规则结果、MarketProof 哈希和 Arc 交易哈希，便于复盘。',

  'empty.title': '准备运行第一条代理决策',
  'empty.desc': '选择 Seller A 展示 RESERVE 主路径；选择 Seller B 或 C 展示拒绝路径。',

  'footer.disclosureLabel': '演示声明：',
  'footer.disclosure':
    'Renaiss API key/secret 仅放在 backend env；Arc 当前按 Testnet 展示，Circle/Arc 默认使用 deterministic mock/replay adapter；mock/replay 不会展示为真实 paid、reserved、tx hash 或 explorer evidence。',
  'footer.openCard': '打开 Renaiss 卡牌页面',

  'auth.title': '一次性采购授权',
  'auth.desc': '代理只能在这些边界内购买 MarketProof 和锁定 USDC 订金。',
  'auth.requireProof': '要求市场证明',
  'auth.readonlyIdentity': '只读目标身份',
  'auth.field.card': '卡牌',
  'auth.field.cert': '证书号',
  'auth.field.grade': '评级',
  'auth.field.itemId': 'Item ID',
  'auth.field.proofFeeCap': '证明费用上限',
  'auth.field.depositCap': '订金上限 / 日预算',
  'auth.input.maxOffer': '最高报价 USD',
  'auth.input.medianPct': '中位价折扣阈值 %',
  'auth.input.minConfidence': '最小置信度',
  'auth.input.sourcesSamples': '来源数 / 样本数',
  'auth.input.intelFeeCap': '单次情报费上限 USDC',
  'auth.input.depositBudget': '订金 / 日预算 USDC',

  'offers.title': '卖家报价分支',
  'offers.desc': '演示必须同时证明代理会花钱，也会拒绝不合规报价。',

  'signal.median.helper': '硬规则主锚定价',
  'signal.mean.helper': '与中位价偏差受限',
  'signal.vwap.helper': '成交权重一致性',
  'signal.lastSale': '最近成交 {date}',

  'timeline.title': '代理决策轨迹',
}

const DICTS: Record<Lang, Record<MessageKey, string>> = { en, zh }

function interpolate(template: string, params?: Record<string, string | number>) {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in params ? String(params[key]) : match))
}

function readStoredLang(): Lang {
  if (typeof window === 'undefined') return DEFAULT_LANG
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return stored === 'zh' || stored === 'en' ? stored : DEFAULT_LANG
  } catch {
    return DEFAULT_LANG
  }
}

interface I18nValue {
  lang: Lang
  setLang: (next: Lang) => void
  t: (key: MessageKey, params?: Record<string, string | number>) => string
  /** Reads an agent-produced string, preferring the `${key}Zh` sibling in Chinese. */
  pick: (source: unknown, key: string) => string
}

const I18nContext = createContext<I18nValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  // The server entry renders only a placeholder shell (see entry-server.tsx), so
  // the app is always client-rendered — reading storage in the initializer is
  // safe and avoids a flash of English for users who picked Chinese.
  const [lang, setLangState] = useState<Lang>(readStoredLang)

  const setLang = useCallback((next: Lang) => {
    setLangState(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Storage can be unavailable (private mode); the toggle still works in-session.
    }
  }, [])

  useEffect(() => {
    if (typeof document !== 'undefined') document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  }, [lang])

  const value = useMemo<I18nValue>(() => ({
    lang,
    setLang,
    t: (key, params) => interpolate(DICTS[lang][key] ?? en[key] ?? key, params),
    pick: (source, key) => {
      if (!source || typeof source !== 'object') return ''
      const record = source as Record<string, unknown>
      if (lang === 'zh') {
        const localizedValue = record[`${key}Zh`]
        if (typeof localizedValue === 'string' && localizedValue) return localizedValue
      }
      const base = record[key]
      return typeof base === 'string' ? base : ''
    },
  }), [lang, setLang])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  const context = useContext(I18nContext)
  if (!context) throw new Error('useI18n must be used inside <I18nProvider>')
  return context
}

export function LanguageToggle() {
  const { lang, setLang } = useI18n()
  return (
    <div className="flex items-center gap-1 rounded-full border border-border-strong bg-bg-subtle p-1" role="group" aria-label="Language">
      {(['en', 'zh'] as const).map((item) => (
        <button
          key={item}
          type="button"
          onClick={() => setLang(item)}
          aria-pressed={lang === item}
          className={`rounded-full px-3 py-1 text-xs font-black uppercase tracking-wide transition ${lang === item ? 'bg-bg-base text-brand-100 shadow-sm' : 'text-fg-subtle hover:text-fg-base'}`}
        >
          {item === 'en' ? 'EN' : '中文'}
        </button>
      ))}
    </div>
  )
}
