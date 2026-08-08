export function createLiveIdempotencyKey(offerId: string) {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `live:${offerId}:${random}`
}

export function liveRunBody(input: { mode: string; offerId: string; authorization: unknown; idempotencyKey?: string }) {
  if (input.mode !== 'live') return { mode: input.mode, offerId: input.offerId, authorization: input.authorization, idempotencyKey: input.idempotencyKey }
  if (!input.idempotencyKey) throw new Error('Live run requires an idempotencyKey')
  return { mode: 'live', offerId: input.offerId, authorization: input.authorization, idempotencyKey: input.idempotencyKey }
}
