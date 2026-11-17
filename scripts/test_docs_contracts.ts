#!/usr/bin/env npx tsx
/**
 * 文档契约静态测试（**不联网、不依赖真实数据源**）。
 *
 *   npx tsx scripts/test_docs_contracts.ts
 *
 * 断言三份文档存在且包含关键条目：
 *   - docs/data-source-audit.md       数据源矩阵、已验证/未测试/不可用、禁止把源码当实测、实测日期
 *   - docs/free-cn-datasets.md        29 个 dataset id（含 22+ 校验）、增量非存量、不可用原因、实测数值样例
 *   - docs/provider-dataset-registry.md  11 个 Provider 字段名、四类时间、禁止项（不补 0/不混复权/不混币种）
 *
 * 全部为字符串/文件存在性检查，不发起任何网络请求。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  [PASS] ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const root = process.cwd()
const DOCS = {
  audit: path.join(root, 'docs', 'data-source-audit.md'),
  freeCn: path.join(root, 'docs', 'free-cn-datasets.md'),
  registry: path.join(root, 'docs', 'provider-dataset-registry.md'),
}

function readDoc(p: string): string {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

// DATASETS 的实际全部 id（来自 scripts/fin_cn_datasets.py，共 29 个：19 可用 + 10 不可用）
const DATASET_IDS = [
  // 19 available
  'CN_MACRO_GDP', 'CN_MACRO_CPI', 'CN_MACRO_PPI', 'CN_MACRO_PMI', 'CN_MONEY_M1_M2',
  'CN_CREDIT_TSFIN_FLOW', 'CN_FISCAL_REVENUE', 'CN_INDUSTRIAL_PRODUCTION', 'CN_REAL_ESTATE',
  'CN_IMPORT_EXPORT', 'CN_ELECTRICITY_CONSUMPTION', 'CN_A_SHARE_DAILY', 'CN_A_SHARE_FINANCIALS',
  'CN_ETF_DAILY', 'CN_FUND_NAV', 'CN_INDEX_DAILY', 'CN_BOND_YIELD', 'CN_CORPORATE_ANNOUNCEMENTS',
  'CN_INDUSTRY_SECTOR',
  // 10 unavailable
  'CN_CREDIT_TSFIN_STOCK', 'CN_FISCAL_EXPENDITURE', 'CN_GOVERNMENT_BONDS', 'CN_A_SHARE_VALUATION',
  'CN_FUND_HOLDINGS', 'CN_INDEX_COMPONENTS', 'CN_MARKET_TURNOVER', 'CN_INDUSTRY_ELECTRONICS',
  'CN_INDUSTRY_AUTOMOTIVE', 'CN_INDUSTRY_SOFTWARE',
]

// 11 个统一 Provider 能力声明字段名
const PROVIDER_FIELDS = [
  'provider_id', 'datasets', 'access_type', 'requires_key', 'cost_class', 'permissions',
  'redistribution_policy', 'data_frequency', 'expected_latency', 'priority', 'health_status',
]

function includes(hay: string, needle: string): boolean {
  return hay.includes(needle)
}

async function main(): Promise<void> {
  console.log('== 文件存在性 ==')
  for (const [k, p] of Object.entries(DOCS)) {
    const ok = existsSync(p)
    check(`文件存在：${path.relative(root, p)}`, ok)
    if (ok) check(`非空：${path.relative(root, p)}`, readDoc(p).trim().length > 200, `${readDoc(p).length} 字符`)
    void k
  }

  // ---------------- docs/data-source-audit.md ----------------
  const audit = readDoc(DOCS.audit)
  console.log('\n== data-source-audit.md ==')
  for (const phrase of ['已验证可用', '未测试', '不可用', '实测', '2026-11-17', '禁止把源码当实测', '不可用原因', '数据源矩阵']) {
    check(`审计含「${phrase}」`, includes(audit, phrase))
  }
  for (const pid of ['ws_quotes_batch', 'em_macro', 'em_market_detail_announcements', 'global_financials_sources', 'ws_kline']) {
    check(`审计含 provider「${pid}」`, includes(audit, pid))
  }
  // 必须同时区分三类判定，且含实测数值样例
  check('审计区分「已验证可用 / 未测试 / 不可用」三态',
    includes(audit, '已验证可用') && includes(audit, '未测试') && includes(audit, '不可用'))
  check('审计含实测数值样例（600519 或 00700 或 M2）',
    includes(audit, '600519') || includes(audit, '00700') || includes(audit, '359.06'))

  // ---------------- docs/free-cn-datasets.md ----------------
  const freeCn = readDoc(DOCS.freeCn)
  console.log('\n== free-cn-datasets.md ==')
  let present = 0
  for (const id of DATASET_IDS) {
    const has = includes(freeCn, id)
    if (has) present++
    check(`dataset id 出现：${id}`, has)
  }
  check(`dataset id 总数 ≥ 22（实际 ${DATASET_IDS.length} 个全部枚举，命中 ${present}）`, present >= 22)
  check(`dataset id 命中数 = ${DATASET_IDS.length}`, present === DATASET_IDS.length)
  for (const phrase of ['增量非存量', '不可用原因', '存量']) {
    check(`free-cn 含「${phrase}」`, includes(freeCn, phrase))
  }
  // 实测数值样例
  for (const sample of ['0.7', '359.06', '6245', '1079', '53.37', '3.008', '2026-09', '1.8782']) {
    check(`free-cn 含实测样例「${sample}」`, includes(freeCn, sample))
  }
  check('free-cn 含 22/29 条目数说明', includes(freeCn, '29') && includes(freeCn, '22'))

  // ---------------- docs/provider-dataset-registry.md ----------------
  const reg = readDoc(DOCS.registry)
  console.log('\n== provider-dataset-registry.md ==')
  for (const f of PROVIDER_FIELDS) {
    check(`registry 含 Provider 字段「${f}」`, includes(reg, f))
  }
  for (const phrase of ['统计期', '发布日', '抓取日', '修订日', '不补 0', '不混复权', '不混币种']) {
    check(`registry 含「${phrase}」`, includes(reg, phrase))
  }
  for (const route of ['A股', '中国宏观', '货币', '财政', '公告', '基金']) {
    check(`registry 路由含「${route}」`, includes(reg, route))
  }

  console.log(`\n[docs-contracts] ${passed} passed, ${failed} failed`)
  if (failed) {
    console.log(`failed cases: ${failures.join(' | ')}`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
