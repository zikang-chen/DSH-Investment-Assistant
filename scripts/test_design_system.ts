/** Offline contract tests. No live finance data, DOM renderer, browser, package install or generated artifact. */
import assert from 'node:assert/strict'
import { createElement } from 'react'
import {
  Button, EmptyState, FinanceTheme, MetricCard, PageHeader, StatusBadge,
  contrastRatio, dimensionTokens, financeCss, formatCompact, formatDate, formatMoney,
  formatNumber, formatPercent, formatPoints, getFinanceTokens, marketPalette, palette,
  themeFromHostSignal,
} from '../src/client/design-system/index.js'
import {
  getServerThemeSnapshot, getThemeSnapshot, registerThemeRoot, setMarketMode,
  setThemePreference, subscribeTheme, THEME_STORAGE_KEY,
} from '../src/client/design-system/theme-store.js'

let checks = 0
function check(name: string, run: () => void) { run(); checks++; console.log(`PASS ${name}`) }

check('money: precision, currency, grouping, signs, negative zero', () => {
  assert.equal(formatMoney(1234567.895), '¥1,234,567.90')
  assert.equal(formatMoney(1.005), '¥1.01')
  assert.equal(formatMoney(-1234.5), '−¥1,234.50')
  assert.equal(formatMoney(1234.5, { currency: 'USD', signed: true }), '+$1,234.50')
  assert.equal(formatMoney(1234.5, { currency: 'HKD', decimals: 3 }), 'HK$1,234.500')
  assert.equal(formatMoney(1234.5, { symbol: false }), '1,234.50')
  assert.equal(formatMoney(-0, { signed: true }), '¥0.00')
  assert.equal(formatMoney(-0.001, { signed: true }), '¥0.00')
  assert.equal(formatMoney(0.001, { signed: true }), '¥0.00')
})

check('percent is not ratio, and percentage points are not percent', () => {
  assert.equal(formatPercent(5), '5.00%')
  assert.equal(formatPercent(0.05), '0.05%')
  assert.equal(formatPercent(0.05, { input: 'ratio' }), '5.00%')
  assert.equal(formatPercent(1.5, { signed: true }), '+1.50%')
  assert.equal(formatPercent(-0.000001, { signed: true }), '0.00%')
  assert.equal(formatPoints(1.5, { signed: true }), '+1.50 pp')
  assert.equal(formatPoints(1.5, { suffix: ' 个百分点' }), '1.50 个百分点')
  assert.equal(formatPoints(1.5, { suffix: ' bp' }), '1.50 bp')
  assert.notEqual(formatPercent(1.5), formatPoints(1.5))
})

check('missing values never become zero', () => {
  for (const value of [null, undefined, NaN, Infinity, -Infinity]) {
    for (const formatter of [formatNumber, formatMoney, formatPercent, formatPoints, formatCompact]) assert.equal(formatter(value), '—')
  }
  assert.equal(formatNumber(-0), '0.00')
  assert.equal(formatNumber(-0.0001, { decimals: 2 }), '0.00')
  assert.equal(formatNumber(12.345, { decimals: 1, signed: true }), '+12.3')
  assert.equal(formatNumber(-3.12, { decimals: 0, signed: true }), '−3')
  assert.equal(formatNumber(0, { signed: true }), '0.00')
})

check('compact units preserve sign and promote after rounding', () => {
  assert.equal(formatCompact(0), '0')
  assert.equal(formatCompact(12345), '1.23万')
  assert.equal(formatCompact(-123456789, { signed: true }), '−1.23亿')
  assert.equal(formatCompact(9999.999), '1万')
  assert.equal(formatCompact(99999999.99), '1亿')
  assert.equal(formatCompact(20000, { signed: true, decimals: 1 }), '+2万')
})

check('date-only values and explicit instant time zones', () => {
  assert.equal(formatDate('2026-11-16'), '2026-11-16')
  assert.equal(formatDate('2026-02-30'), '—')
  assert.equal(formatDate('invalid'), '—')
  assert.equal(formatDate(undefined), '—')
  assert.equal(formatDate(null), '—')
  assert.equal(formatDate(NaN), '—')
  assert.equal(formatDate('2026-11-16T20:00:00Z'), '2026-11-17')
  assert.equal(formatDate('2026-11-16T20:00:00Z', { timeZone: 'UTC', includeTime: true }), '2026-11-16 20:00')
  assert.equal(formatDate('2026-11-16', { timeZone: 'broken' }), '2026-11-16')
})

