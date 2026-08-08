const fs = require('node:fs')
const path = require('node:path')

const roots = ['backend', 'frontend/src', 'contracts', 'docs', 'tests', 'scripts', '.github', 'README.md']
const ignoreDirs = new Set(['node_modules', 'dist', '.git'])
const ignoreFiles = new Set(['scripts/secret-scan.js'])
const patterns = [
  { name: 'OpenSSH private key', re: /-----BEGIN OPENSSH PRIVATE KEY-----/ },
  { name: 'Circle live API key', re: /CIRCLE_API_KEY=(?!replace|\$\{\{|\$)[^\n#]{24,}/i },
  { name: 'Renaiss live key', re: /rk_[A-Za-z0-9_-]{20,}/ },
  { name: 'Renaiss live secret', re: /rsk_[A-Za-z0-9_-]{20,}/ },
  { name: 'Ethereum private key assignment', re: /(?:PRIVATE_KEY|WALLET_KEY)=(?:0x)?[a-fA-F0-9]{64}/ },
]

function walk(entry, out = []) {
  if (!fs.existsSync(entry)) return out
  const stat = fs.statSync(entry)
  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(entry)) {
      if (ignoreDirs.has(child)) continue
      walk(path.join(entry, child), out)
    }
  } else if (stat.isFile()) out.push(entry)
  return out
}

const files = roots.flatMap((root) => walk(root)).filter((file, index, arr) => arr.indexOf(file) === index && !ignoreFiles.has(file))
const findings = []
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8')
  for (const pattern of patterns) {
    if (pattern.re.test(text)) findings.push(`${file}: ${pattern.name}`)
  }
}

if (findings.length > 0) {
  console.error('Secret scan failed:')
  for (const finding of findings) console.error(`- ${finding}`)
  process.exit(1)
}
console.log(`Secret scan checked ${files.length} files`)
