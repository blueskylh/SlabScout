const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const roots = ['backend', 'tests', 'scripts']
const files = []
function walk(dir) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.isFile() && full.endsWith('.js')) files.push(full)
  }
}
for (const root of roots) walk(root)

let failed = false
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' })
  if (result.status !== 0) failed = true
}
if (failed) process.exit(1)
console.log(`Checked ${files.length} JavaScript files`)