check('WCAG contrast utilities implement the 21:1 black/white reference', () => {
  assert.equal(contrastRatio('#000000', '#FFFFFF'), 21)
  assert.equal(contrastRatio('#FFFFFF', '#FFFFFF'), 1)
  assert.throws(() => contrastRatio('not-a-color', '#FFFFFF'), TypeError)
})

check('light/dark text, secondary, muted and primary buttons meet 4.5:1', () => {
  for (const theme of ['light', 'dark'] as const) {
    const tokens = palette[theme]
    for (const foreground of ['text', 'secondary', 'muted'] as const) {
      for (const background of ['surface', 'canvas', 'surface-muted', 'hover', 'selected'] as const) {
        const ratio = contrastRatio(tokens[foreground], tokens[background])
        assert.ok(ratio >= 4.5, `${theme} ${foreground}/${background}: ${ratio.toFixed(2)}`)
      }
    }
    assert.ok(contrastRatio(tokens['on-primary'], tokens.brand) >= 4.5, `${theme} primary button`)
    assert.ok(contrastRatio(tokens['on-dark'], tokens.navy) >= 4.5, `${theme} navy header`)
    assert.ok(contrastRatio(tokens.focus, tokens.surface) >= 3, `${theme} focus indicator`)
    console.log(`  ${theme}: body=${contrastRatio(tokens.text, tokens.surface).toFixed(2)}, secondary=${contrastRatio(tokens.secondary, tokens.surface).toFixed(2)}, button=${contrastRatio(tokens['on-primary'], tokens.brand).toFixed(2)}`)
  }
})

