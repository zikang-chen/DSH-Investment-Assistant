import { useSyncExternalStore } from 'react'
import type { MarketMode, ResolvedTheme, ThemePreference } from './tokens.js'

export const THEME_STORAGE_KEY = 'fia.preferences.v1'
export interface ThemeSnapshot {
  preference: ThemePreference
  resolved: ResolvedTheme
  marketMode: MarketMode
}
export interface HostThemeSignal { dataTheme?: string | null; className?: string; colorScheme?: string | null }

/** Pure resolver, also used by offline tests. Ambiguous light/dark and 'system' defer to the next source. */
export function themeFromHostSignal(signal: HostThemeSignal): ResolvedTheme | null {
  const data = signal.dataTheme?.trim().toLowerCase()
  if (data === 'dark' || data === 'light') return data
  const classes = (signal.className ?? '').toLowerCase().split(/\s+/)
  const dark = classes.some((name) => ['dark', 'theme-dark', 'dark-theme', 'dark-mode'].includes(name))
  const light = classes.some((name) => ['light', 'theme-light', 'light-theme', 'light-mode'].includes(name))
  if (dark !== light) return dark ? 'dark' : 'light'
  const scheme = signal.colorScheme?.trim().toLowerCase()
  return scheme === 'dark' || scheme === 'light' ? scheme : null
}

const serverSnapshot: ThemeSnapshot = Object.freeze({ preference: 'system', resolved: 'light', marketMode: 'china' })
let snapshot: ThemeSnapshot = serverSnapshot
const listeners = new Set<() => void>()
const roots = new Set<HTMLElement>()
let disconnect: (() => void) | undefined
let media: MediaQueryList | undefined
let preferencesLoaded = false
const isTheme = (value: unknown): value is ThemePreference => value === 'system' || value === 'light' || value === 'dark'
const isMarket = (value: unknown): value is MarketMode => value === 'china' || value === 'international' || value === 'accessible'
const inBrowser = () => typeof window !== 'undefined' && typeof document !== 'undefined'

function publish(next: ThemeSnapshot) {
  if (snapshot.preference === next.preference && snapshot.resolved === next.resolved && snapshot.marketMode === next.marketMode) return
  snapshot = Object.freeze(next)
  for (const notify of listeners) notify()
}

function hostTheme(): ResolvedTheme {
  if (!inBrowser()) return 'light'
  const ancestors: Element[] = []
  // The first mounted root is canonical, so body-level portals do not disagree with the panel.
  for (const root of roots) {
    let element = root.parentElement
    while (element) {
      if (!element.classList.contains('fia-root') && !ancestors.includes(element)) ancestors.push(element)
      element = element.parentElement
    }
  }
  for (const element of [document.body, document.documentElement]) {
    if (element && !ancestors.includes(element)) ancestors.push(element)
  }
  // Explicit host attributes/classes precede computed color-scheme (which may be inherited).
  for (const element of ancestors) {
    const theme = themeFromHostSignal({
      dataTheme: element.getAttribute('data-theme') ?? element.getAttribute('data-color-scheme') ?? element.getAttribute('data-mode'),
      className: element.getAttribute('class') ?? '',
    })
    if (theme) return theme
  }
  for (const element of ancestors) {
    let scheme = element.getAttribute('color-scheme')
    try { scheme = scheme ?? window.getComputedStyle(element).colorScheme } catch { /* Detached nodes / restrictive hosts. */ }
    const theme = themeFromHostSignal({ colorScheme: scheme })
    if (theme) return theme
  }
  return media?.matches ? 'dark' : 'light'
}

function refresh() {
  publish({ ...snapshot, resolved: snapshot.preference === 'system' ? hostTheme() : snapshot.preference })
}

function readPreferences(raw: string | null) {
  if (!raw) return
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return
    const data = parsed as Record<string, unknown>
    snapshot = Object.freeze({
      ...snapshot,
      preference: isTheme(data.theme) ? data.theme : snapshot.preference,
      marketMode: isMarket(data.marketMode) ? data.marketMode : snapshot.marketMode,
    })
  } catch { /* Malformed or blocked storage never prevents rendering. */ }
}

function loadPreferences() {
  if (!inBrowser()) return
  try { readPreferences(window.localStorage.getItem(THEME_STORAGE_KEY)) } catch { /* Private mode, security policy, quota. */ }
  preferencesLoaded = true
}

function persistPreferences() {
  if (!inBrowser()) return
  try { window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({ theme: snapshot.preference, marketMode: snapshot.marketMode })) } catch { /* In-memory preferences remain usable. */ }
}

function connect() {
  if (!inBrowser() || disconnect) return
  loadPreferences()
  try { media = window.matchMedia('(prefers-color-scheme: dark)') } catch { media = undefined }
  const onMedia = () => refresh()
  const mediaQuery = media
  if (typeof mediaQuery?.addEventListener === 'function') mediaQuery.addEventListener('change', onMedia)
  else mediaQuery?.addListener?.(onMedia)

  const onStorage = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return
    if (event.newValue === null) publish({ ...snapshot, preference: 'system', marketMode: 'china' })
    else {
      const before = snapshot
      readPreferences(event.newValue)
      const loaded = snapshot
      snapshot = before
      publish(loaded)
    }
    refresh()
  }
  window.addEventListener('storage', onStorage)
  const Observer = typeof MutationObserver === 'undefined' ? undefined : MutationObserver
  const observer = Observer ? new Observer((records) => {
    // Ignore our own dataset/styles and content churn; only host ancestors can affect auto mode.
    const hostChanged = records.some(({ target }) => target instanceof Element && !target.classList.contains('fia-root') && (
      target === document.documentElement || target === document.body || [...roots].some((root) => target.contains(root))
    ))
    if (hostChanged && snapshot.preference === 'system') refresh()
  }) : undefined
  observer?.observe(document.documentElement, {
    subtree: true, attributes: true,
    attributeFilter: ['data-theme', 'data-color-scheme', 'data-mode', 'class', 'style', 'color-scheme'],
  })
  refresh()
  disconnect = () => {
    observer?.disconnect()
    window.removeEventListener('storage', onStorage)
    if (typeof mediaQuery?.removeEventListener === 'function') mediaQuery.removeEventListener('change', onMedia)
    else mediaQuery?.removeListener?.(onMedia)
    media = undefined
    disconnect = undefined
  }
}

export function getThemeSnapshot(): ThemeSnapshot { return snapshot }
export function getServerThemeSnapshot(): ThemeSnapshot { return serverSnapshot }

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener)
  connect()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) disconnect?.()
  }
}

/** Register panel or portal roots without adding document-global CSS or attributes. */
export function registerThemeRoot(root: HTMLElement): () => void {
  roots.add(root)
  refresh()
  return () => { roots.delete(root); refresh() }
}

export function setThemePreference(preference: ThemePreference) {
  if (!isTheme(preference)) return
  if (!preferencesLoaded) loadPreferences()
  publish({ ...snapshot, preference, resolved: preference === 'system' ? hostTheme() : preference })
  persistPreferences()
}

export function setMarketMode(marketMode: MarketMode) {
  if (!isMarket(marketMode)) return
  if (!preferencesLoaded) loadPreferences()
  publish({ ...snapshot, marketMode })
  persistPreferences()
}

export function useFinanceTheme() {
  const state = useSyncExternalStore(subscribeTheme, getThemeSnapshot, getServerThemeSnapshot)
  return { ...state, setThemePreference, setMarketMode }
}
