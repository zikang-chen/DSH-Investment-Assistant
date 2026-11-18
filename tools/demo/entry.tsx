/**
 * README 演示图渲染入口（仅文档用途，不参与插件构建）。
 *
 * 渲染的是插件真实组件（OverviewWorkbench / PortfolioStrategy / InvestmentWorkbench），
 * 数据全部来自下方 SAMPLE 假数据，通过替换 props 注入 —— 不请求网络、不读本机持仓。
 * 因此生成的图片必须标注「示例数据」，不能当成实机持仓截图。
 */
import { createElement as h, useState } from 'react'
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
  const key = Object.keys(SAMPLE).find(k => path.startsWith(k.split('?')[0]!))
  return structuredClone((key ? SAMPLE[key] : { ok: true })) as T
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
]

function Demo() {
  const [tab, setTab] = useState('home')
  const active = TABS.find(t => t.id === tab)!
  return h(FinanceTheme, { className: 'fia-panel' },
    h('style', null, WORKSPACE_CSS),
    h('style', null, SECURITY_CSS),
    h('div', { style: { padding: 16 } },
      h('nav', { 'aria-label': '演示导航', style: { display: 'flex', gap: 6, marginBottom: 14 } },
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
