import type { Authorization, DemoConfig, ScoutRunResult } from './types'

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
  const body = text ? JSON.parse(text) : null
  if (!response.ok) {
    throw new Error(body?.message || body?.error || `Request failed: ${response.status}`)
  }
  return body as T
}

export function getDemoConfig() {
  return request<DemoConfig>('demo')
}

export function runScout(input: { mode: string; offerId: string; authorization: Authorization }) {
  return request<ScoutRunResult>('scout/run', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}
