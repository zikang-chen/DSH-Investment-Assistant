import { useEffect, useRef, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react'
import { financeCss } from './styles.js'
import { registerThemeRoot, useFinanceTheme } from './theme-store.js'
import type { MarketMode, ThemePreference } from './tokens.js'

const classes = (...names: Array<string | undefined | false>) => names.filter(Boolean).join(' ')

export interface FinanceThemeProps { children?: ReactNode; className?: string; style?: CSSProperties }

/** Wrap every panel AND every body-level portal. Shared store keeps all roots in sync. */
export function FinanceTheme({ children, className, style }: FinanceThemeProps) {
  const { preference, resolved, marketMode } = useFinanceTheme()
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => root.current ? registerThemeRoot(root.current) : undefined, [])
  return <div ref={root} className={classes('fia-root', className)} style={style}
    data-fia-theme={resolved} data-fia-theme-preference={preference}
    data-fia-market={marketMode} data-fia-market-mode={marketMode}>
    <style data-fia-styles="institutional-finance">{financeCss}</style>
    {children}
  </div>
}

export function ThemeControls({ compact = false }: { compact?: boolean }) {
  const { preference, marketMode, setThemePreference, setMarketMode } = useFinanceTheme()
  return <div className="fia-theme-controls" data-compact={compact}>
    <label className="fia-theme-controls__field">
      <span className={compact ? 'fia-sr-only' : undefined}>外观</span>
      <select aria-label="金融面板主题" value={preference} onChange={(event) => setThemePreference(event.target.value as ThemePreference)}>
        <option value="system">跟随宿主</option><option value="light">浅色</option><option value="dark">深色</option>
      </select>
    </label>
    <label className="fia-theme-controls__field">
      <span className={compact ? 'fia-sr-only' : undefined}>涨跌配色</span>
      <select aria-label="市场涨跌配色" value={marketMode} onChange={(event) => setMarketMode(event.target.value as MarketMode)}>
        <option value="china">中国 · 红涨绿跌</option><option value="international">国际 · 绿涨红跌</option><option value="accessible">色觉友好 · 蓝涨橙跌</option>
      </select>
    </label>
  </div>
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> { variant?: 'primary' | 'secondary' | 'ghost' }
export function Button({ variant = 'secondary', type = 'button', className, children, ...props }: ButtonProps) {
  return <button {...props} type={type} className={classes('fia-button', `fia-button--${variant}`, className)}>{children}</button>
}

export interface PageHeaderProps { title: ReactNode; description?: ReactNode; eyebrow?: ReactNode; actions?: ReactNode; className?: string }
export function PageHeader({ title, description, eyebrow, actions, className }: PageHeaderProps) {
  return <header className={classes('fia-page-header', className)}>
    <div className="fia-page-header__copy">
      {eyebrow != null && <div className="fia-page-header__eyebrow">{eyebrow}</div>}
      <h1 className="fia-page-header__title">{title}</h1>
      {description != null && <div className="fia-page-header__description">{description}</div>}
    </div>
    {actions != null && <div className="fia-page-header__actions">{actions}</div>}
  </header>
}

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'
export interface StatusBadgeProps { tone?: StatusTone; children: ReactNode; className?: string; title?: string }
/** Workflow status never reads the selected market color mode. Keep a visible text label. */
export function StatusBadge({ tone = 'neutral', children, className, title }: StatusBadgeProps) {
  return <span className={classes('fia-badge', `fia-badge--${tone}`, className)} title={title}>{children}</span>
}

export interface EmptyStateProps { title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string }
export function EmptyState({ title, description, action, className }: EmptyStateProps) {
  return <section className={classes('fia-empty', className)}>
    <h2 className="fia-empty__title">{title}</h2>
    {description != null && <div className="fia-empty__description">{description}</div>}
    {action != null && <div className="fia-empty__action">{action}</div>}
  </section>
}

export interface MetricCardProps { label: ReactNode; value: ReactNode; detail?: ReactNode; asOf?: ReactNode; onClick?: () => void; className?: string }
export function MetricCard({ label, value, detail, asOf, onClick, className }: MetricCardProps) {
  const content = <>
    <span className="fia-metric__label">{label}</span>
    <span className="fia-metric__value">{value ?? '—'}</span>
    {detail != null && <span className="fia-metric__detail">{detail}</span>}
    {asOf != null && <span className="fia-metric__asof">截至 {asOf}</span>}
  </>
  return onClick
    ? <button type="button" className={classes('fia-metric', className)} onClick={onClick}>{content}</button>
    : <article className={classes('fia-metric', className)}>{content}</article>
}
