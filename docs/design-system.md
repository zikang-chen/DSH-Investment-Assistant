# Institutional Finance · Phase 1 design system

Scope: UI-only primitives, theme preference and deterministic display formatting. No request, finance calculation, transaction, holding, advice or private-data behavior changes. React is external and supplied by the host; no runtime dependency was added.

## Public interface

Import from `src/client/design-system/index.ts` (NodeNext callers use `./design-system/index.js`).

```tsx
import {
  FinanceTheme, ThemeControls, Button, PageHeader, StatusBadge, EmptyState, MetricCard,
  formatMoney, formatPercent, formatPoints,
} from './design-system/index.js'

<FinanceTheme className="finance-panel" style={{ minHeight: '100%' }}>
  <PageHeader title="投资判断" eyebrow="RESEARCH WORKSPACE"
    description="先核验证据，再记录条件性判断。" actions={<ThemeControls compact />} />
  <MetricCard label="已定价资产" value={formatMoney(123456.78)} asOf="2026-11-16" />
  <StatusBadge tone="warning">待补证据</StatusBadge>
  <Button variant="primary" onClick={openEditor}>记录判断</Button>
  <EmptyState title="暂无判断" description="先建立一条可复核的判断。"
    action={<Button onClick={openEditor}>新建判断</Button>} />
</FinanceTheme>
```

- `FinanceTheme({ children, className?, style? })`: renders a `.fia-root` div, resolved `data-fia-theme="light|dark"`, preference `data-fia-theme-preference="system|light|dark"`, and `data-fia-market` / `data-fia-market-mode="china|international|accessible"`.
- Every body-level portal must also use `FinanceTheme`; a DOM portal does not inherit CSS variables from its React parent. A module-level `useSyncExternalStore` synchronizes all roots, including portals, without relying on context ancestry.
- `ThemeControls({ compact? })`: labeled native select controls for 跟随宿主/浅色/深色 and 中国红涨绿跌/国际绿涨红跌/色觉友好蓝涨橙跌. Compact hides the visible field caption, not the accessible name.
- `Button`: native button props, `variant="primary|secondary|ghost"` (default secondary), `type="button"` by default; explicit submit is supported.
- `PageHeader({ title, description?, eyebrow?, actions?, className? })`: semantic header with h1. Only use once per page; copy/action nodes may be React nodes.
- `StatusBadge({ tone?, children, className?, title? })`: neutral/info/success/warning/danger; explicit text is always required. It is not an ARIA live region by default.
- `EmptyState({ title, description?, action?, className? })`: semantic section with h2 and one optional action.
- `MetricCard({ label, value, detail?, asOf?, onClick?, className? })`: article unless clickable, then a native keyboard-operable `type="button"`. No nested interactive controls inside a clickable card. `asOf` displays “截至 …”; a missing value renders an em dash, not zero.
- `useFinanceTheme()` returns `{ preference, resolved, marketMode, setThemePreference, setMarketMode }`. The same setters, snapshot getter, subscription function, palettes, CSS string and contrast utilities are exported for integration/testing. No drawer is included in this layer.

## Theme resolution and lifecycle

1. Explicit finance light/dark preference wins.
2. In system mode, mounted-root ancestors are examined for host `data-theme`, `data-color-scheme`, or `data-mode` with light/dark values, then exact light/dark, theme-light/theme-dark, light-theme/dark-theme, light-mode/dark-mode class names.
3. Explicit attributes/classes take precedence over computed `color-scheme`. A single light or dark scheme is recognized; ambiguous `light dark` defers.
4. Without a host signal, `matchMedia('(prefers-color-scheme: dark)')` decides. Browserless rendering has a deterministic light fallback.

The first mounted root is canonical so a portal beneath body cannot silently choose a different host from the panel. Finance roots are skipped while inspecting host signals. The store observes only relevant host-ancestor attribute changes; its own root datasets and content mutations do not create observer feedback loops. Preference persistence uses the single key `fia.preferences.v1` with `{ "theme": "system", "marketMode": "china" }`. Invalid JSON, denied storage access and quota errors are ignored; in-memory preferences remain usable. Storage events synchronize other windows. No finance data is stored or transmitted by this layer.

The first store subscription installs one MutationObserver, one media-query listener and one storage listener. The last unsubscribe disconnects all of them. Each wrapper registers/unregisters its own root. Legacy media-query addListener/removeListener is supported. Styles are rendered inside each wrapper so unmount removes them; there are no import-time DOM side effects or styles appended to document head/body. Initial SSR/very-first-client paint can be light before the subscription resolves the host; no pre-hydration global script is introduced.

## Visual language and tokens

A restrained research workspace, not a trading terminal or marketing dashboard:

