const buckets = new Map()

function rateLimit({ windowMs = 60_000, max = 20 } = {}) {
  return (req, _res, next) => {
    const key = req.ip || req.headers?.['x-forwarded-for'] || 'local'
    const now = Date.now()
    const bucket = buckets.get(key) || { resetAt: now + windowMs, count: 0 }
    if (now > bucket.resetAt) {
      bucket.resetAt = now + windowMs
      bucket.count = 0
    }
    bucket.count += 1
    buckets.set(key, bucket)
    if (bucket.count > max) {
      const error = new Error('Rate limit exceeded')
      error.statusCode = 429
      next(error)
      return
    }
    next()
  }
}

function resetRateLimitForTests() {
  buckets.clear()
}

module.exports = { rateLimit, resetRateLimitForTests }
