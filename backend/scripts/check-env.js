/**
 * Loads .env when present, validates the minimal backend runtime config, then
 * execs the requested command. Renaiss/Circle secrets are optional because the
 * app has a replay + deterministic mock mode for Surf Studio demos.
 */
const fs = require('node:fs')
const path = require('node:path')
const { execSync } = require('node:child_process')

const envPath = path.join(process.cwd(), '.env')
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq)
    const val = trimmed.slice(eq + 1)
    if (!process.env[key]) process.env[key] = val
  }
}

const args = process.argv.slice(2)
const required = ['BACKEND_PORT']
const missing = required.filter((key) => !process.env[key])

if (missing.length > 0) {
  console.error(`\n❌ Missing required env vars: ${missing.join(', ')}`)
  console.error('   Copy backend/.env.example to backend/.env or set them in the deployment environment.\n')
  process.exit(1)
}

try {
  execSync(args.join(' '), { stdio: 'inherit', env: process.env })
} catch (error) {
  process.exit(error.status || 1)
}