- Canvas is a cool neutral; content lives on calm bordered surfaces. Primary navy blue identifies actions, not returns.
- Light brand `#1D4D7D`; dark brand `#83B7E8`. Dark primary-button text uses deep `--fia-on-primary`, **not white**.
- Deep headers use `--fia-navy` with `--fia-on-dark`. `--fia-gold` is an accent/chart color, not a small text color on a white surface.
- Typography is 13px base, 12px secondary and 24px page/metric title; tabular numerals for amounts and tables. Long Chinese copy wraps rather than clipping evidence.
- A 4px spacing scale: `--fia-space-0/1/2/3/4/5/6/8/10/12`; radii `--fia-radius-sm/md/lg/xl/pill`. Control height is `--fia-control-height:32px`. Textareas can grow vertically.
- Plain bordered cards, no blanket oversized shadows; cards should correspond to meaningful information groups rather than every value.

### Semantic token contract

All tokens live on `.fia-root`, never `:root`, body or host attributes. All component/reset CSS selectors are scoped beneath `.fia-root`. The stylesheet is a TypeScript string (`styles.ts` plus generated `tokenCss`) so the existing single-JavaScript client bundler does not need a new CSS pipeline.

Required colors: `--fia-brand`, `--fia-canvas`, `--fia-surface`, `--fia-surface-muted`, `--fia-hover`, `--fia-text`, `--fia-secondary`, `--fia-muted`, `--fia-border`, `--fia-selected`, `--fia-focus`, `--fia-info`, `--fia-success`, `--fia-warning`, `--fia-danger`, `--fia-up`, `--fia-down`, `--fia-flat`, `--fia-chart-1` through `--fia-chart-5`, `--fia-grid`, `--fia-on-primary`, `--fia-navy`, `--fia-gold`, `--fia-on-dark`.

Soft backgrounds are independent concrete colors: `--fia-neutral-soft`, `--fia-info-soft`, `--fia-success-soft`, `--fia-warning-soft`, `--fia-danger-soft`. **Never append hex alpha text to a variable**, e.g. `var(--fia-warning)12` is invalid CSS. Use a soft token, or a valid explicit CSS color function if a new token is justified.

Market direction and workflow status must remain separate:

| Mode | Up | Down | Workflow status |
| --- | --- | --- | --- |
| china | red | green | unchanged |
| international | green | red | unchanged |
| accessible | blue | orange | unchanged |

`fia-up`, `fia-down`, `fia-flat` and `fia-change[data-direction]` use market tokens. Always render +/−, ↑/↓ or explicit 涨/跌/持平 text alongside color; accessible mode is not a promise of distinguishability for every visual condition. Never color every unknown or negative datum red. Success means a completed/valid process, danger means an actual error/risk, warning means attention, and neutral means unknown/not yet evaluated. A negative return is not automatically a danger status.

Chart series tokens are categorical, invariant across market modes and independent of status. Line pattern, markers and labels must supplement color when charts are implemented. `getFinanceTokens(theme, marketMode)` returns concrete values for canvas/SVG libraries; `palette`, `marketPalette`, `contrastRatio` and `relativeLuminance` are exported for audits.

Additional class primitives: `.fia-card`, `.fia-table` (numeric cells use `data-numeric="true"`), `.fia-number`, `.fia-text-secondary`, `.fia-text-muted`, `.fia-link`, `.fia-sr-only`. Class styles do not change route logic or make existing raw elements interactive.

## Display formatting, not financial math

All numeric functions accept `number | null | undefined`. Null, undefined, NaN and ±Infinity produce `—`. Strings are intentionally not coerced. Financial calculations remain upstream; these functions format display values only.

| Function | Default / example |
| --- | --- |
| `formatNumber(value, options?)` | `formatNumber(1234.5)` → `1,234.50` |
| `formatMoney(value, options?)` | `formatMoney(1234.5)` → `¥1,234.50`; `{ currency:'USD' }`, `{ symbol:false }` supported |
| `formatPercent(value, options?)` | **Default input is percent-number, not ratio**: `5` → `5.00%`, `.05` → `0.05%`; `.05,{input:'ratio'}` → `5.00%` |
| `formatPoints(value, options?)` | `1.5` → `1.50 pp` (percentage points), never `%`; optional suffix ` 个百分点` or ` bp`; suffix does not rescale input |
| `formatCompact(value, options?)` | `12345` → `1.23万`; `123456789` → `1.23亿`; rounding can promote the unit |
| `formatDate(value, options?)` | date-only remains `YYYY-MM-DD`; instants default explicitly to Asia/Shanghai; `{ timeZone:'UTC', includeTime:true }` supported |

Numeric options: `decimals` (default 2), `minimumFractionDigits`, `maximumFractionDigits`, `signed` (default false), `locale` (default zh-CN), `useGrouping` (default true). A number as the second argument is shorthand for decimals. Compact format trims trailing zeroes unless minimumFractionDigits is explicit. Precision is clamped to 0–20 decimals. Money always defaults to two decimals even for currencies with another native convention; choose decimals explicitly when appropriate.

