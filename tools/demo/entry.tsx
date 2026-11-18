/**
 * README 演示图渲染入口（仅文档用途，不参与插件构建）。
 *
 * 渲染的是插件真实组件（OverviewWorkbench / PortfolioStrategy / InvestmentWorkbench），
 * 数据全部来自下方 SAMPLE 假数据，通过替换 props 注入 —— 不请求网络、不读本机持仓。
 * 因此生成的图片必须标注「示例数据」，不能当成实机持仓截图。
 */
import { createElement as h, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { FinanceTheme } from '../../src/client/design-system/index.js'
import { WORKSPACE_CSS } from '../../src/client/workspace-styles.js'
import { SECURITY_CSS } from '../../src/client/security-styles.js'
import { OverviewWorkbench, InvestmentWorkbench } from '../../src/client/workbench.js'
import { PortfolioStrategy } from '../../src/client/portfolio-strategy.js'
import type { ReadApi } from '../../src/client/workbench-model.js'

const SAMPLE: Record<string, unknown> = {
  '/advice?limit=3': {
    ok: true, stats: { total: 8, open: 6, reviewed: 2 }, dueForReview: 2,
    advices: [{
      adviceId: 'demo-1', userPrompt: '沪深300估值处于历史中位，现在做长期配置是否合适？', assets: ['沪深300'],
      market: 'cn', horizon: 'years', recommendation: 'HOLD', dataFreshness: 'fresh',
      supports: 4, contradicts: 2, status: 'open', reviews: 0, createdAt: '2026-11-17T02:00:00.000Z', nextReviewAt: '2026-12-15',
    }],
  },
  '/advice?id=demo-1': {
    ok: true, label: '维持当前持仓',
    advice: {
      adviceId: 'demo-1', userPrompt: '沪深300估值处于历史中位，现在做长期配置是否合适？', createdAt: '2026-11-17T02:00:00.000Z',
      assets: ['沪深300'], market: 'cn', horizon: 'years', recommendation: 'HOLD',
      investmentGoal: '长期配置，接受 20% 以内的回撤，不做短期择时。',
      recommendationConditions: ['沪深300 PE 仍处于近十年 30–70 分位', '10 年期国债收益率不高于 2.6%'],
      rationale: [
        '沪深300 前向 PE 12.4 倍，处于近十年 48 分位，估值未到极端区间。',
        '10 年期国债收益率 1.88%，相对股票的风险溢价仍在 3 个百分点以上。',
        '盈利端仍在磨底：1—10 月工业企业利润同比 -1.4%，未见拐点。',
      ],
      supporting: [
        { kind: 'valuation', claim: '沪深300 前向 PE 12.4 倍，近十年 48 分位', source: '东方财富估值分位', asOf: '2026-11-17' },
        { kind: 'macro', claim: '10 年期国债收益率 1.88%，股债性价比仍偏股票', source: '中债收益率曲线', asOf: '2026-11-16' },
      ],
      contradicting: [
        { kind: 'fundamental', claim: '1—10 月工业企业利润同比 -1.4%，盈利仍在收缩', source: '国家统计局', asOf: '2026-11-16' },
        { kind: 'market', claim: '两市成交额连续 5 日低于 8000 亿，缺乏增量资金', source: '东方财富行情', asOf: '2026-11-17' },
      ],
      invalidationConditions: ['沪深300 前向 PE 升破近十年 80 分位', '10 年期国债收益率升至 2.8% 以上'],
      recommendationConditionsNote: undefined,
      marketSnapshot: [{ asOf: '2026-11-17', note: '沪深300 4 218.36（+0.42%），成交额 7 820 亿，北向净流入 12 亿' }],
      dataFreshness: { status: 'fresh', asOf: '2026-11-17', note: '行情为 11-17 收盘；宏观为 10 月统计期' },
      valuationSummary: '前向 PE 12.4 倍 · 近十年 48 分位 · 股息率 2.9%',
      portfolioContextUsed: false,
      riskConstraints: ['单一指数不超过组合 40%', '不融资买入'],
      scenarioAssumptions: ['基准：盈利温和修复，估值不变', '恶化：盈利继续下修 10%'],
      proposedAction: { summary: '按目标权重分批建仓，不追高；先建一半，回落 5% 再补另一半。', conditions: ['单日跌幅超过 2% 时执行第二笔'], simulated: true },
      nextReviewAt: '2026-12-15', unresolvedQuestions: ['12 月中央经济工作会议的赤字率表述'], calculationRefs: ['calculate_technical_indicators(MA20/MA60)'],
      modelVersion: 'demo', promptVersion: 'demo', status: 'open', reviews: [], promptHash: 'demo',
    },
  },
  '/evidence?limit=5': {
    ok: true, stats: { waiting: 1 },
    requests: [{ requestId: 'evr-1', title: '需要 2026 年中央预算内投资实际拨付数据', status: 'WAITING_FOR_USER', updatedAt: '2026-11-16' }],
  },
  '/capital': { accounts: [{ name: '示例账户' }], events: 12, warnings: [] },
  '/policy?limit=4': {
    ok: true, stats: { total: 39 },
    docs: [
      { id: 'pol-1', title: '国家统计局：2026 年 1—10 月份全国房地产市场基本情况', publishedAt: '2026-11-16', issuer: '国家统计局' },
      { id: 'pol-2', title: '国务院新闻办发布双碳白皮书', publishedAt: '2026-11-15', issuer: '国务院新闻办' },
      { id: 'pol-3', title: '财政部：2026 年 1—9 月财政收支情况', publishedAt: '2026-11-14', issuer: '财政部' },
    ],
  },
  '/strategy/versions': {
    ok: true,
    entries: [{
      id: 'pv-1', name: '股债金 60/30/10', version: 2, state: 'review', revision: 3,
      policyHash: 'fnv1a64:9f3c1a7b2e5d4088', inputHash: 'fnv1a64:1c4b7d2f8a6e9301',
      reason: '黄金权重从 5% 提到 10%，理由：真实利率见顶回落', createdAt: '2026-11-18T01:10:00.000Z',
      policy: { asOf: '2026-11-18', baseCurrency: 'CNY', positions: [], cashWeight: 0, targetCashWeight: 0, constraints: {}, review: { cadenceDays: 30 } },
      evaluation: {}, history: [{ action: 'save', state: 'draft', revision: 1, reason: '初版', actor: 'agent', at: '2026-11-18T01:10:00.000Z', policyHash: 'fnv1a64:9f3c1a7b2e5d4088', inputHash: 'fnv1a64:1c4b7d2f8a6e9301' }],
    }],
  },
}

const get: ReadApi = async <T,>(path: string) => {
  const exact = SAMPLE[path]
  const key = exact !== undefined ? path
    : Object.keys(SAMPLE).find(k => path.startsWith(k.split('?')[0]!) && k.includes('?'))
      ?? Object.keys(SAMPLE).find(k => path.startsWith(k.split('?')[0]!))
  return structuredClone((key ? SAMPLE[key] : exact ?? { ok: true })) as T
}
const post = async <T,>(_path: string, _body: Record<string, unknown>) => ({ ok: true } as T)
const deliver = async () => 'sent' as const
const useBus = () => {}
const navigate = () => {}

const TABS = [
  { id: 'home', label: '总览', render: () => h(OverviewWorkbench, {
    get, deliver, useBus, navigate, onOpenAdvice: () => {}, onOpenPolicy: () => {},
    marketSummary: h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 8 } },
      [['沪深300', '4 218.36', '+0.42%'], ['恒生指数', '25 412.80', '-0.68%'], ['纳斯达克', '24 509.76', '+0.15%']].map(([name, price, chg]) =>
        h('div', { key: name, style: { padding: '8px 10px', border: '1px solid var(--fia-border)', borderRadius: 8 } },
          h('div', { style: { fontSize: 11, color: 'var(--fia-secondary)' } }, name),
          h('div', { style: { fontSize: 15, fontWeight: 650, fontVariantNumeric: 'tabular-nums' } }, price),
          h('div', { style: { fontSize: 11, color: chg.startsWith('+') ? 'var(--fia-up)' : 'var(--fia-down)' } }, chg)))),
    portfolioSummary: h('div', null,
      h('p', { style: { margin: 0 } }, '6 项持仓 · 3 项自选'),
      h('p', { style: { margin: '4px 0 0', fontSize: 12, color: 'var(--fia-secondary)' } }, '今日 +0.61% · 第一大权重 28.4%')),
  }) },
  { id: 'strategy', label: '组合策略', render: () => h(PortfolioStrategy, { deliver, get, post }) },
  { id: 'advice', label: '投资判断', render: () => h(InvestmentWorkbench, {
    selectionId: 'demo-1', onSelectAdvice: () => {}, deliver, get, useBus, navigate, onOpenPolicy: () => {},
  }) },
]

