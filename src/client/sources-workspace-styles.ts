/** Scoped to the finance root AND source workspace; no host or MCP descendant resets. */
export const sourcesWorkspaceCss = `
.fia-root .fia-sources{display:flex;flex-direction:column;gap:var(--fia-space-4);min-width:0;container-type:inline-size}
.fia-root .fia-sources .fia-page-header{margin-bottom:0}
.fia-root .fia-sources__toolbar{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:var(--fia-space-3);padding:var(--fia-space-3) 0;border-bottom:1px solid var(--fia-border)}
.fia-root .fia-sources__toolbar-copy{display:flex;flex-wrap:wrap;align-items:center;gap:var(--fia-space-2);color:var(--fia-secondary);font-size:var(--fia-font-sm)}
.fia-root .fia-sources__actions{display:flex;flex-wrap:wrap;gap:var(--fia-space-2)}
.fia-root .fia-sources__note{margin:0;color:var(--fia-secondary);font-size:var(--fia-font-sm);overflow-wrap:anywhere}
.fia-root .fia-sources__feedback{padding:var(--fia-space-3);border:1px solid var(--fia-border);border-radius:var(--fia-radius-sm);background:var(--fia-surface-muted);color:var(--fia-secondary);font-size:var(--fia-font-sm);overflow-wrap:anywhere}
.fia-root .fia-sources__feedback[data-tone=warning]{border-color:var(--fia-warning);color:var(--fia-warning);background:var(--fia-warning-soft)}
.fia-root .fia-sources__feedback[data-tone=error]{border-color:var(--fia-danger);color:var(--fia-danger);background:var(--fia-danger-soft)}
.fia-root .fia-sources__section{display:flex;flex-direction:column;gap:var(--fia-space-2);min-width:0}
.fia-root .fia-sources__section-title{margin:0;color:var(--fia-text);font-size:var(--fia-font-lg);line-height:1.4;font-weight:600}
.fia-root .fia-sources__fold{min-width:0;border:1px solid var(--fia-border);border-radius:var(--fia-radius-md);background:var(--fia-surface);overflow:hidden}
.fia-root .fia-sources__summary{display:list-item;list-style:disclosure-closed inside;cursor:pointer;padding:var(--fia-space-3);color:var(--fia-secondary);overflow-wrap:anywhere}
.fia-root .fia-sources__fold[open]>.fia-sources__summary{list-style-type:disclosure-open;background:var(--fia-surface-muted);border-bottom:1px solid var(--fia-border)}
.fia-root .fia-sources__summary:hover{background:var(--fia-hover)}
.fia-root .fia-sources__summary-main{display:inline;font-weight:600;color:var(--fia-text);font-size:var(--fia-font-base);margin-inline-end:var(--fia-space-3)}
.fia-root .fia-sources__summary-meta{display:inline;color:var(--fia-secondary);font-size:var(--fia-font-sm);font-variant-numeric:tabular-nums}
.fia-root .fia-sources__summary-sub{display:block;margin-top:var(--fia-space-1);padding-inline-start:var(--fia-space-4);color:var(--fia-muted);font-size:var(--fia-font-xs);line-height:1.5;overflow-wrap:anywhere}
.fia-root .fia-sources__body{display:flex;flex-direction:column;gap:var(--fia-space-3);min-width:0;padding:var(--fia-space-3)}
.fia-root .fia-sources__mode{display:flex;align-items:center;flex-wrap:wrap;gap:var(--fia-space-2);font-size:var(--fia-font-sm);color:var(--fia-secondary)}
.fia-root .fia-sources__mode label{display:flex;align-items:center;flex-wrap:wrap;gap:var(--fia-space-2)}
.fia-root .fia-sources__code{font-family:var(--fia-font-mono);font-size:var(--fia-font-xs);color:var(--fia-muted);overflow-wrap:anywhere;word-break:break-word}
.fia-root .fia-sources__table-wrap{min-width:0;max-width:100%;overflow-x:auto;border:1px solid var(--fia-border);border-radius:var(--fia-radius-sm)}
.fia-root .fia-sources__table{min-width:520px}
.fia-root .fia-sources__table th{font-size:var(--fia-font-xs);white-space:nowrap}
.fia-root .fia-sources__table td{vertical-align:top}
.fia-root .fia-sources__table tr:last-child td{border-bottom:0}
.fia-root .fia-sources__provider{display:flex;flex-direction:column;gap:var(--fia-space-1);min-width:0;max-width:360px}
.fia-root .fia-sources__check{display:inline-flex;align-items:center;gap:var(--fia-space-2);min-height:var(--fia-control-height);white-space:nowrap;cursor:pointer}
.fia-root .fia-sources__check:has(input:disabled){cursor:default}
.fia-root .fia-sources__check input{width:14px;height:14px;margin:0;flex:0 0 auto}
.fia-root .fia-sources__group{display:flex;flex-direction:column;gap:var(--fia-space-2);min-width:0}
.fia-root .fia-sources__group-title{margin:0;color:var(--fia-secondary);font-size:var(--fia-font-sm);font-weight:600}
.fia-root .fia-sources__legend{display:flex;flex-wrap:wrap;align-items:center;gap:var(--fia-space-2);color:var(--fia-muted);font-size:var(--fia-font-xs)}
@container(max-width:540px){.fia-root .fia-sources__toolbar{align-items:flex-start;flex-direction:column}.fia-root .fia-sources__summary-main{display:inline-block}.fia-root .fia-sources__summary-meta{display:block;margin-top:var(--fia-space-1);padding-inline-start:var(--fia-space-4)}.fia-root .fia-sources__body{padding:var(--fia-space-2)}}
`
