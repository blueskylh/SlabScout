const PUBLIC_MODES = Object.freeze(['replay', 'live'])

function resolveEffectiveMode(requestMode, envDefault = process.env.SLABSCOUT_DEFAULT_MODE || 'replay') {
  const hasRequestMode = requestMode !== undefined && requestMode !== null
  const raw = hasRequestMode ? requestMode : envDefault
  if (typeof raw !== 'string' || raw.trim() === '') {
    const error = new Error('mode must be one of: replay, live')
    error.statusCode = 400
    throw error
  }
  const mode = raw.trim()
  if (!PUBLIC_MODES.includes(mode)) {
    const error = new Error('mode must be one of: replay, live')
    error.statusCode = 400
    throw error
  }
  return mode
}

function modeRequiresOperator(mode) {
  return mode === 'live'
}

module.exports = { PUBLIC_MODES, resolveEffectiveMode, modeRequiresOperator }
