/**
 * Validates required env vars before running a command.
 * Loads .env if it exists (optional convenience), then checks vars.
 *
 * Dev/start: BACKEND_PORT
 * Optional: RENAISS_API_KEY and RENAISS_API_SECRET lift the upstream API rate limit.
 */
const fs = require('node:fs')
const path = require('node:path')
const { execSync } = require('node:child_process')

// Load .env if it exists (convenience — env vars can come from anywhere)
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
const missing = required.filter(k => !process.env[k])

if (missing.length > 0) {
  console.error(`\n❌ Missing required env vars: ${missing.join(', ')}`)
  console.error(`   Set them in your environment or copy .env.example to .env\n`)
  process.exit(1)
}

if (!process.env.RENAISS_API_KEY || !process.env.RENAISS_API_SECRET) {
  console.warn('\n⚠️  RENAISS_API_KEY / RENAISS_API_SECRET are not set; backend will use the anonymous upstream tier.\n')
}

try {
  execSync(args.join(' '), { stdio: 'inherit', env: process.env })
} catch (e) {
  process.exit(e.status || 1)
}
