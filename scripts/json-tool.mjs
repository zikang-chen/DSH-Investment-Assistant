#!/usr/bin/env node
/**
 * Safe JSON / UTF-8 file helper — use this instead of PowerShell for repo data work.
 *
 * Rationale: PowerShell `-Command` mangles JSON quotes and Windows code pages corrupt
 * Chinese when Set-Content re-encodes. Node always reads/writes UTF-8 without BOM.
 *
 * Usage:
 *   node scripts/json-tool.mjs get data/portfolio.json
 *   node scripts/json-tool.mjs get data/portfolio.json holdings
 *   node scripts/json-tool.mjs set data/portfolio.json '{"ok":true}'        # pretty-print
 *   node scripts/json-tool.mjs keys data/investment/advices.json
 *   node scripts/json-tool.mjs count data/history/601988-a-day.json kline
 */
import { readFileSync, writeFileSync } from 'node:fs'

const [cmd, file, ...rest] = process.argv.slice(2)
if (!cmd || !file) {
  console.error('usage: json-tool.mjs <get|set|keys|count> <file> [args]')
  process.exit(2)
}

const readJson = () => JSON.parse(readFileSync(file, 'utf8'))

try {
  if (cmd === 'get') {
    let value = readJson()
    for (const key of rest) value = value?.[key]
    console.log(JSON.stringify(value, null, 2))
  } else if (cmd === 'set') {
    const value = JSON.parse(rest.join(' '))
    writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
    console.log('written', file)
  } else if (cmd === 'keys') {
    const value = readJson()
    console.log(Array.isArray(value) ? `array(${value.length})` : Object.keys(value).join('\n'))
  } else if (cmd === 'count') {
    let value = readJson()
    for (const key of rest) value = value?.[key]
    console.log(Array.isArray(value) ? value.length : typeof value)
  } else {
    console.error(`unknown command: ${cmd}`)
    process.exit(2)
  }
} catch (err) {
  console.error(`json-tool error: ${err.message}`)
  process.exit(1)
}