Positive signed values use `+`; negative values use the typographic minus `−` (U+2212). Negative zero and magnitudes rounding to zero have no sign. A basis-point value must already be in basis points if using the bp suffix. Example: a return moving from 5% to 7% changed **2 pp**, not 2% relative; a relative gain would be 40% and requires a separate upstream calculation.

No formatter guesses live data freshness, currency conversions, net-value T+1 timing, units or financial reporting periods. Supply as-of labels from actual source metadata. JavaScript Number/Intl formatting is not an arbitrary-precision money engine.

## 页面布局与集成（本轮 Phase 1–2）

- 主面板外层 `FinanceTheme` 的 `.fia-panel` 为尺寸容器；不修改 Harness 的全局主题属性，不额外启动独立应用。
- 面板宽度 < 740px 使用顶部五入口；≥740px 使用深蓝侧导航；≥1050px 首页四卡一排、研究区双列、判断详情双栏。≤420px 卡片/页头单列。面板支持「展开/收窄」及原有拖动宽度（360–1280px，上限受视口限制）。这些是**容器宽度**而非整台显示器宽度。
- 所有全屏资料/个股详情 Portal 到已有宿主根，并重新包 `FinanceTheme`。不能把 viewport fixed 弹层留在 `container-type:inline-size` 的后代，否则 fixed 包含块会变成侧栏，资料正文会被压窄。
- 首页以「今日投资工作台」+问题入口+资本/中国市场/待办/观点四张卡+政策/研究两区组织。原 PersonalHome 以 embedded 模式接入，去除大横幅和重复统计，但保留规划修复、投资档案、每周复盘、人工确认与所有锚点。
- 投资判断用独立 `InvestmentWorkbench` 展示结构化报告。快速/深度是单一主按钮的模式切换；默认不允许个人组合进入模型。列表与详情分别加载；详情以真实 `dataFreshness` 对象展示数据日期、状态、说明；筛选交给已有服务端查询，超过显示窗口明确提示。
- 学习入口改为按需原生 dialog 抽屉：三级切换、Escape、焦点恢复，不常驻大段词条，不重发研究。
- 投递反馈必须区分“已请求提交、等待目标会话确认”“已复制，尚未发送”“失败”。宿主 submit 没有实际模型完成回执，不能冒称分析已完成。
- SSE 仅刷新变更模块；资本账本目前无专用变更事件，仅其本地快照在窗口聚焦/可见的30秒间隔刷新，并保留手动刷新。
- K线画布通过 `chart-theme.ts` 读取 concrete chart tokens；中国/国际/色觉友好同时影响蜡烛与行情数字，但不改变业务成功/失败颜色。OHLC、均线、回撤等计算代码不变。
- 深蓝头栏/左导航使用 `--fia-on-dark` 的独立焦点环，不能直接使用浅色页面的深蓝 focus 色。
- 保持按钮 32px、数据表数值右对齐/等宽数字、表格自身横向滚动。旧页面仍通过兼容映射逐步迁移，**并非本轮所有历史硬编码都已消除**。

## Verification

Offline command (does not write compiled artifacts or touch private data):

```powershell
node node_modules/tsx/dist/cli.mjs scripts/test_design_system.ts
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```

The 12 contract groups cover amount precision/currency/signs/negative-zero; percent vs ratio vs pp; missing values; compact-unit promotion; dates/time zones; WCAG math reference; both-theme text/secondary/muted and primary-button contrast; market/status/chart independence; scoped CSS, 32px, focus-visible, reduced motion and concrete soft tokens; button/semantic element contracts; host-signal parsing; shared-store host/media/storage synchronization, denied storage, and observer/listener disposal using a deliberately small mocked browser environment.

Measured contrast on the default surface:

| Pair | Light | Dark |
| --- | ---: | ---: |
| body / surface | 14.53:1 | 13.77:1 |
| secondary / surface | 6.91:1 | 9.24:1 |
| primary-button text / brand | 8.71:1 | 6.91:1 |

Body, secondary and muted text are also checked against canvas, muted surface, hover and selected surfaces at ≥4.5:1. All four semantic badge foregrounds/soft backgrounds and all market direction colors/default surface are checked at ≥4.5:1. Focus/default surface is checked at ≥3:1. Borders/grid and decorative gold are not claimed as body-text colors; custom combinations and overrides require new measurements.

**Boundary:** these checks are deterministic unit/static contracts, not real-browser visual or keyboard acceptance. They do not prove every legacy page has adopted tokens, that host CSS cannot override a component, that actual DSH DOM signals match the mock, or that a drawer/chart/live data view works. Before release, verify the existing GUI at light/dark/system, each market mode, a body-level portal, compact/320px layout, keyboard tab/focus, native select, 200% zoom, reduced motion, denied localStorage and mount/unmount. Do not claim screenshot/browser validation without actually executing it.