check('status colors stay independent of all market modes; badges meet 4.5:1', () => {
  for (const theme of ['light', 'dark'] as const) {
    for (const mode of ['china', 'international', 'accessible'] as const) {
      const tokens = getFinanceTokens(theme, mode)
      for (const status of ['info', 'success', 'warning', 'danger'] as const) {
        assert.equal(tokens[status], palette[theme][status])
        assert.ok(contrastRatio(tokens[status], tokens[`${status}-soft`]) >= 4.5, `${theme}/${status} badge`)
      }
      for (const direction of ['up', 'down', 'flat'] as const) {
        assert.ok(contrastRatio(tokens[direction], tokens.surface) >= 4.5, `${theme}/${mode}/${direction}`)
      }
      for (const series of ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5'] as const) assert.equal(tokens[series], palette[theme][series])
    }
    assert.equal(marketPalette[theme].china.up, marketPalette[theme].international.down)
    assert.equal(marketPalette[theme].china.down, marketPalette[theme].international.up)
    assert.notEqual(marketPalette[theme].accessible.up, marketPalette[theme].china.up)
  }
})

check('all CSS rules stay under .fia-root; soft tokens are concrete colors', () => {
  const rules = [...financeCss.matchAll(/(?:^|[{}])\s*([^{}]+)\{/g)]
  assert.ok(rules.length > 50)
  for (const [, selector] of rules) {
    if (selector!.trim().startsWith('@media')) continue
    assert.ok(selector!.trim().startsWith('.fia-root'), `Unscoped selector: ${selector}`)
    // Split only top-level selector commas, not :where(...) or :is(...).
    let depth = 0
    for (let index = 0; index < selector!.length; index++) {
      const character = selector![index]
      if (character === '(' || character === '[') depth++
      if (character === ')' || character === ']') depth--
      if (character === ',' && depth === 0) assert.ok(selector!.slice(index + 1).trim().startsWith('.fia-root'), selector)
    }
  }
  assert.equal(dimensionTokens['control-height'], '32px')
  assert.ok(financeCss.includes(':focus-visible'))
  assert.ok(financeCss.includes('prefers-reduced-motion:reduce'))
  assert.ok(!/var\([^)]*\)[\da-f]{2,}/i.test(financeCss), 'No invalid var(--color)12 hex concatenation')
  for (const theme of ['light', 'dark'] as const) for (const name of ['warning-soft', 'danger-soft', 'success-soft', 'info-soft'] as const) assert.match(palette[theme][name], /^#[\da-f]{6}$/i)
})

check('component element contracts use explicit non-submit buttons and semantic markup', () => {
  // Existing host code uses createElement(Component, props, children), not a children prop.
  assert.equal(createElement(FinanceTheme, { className: 'contract-root' }, 'content').props.children, 'content')
  assert.equal(Button({ children: 'Save' }).props.type, 'button')
  assert.equal(Button({ type: 'submit', children: 'Submit' }).props.type, 'submit')
  assert.match(Button({ variant: 'primary', children: 'Save' }).props.className, /fia-button--primary/)
  assert.equal(MetricCard({ label: 'NAV', value: '¥10' }).type, 'article')
  assert.equal(MetricCard({ label: 'NAV', value: '¥10', onClick() {} }).props.type, 'button')
  assert.match(StatusBadge({ tone: 'warning', children: 'Pending' }).props.className, /fia-badge--warning/)
  assert.equal(PageHeader({ title: 'Overview' }).type, 'header')
  assert.equal(EmptyState({ title: 'No data' }).type, 'section')
})

check('host theme parsing supports attributes, classes and color-scheme without false positives', () => {
  assert.equal(themeFromHostSignal({ dataTheme: 'dark', className: 'light' }), 'dark')
  assert.equal(themeFromHostSignal({ className: 'shell theme-dark' }), 'dark')
  assert.equal(themeFromHostSignal({ className: 'dark-mode' }), 'dark')
  assert.equal(themeFromHostSignal({ className: 'theme-light' }), 'light')
  assert.equal(themeFromHostSignal({ colorScheme: 'dark' }), 'dark')
  assert.equal(themeFromHostSignal({ className: 'highlight darkish', colorScheme: 'light dark' }), null)
  assert.equal(themeFromHostSignal({ dataTheme: 'system' }), null)
})

check('shared theme store: host/media/storage sync, denied storage, listener and observer disposal', () => {
  class FakeElement {
    attributes = new Map<string, string>()
    computedScheme = 'normal'
    constructor(public parentElement: FakeElement | null = null, className = '') { this.attributes.set('class', className) }
    classList = { contains: (name: string) => (this.attributes.get('class') ?? '').split(/\s+/).includes(name) }
    getAttribute(name: string) { return this.attributes.get(name) ?? null }
    contains(other: FakeElement): boolean { return this === other || !!other.parentElement && this.contains(other.parentElement) }
  }
  const html = new FakeElement()
  const body = new FakeElement(html)
  const host = new FakeElement(body)
  host.attributes.set('data-theme', 'dark')
  const root = new FakeElement(host, 'fia-root')
  const portal = new FakeElement(body, 'fia-root')
  const storageListeners = new Set<(event: { key: string | null; newValue: string | null }) => void>()
  const mediaListeners = new Set<() => void>()
  let deniedStorage = false
  let stored = JSON.stringify({ theme: 'system', marketMode: 'china' })
  const mql = { matches: true, addEventListener: (_: string, callback: () => void) => mediaListeners.add(callback), removeEventListener: (_: string, callback: () => void) => mediaListeners.delete(callback) }
  const observers = new Set<FakeObserver>()
  class FakeObserver {
    constructor(public callback: (records: Array<{ target: FakeElement }>) => void) {}
    observe() { observers.add(this) }
    disconnect() { observers.delete(this) }
  }
  const globals = globalThis as unknown as Record<string, unknown>
  const names = ['window', 'document', 'Element', 'MutationObserver']
  const originals = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name))
  const fakeWindow = {
    matchMedia: () => mql,
    getComputedStyle: (element: FakeElement) => ({ colorScheme: element.computedScheme }),
    addEventListener: (name: string, callback: (event: { key: string | null; newValue: string | null }) => void) => { if (name === 'storage') storageListeners.add(callback) },
    removeEventListener: (name: string, callback: (event: { key: string | null; newValue: string | null }) => void) => { if (name === 'storage') storageListeners.delete(callback) },
    localStorage: {
      getItem: () => { if (deniedStorage) throw new Error('SecurityError'); return stored },
      setItem: (_key: string, value: string) => { if (deniedStorage) throw new Error('QuotaExceededError'); stored = value },
    },
  }
  for (const [name, value] of Object.entries({ window: fakeWindow, document: { body, documentElement: html }, Element: FakeElement, MutationObserver: FakeObserver })) Object.defineProperty(globals, name, { value, writable: true, configurable: true })
  let unroot = () => {}; let unportal = () => {}; let unsubA = () => {}; let unsubB = () => {}
  try {
    unroot = registerThemeRoot(root as unknown as HTMLElement)
    let updatesA = 0; let updatesB = 0
    unsubA = subscribeTheme(() => updatesA++)
    unsubB = subscribeTheme(() => updatesB++)
    unportal = registerThemeRoot(portal as unknown as HTMLElement)
    assert.equal(getThemeSnapshot().resolved, 'dark')
    assert.equal(observers.size, 1)
    assert.equal(mediaListeners.size, 1)
    assert.equal(storageListeners.size, 1)
    const changed = () => { for (const observer of observers) observer.callback([{ target: host }]) }
    setThemePreference('light')
    assert.equal(getThemeSnapshot().resolved, 'light')
    assert.ok(updatesA > 0 && updatesB > 0)
    setThemePreference('system')
    assert.equal(getThemeSnapshot().resolved, 'dark')
    host.attributes.set('data-theme', 'light'); changed()
    assert.equal(getThemeSnapshot().resolved, 'light')
    host.attributes.delete('data-theme'); host.attributes.set('class', 'theme-dark'); changed()
    assert.equal(getThemeSnapshot().resolved, 'dark')
    host.attributes.delete('class'); host.computedScheme = 'light'; changed()
    assert.equal(getThemeSnapshot().resolved, 'light')
    host.computedScheme = 'normal'; mql.matches = true
    for (const callback of mediaListeners) callback()
    assert.equal(getThemeSnapshot().resolved, 'dark')
    mql.matches = false
    for (const callback of mediaListeners) callback()
    assert.equal(getThemeSnapshot().resolved, 'light')
    setMarketMode('accessible')
    assert.equal(getThemeSnapshot().marketMode, 'accessible')
    for (const callback of storageListeners) callback({ key: THEME_STORAGE_KEY, newValue: JSON.stringify({ theme: 'dark', marketMode: 'international' }) })
    assert.equal(getThemeSnapshot().resolved, 'dark')
    assert.equal(getThemeSnapshot().marketMode, 'international')
    for (const callback of storageListeners) callback({ key: THEME_STORAGE_KEY, newValue: '{invalid json' })
    assert.equal(getThemeSnapshot().resolved, 'dark')
    deniedStorage = true
    assert.doesNotThrow(() => setThemePreference('light'))
    assert.doesNotThrow(() => setMarketMode('china'))
    assert.equal(getThemeSnapshot().resolved, 'light')
    assert.deepEqual(getServerThemeSnapshot(), { preference: 'system', resolved: 'light', marketMode: 'china' })
    unsubA(); assert.equal(observers.size, 1)
    unsubB(); assert.equal(observers.size, 0)
    assert.equal(mediaListeners.size, 0)
    assert.equal(storageListeners.size, 0)
    // Reconnect while getItem itself throws, not only setItem.
    assert.doesNotThrow(() => { unsubA = subscribeTheme(() => updatesA++) })
    assert.equal(getThemeSnapshot().resolved, 'light')
    assert.equal(observers.size, 1)
    for (const callback of storageListeners) callback({ key: THEME_STORAGE_KEY, newValue: null })
    assert.equal(getThemeSnapshot().preference, 'system')
    assert.equal(getThemeSnapshot().marketMode, 'china')
    unsubA()
    assert.equal(observers.size, 0)
    assert.equal(mediaListeners.size, 0)
    assert.equal(storageListeners.size, 0)
  } finally {
    unsubA(); unsubB(); unportal(); unroot()
    names.forEach((name, index) => {
      const descriptor = originals[index]
      if (descriptor) Object.defineProperty(globals, name, descriptor)
      else delete globals[name]
    })
  }
})

console.log(`\nPASS: ${checks} Institutional Finance offline contract groups. Browser visual/keyboard acceptance is NOT claimed.`)
