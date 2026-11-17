/** Institutional Finance tokens. Semantic status and market direction are intentionally separate. */
export type ResolvedTheme = 'light' | 'dark'
export type ThemePreference = 'system' | ResolvedTheme
export type MarketMode = 'china' | 'international' | 'accessible'

export const palette = {
  light: {
    brand: '#1D4D7D', canvas: '#F3F5F7', surface: '#FFFFFF', 'surface-muted': '#F6F8FA',
    hover: '#EAF0F5', text: '#182B3A', secondary: '#4A5C6C', muted: '#5E6D7B',
    border: '#D5DEE6', selected: '#E6EFF8', focus: '#235F9A',
    info: '#1D4D7D', success: '#176B4B', warning: '#8A5700', danger: '#AF3444',
    'neutral-soft': '#EDF1F5', 'info-soft': '#E6EFF8', 'success-soft': '#E7F3EC',
    'warning-soft': '#FFF2D4', 'danger-soft': '#FDECEF',
    'chart-1': '#1D4D7D', 'chart-2': '#8A6827', 'chart-3': '#6859A3',
    'chart-4': '#27797D', 'chart-5': '#A04F70', grid: '#D5DEE6',
    'on-primary': '#FFFFFF', navy: '#102A43', gold: '#B18A43', 'on-dark': '#F4F8FC',
  },
  dark: {
    brand: '#83B7E8', canvas: '#101820', surface: '#17232E', 'surface-muted': '#1C2A37',
    hover: '#263849', text: '#E9EFF5', secondary: '#B8C7D5', muted: '#9AAFBF',
    border: '#354958', selected: '#243E58', focus: '#A5CEFA',
    info: '#83B7E8', success: '#70D3A6', warning: '#F2C779', danger: '#FF9BA8',
    'neutral-soft': '#263440', 'info-soft': '#243E58', 'success-soft': '#1C382D',
    'warning-soft': '#3B3020', 'danger-soft': '#402630',
    'chart-1': '#83B7E8', 'chart-2': '#D7B472', 'chart-3': '#B6A1E4',
    'chart-4': '#72C4C6', 'chart-5': '#E39AB7', grid: '#354958',
    'on-primary': '#102A43', navy: '#0B1B2C', gold: '#D7B472', 'on-dark': '#F4F8FC',
  },
} as const

export type PaletteToken = keyof typeof palette.light

/** Chart series are categorical, NOT aliases for success/danger or market up/down. */
export const marketPalette = {
  light: {
    china: { up: '#B33242', down: '#167251', flat: '#5E6D7B' },
    international: { up: '#167251', down: '#B33242', flat: '#5E6D7B' },
    accessible: { up: '#245DA6', down: '#A65300', flat: '#5E6D7B' },
  },
  dark: {
    china: { up: '#FF9AA7', down: '#6CD4A1', flat: '#9AAFBF' },
    international: { up: '#6CD4A1', down: '#FF9AA7', flat: '#9AAFBF' },
    accessible: { up: '#8DBBFF', down: '#F6BA76', flat: '#9AAFBF' },
  },
} as const

export const dimensionTokens = {
  'space-0': '0', 'space-1': '4px', 'space-2': '8px', 'space-3': '12px',
  'space-4': '16px', 'space-5': '20px', 'space-6': '24px', 'space-8': '32px',
  'space-10': '40px', 'space-12': '48px',
  'radius-sm': '4px', 'radius-md': '8px', 'radius-lg': '12px', 'radius-xl': '16px', 'radius-pill': '999px',
  'font-xs': '11px', 'font-sm': '12px', 'font-base': '13px', 'font-lg': '16px', 'font-xl': '20px', 'font-2xl': '24px',
  'font-sans': '"Inter", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
  'font-mono': '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
  'control-height': '32px', 'line-height': '1.55', 'duration-fast': '120ms',
  'shadow-sm': '0 1px 3px rgb(10 30 50 / 5%)',
  'shadow-drawer': '0 12px 40px rgb(0 0 0 / 22%)',
} as const

/** WCAG 2 relative luminance. Strict six-digit hex is deliberate: invalid tokens fail loudly. */
export function relativeLuminance(hex: string): number {
  if (!/^#[\da-f]{6}$/i.test(hex)) throw new TypeError(`Expected #RRGGBB, received ${hex}`)
  const linear = [1, 3, 5].map((offset) => {
    const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
}

export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground)
  const b = relativeLuminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/** Read-only, concrete palette for charts, canvas and offline audits. */
export function getFinanceTokens(theme: ResolvedTheme, marketMode: MarketMode = 'china') {
  return { ...dimensionTokens, ...palette[theme], ...marketPalette[theme][marketMode] }
}

const declarations = (tokens: Record<string, string>) => Object.entries(tokens).map(([name, value]) => `--fia-${name}:${value};`).join('')

/** Every declaration is scoped to the finance root; nothing is written to :root or body. */
export const tokenCss = [
  `.fia-root{${declarations(dimensionTokens)}}`,
  ...(['light', 'dark'] as const).flatMap((theme) => [
    `.fia-root[data-fia-theme="${theme}"]{color-scheme:${theme};${declarations(palette[theme])}${declarations(marketPalette[theme].china)}}`,
    ...(['china', 'international', 'accessible'] as const).map((mode) =>
      `.fia-root[data-fia-theme="${theme}"][data-fia-market="${mode}"]{${declarations(marketPalette[theme][mode])}}`),
  ]),
].join('\n')
