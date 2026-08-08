import { liveRunBody } from './idempotency'
import type { Authorization, DemoConfig, ReconciliationStatus, ScoutRunResult } from './types'

function apiUrl(path: string) {
  const clean = path.replace(/^\/+/, '')
  const base = import.meta.env.BASE_URL || './'
  if (base.startsWith('/') && base !== '/') return `${base.replace(/\/$/, '')}/api/${clean}`
  return `api/${clean}`
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  })
  const text = await response.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { message: text }
  }
  if (!response.ok) {
    throw new Error(body?.message || body?.error || `Request failed: ${response.status}`)
  }
  return body as T
}

export function getDemoConfig() {
  return request<DemoConfig>('demo')
}

export function getReconciliations(operatorToken: string) {
  return request<ReconciliationStatus>('scout/reconciliations', {
    headers: { 'x-slabscout-operator-token': operatorToken },
  })
}

export function runScout(input: { mode: string; offerId: string; authorization: Authorization; idempotencyKey?: string; operatorToken?: string }) {
  const { operatorToken, ...bodyInput } = input
  const body = liveRunBody(bodyInput)
  return request<ScoutRunResult>('scout/run', {
    method: 'POST',
    headers: operatorToken ? { 'x-slabscout-operator-token': operatorToken } : undefined,
    body: JSON.stringify(body),
  })
}