/** 截图可指定初始页：file://…/x.html#advice；加 ?nav=off 隐藏演示切换条。 */
const initialTab = (location.hash.replace('#', '') || new URLSearchParams(location.search).get('tab') || 'home')
const showNav = new URLSearchParams(location.search).get('nav') !== 'off'

function Demo() {
  const [tab, setTab] = useState(TABS.some(t => t.id === initialTab) ? initialTab : 'home')
  // 录屏脚本通过改 hash 切页，避免在画面里出现演示用的切换条。
  useEffect(() => {
    const onHash = () => {
      const next = location.hash.replace('#', '')
      if (TABS.some(t => t.id === next)) setTab(next)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const active = TABS.find(t => t.id === tab)!
  return h(FinanceTheme, { className: 'fia-panel' },
    h('style', null, WORKSPACE_CSS),
    h('style', null, SECURITY_CSS),
    h('div', { style: { padding: 16 } },
      showNav && h('nav', { 'aria-label': '演示导航', style: { display: 'flex', gap: 6, marginBottom: 14 } },
        TABS.map(t => h('button', {
          key: t.id, type: 'button', onClick: () => setTab(t.id),
          'aria-current': tab === t.id ? 'page' : undefined,
          style: {
            minHeight: 30, padding: '0 12px', borderRadius: 999, cursor: 'pointer', font: 'inherit', fontSize: 12.5,
            border: `1px solid ${tab === t.id ? 'var(--fia-brand)' : 'var(--fia-border)'}`,
            background: tab === t.id ? 'var(--fia-brand)' : 'var(--fia-surface)',
            color: tab === t.id ? 'var(--fia-on-primary)' : 'var(--fia-text)',
            fontWeight: tab === t.id ? 650 : 500,
          },
        }, t.label))),
      h(active.render)),
  )
}

createRoot(document.getElementById('root')!).render(h(Demo))
