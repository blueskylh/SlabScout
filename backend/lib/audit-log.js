const fs = require('node:fs')
const path = require('node:path')

const memoryLog = []
const MAX_MEMORY_ROWS = 100

function appendAudit(entry) {
  const row = {
    ...entry,
    auditId: entry.auditId || `audit_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    savedAt: new Date().toISOString(),
  }
  memoryLog.unshift(row)
  if (memoryLog.length > MAX_MEMORY_ROWS) memoryLog.pop()

  if (process.env.SLABSCOUT_AUDIT_FILE === 'true') {
    try {
      const file = path.join(process.cwd(), 'audit-log.jsonl')
      fs.appendFileSync(file, `${JSON.stringify(row)}\n`)
    } catch (error) {
      row.auditWarning = error instanceof Error ? error.message : String(error)
    }
  }
  return row
}

function listAudits() {
  return memoryLog.slice(0, MAX_MEMORY_ROWS)
}

module.exports = {
  appendAudit,
  listAudits,
}
