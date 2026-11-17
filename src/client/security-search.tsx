import { useEffect, useId, useRef, useState } from 'react'
import { Button, StatusBadge } from './design-system/index.js'
import type { ReadApi } from './workbench-model.js'
import { identityFromMatch, uniqueMatches, type SecurityIdentity, type SecurityMatch } from './security-model.js'
import { SECURITY_CSS } from './security-styles.js'

export interface SecuritySearchProps {
  get: ReadApi
  onSelect: (item: SecurityIdentity) => void
  onQueryChange?: (query: string) => void
  label?: string
  placeholder?: string
  compact?: boolean
  initialQuery?: string
}
/** Real provider-backed suggestions, not a local list of popular names. Never picks the first match silently. */
export function SecuritySearch({ get, onSelect, onQueryChange, label = '查找股票或基金', placeholder = '输入代码或名称片段，如：中国、工商银行、腾讯、AAPL', compact = false, initialQuery = '' }: SecuritySearchProps) {
  const [query, setQuery] = useState(initialQuery)
  const [rows, setRows] = useState<SecurityMatch[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [searched, setSearched] = useState(false)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [composing, setComposing] = useState(false)
  const [intent, setIntent] = useState(false)
  const [retry, setRetry] = useState(0)
  const request = useRef(0)
  const input = useRef<HTMLInputElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const uid = useId(), listId = `${uid}-list`
  useEffect(() => {
    if (!query.trim() || !intent || composing) return
    const id = ++request.current
    const timer = window.setTimeout(() => {
      setBusy(true); setError(''); setOpen(true)
      void get<{ ok: boolean; matches?: SecurityMatch[]; error?: string }>(`/search?q=${encodeURIComponent(query.trim())}&limit=30`).then(result => {
        if (!result.ok) throw new Error(result.error ?? '检索源暂不可用')
        if (request.current !== id) return
        setRows(uniqueMatches(result.matches ?? [])); setSearched(true); setActive(-1)
      }).catch(err => {
        if (request.current !== id) return
        setRows([]); setError(err instanceof Error ? err.message : String(err)); setSearched(true)
      }).finally(() => { if (request.current === id) setBusy(false) })
    }, 300)
    return () => { window.clearTimeout(timer); if (request.current === id) request.current++ }
  }, [get, query, intent, composing, retry])
  useEffect(() => {
    const outside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [])
  useEffect(() => { if (active >= 0) document.getElementById(`${uid}-option-${active}`)?.scrollIntoView({ block: 'nearest' }) }, [active, uid])
  const choose = (row: SecurityMatch) => {
    const item = identityFromMatch(row)
    if (!item) return
    request.current++
    setIntent(false); setBusy(false); setOpen(false); setQuery(`${row.name} · ${row.code}`)
    onSelect(item)
  }
  const run = () => { if (query.trim()) { setIntent(true); setOpen(true); setRetry(n => n + 1); input.current?.focus() } }
  return <div ref={root} className={`fia-security-search${compact ? ' is-compact' : ''}`}>
    <style>{SECURITY_CSS}</style>
    <label htmlFor={uid}>{label}</label>
    <div className="fia-security-search-input"><input id={uid} ref={input} role="combobox" autoComplete="off" value={query} placeholder={placeholder}
      aria-autocomplete="list" aria-expanded={open} aria-controls={listId} aria-activedescendant={open && active >= 0 ? `${uid}-option-${active}` : undefined}
      onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
      onChange={event => { const value = event.target.value; request.current++; setQuery(value); setRows([]); setActive(-1); setSearched(false); setError(''); setBusy(false); setOpen(!!value.trim()); setIntent(true); onQueryChange?.(value) }}
      onFocus={() => { if (rows.length || searched) setOpen(true) }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || composing) return
        if (event.key === 'Escape') { event.preventDefault(); setOpen(false); return }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); setActive(n => rows.length ? Math.min(rows.length - 1, Math.max(0, n + (event.key === 'ArrowDown' ? 1 : -1))) : -1) }
        if (event.key === 'Enter') { event.preventDefault(); if (open && active >= 0 && rows[active]) choose(rows[active]); else run() }
      }} />
      <Button onClick={run} disabled={!query.trim()}>{busy ? '检索中…' : '查找'}</Button></div>
    {open && <div className="fia-security-candidates">
      {busy && <p role="status">正在查询公开证券目录…</p>}
      {error && <p role="alert" className="fia-error-text">{error}。可稍后重新查找，不会用演示候选替代。</p>}
      {!busy && !error && searched && !rows.length && <p role="status">未匹配到候选。可试完整名称、代码或缩小关键词范围。</p>}
      {!busy && !error && rows.length > 0 && <><div id={listId} role="listbox" aria-label="证券匹配候选">{rows.map((row, index) => {
        const identity = identityFromMatch(row)
        return <button type="button" role="option" tabIndex={-1} id={`${uid}-option-${index}`} aria-selected={active === index} aria-disabled={!identity} key={`${row.market}-${row.type}-${row.code}`} onMouseEnter={() => setActive(index)} onClick={() => choose(row)}>
          <span><strong>{row.name}</strong><code>{row.code}</code></span><span><StatusBadge tone="neutral">{row.market || '市场未注明'}</StatusBadge><small>{identity ? identity.type === 'fund' ? '基金资料 →' : '股票资料 →' : '该类型暂不支持详情'}</small></span>
        </button>
      })}</div><p className="fia-security-search-note">候选由公开数据源返回，非全市场完整列表。请核对代码、市场和基金份额类别后选择；过宽关键词可继续输入完整名称。</p></>}
      {!busy && !error && !searched && <p className="fia-security-search-note">继续输入名称或代码，选择候选后再查看、分析或添加。</p>}
    </div>}
  </div>
}
