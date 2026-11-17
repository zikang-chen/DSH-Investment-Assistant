export const SECURITY_CSS = `
.fia-root .fia-security-search{position:relative;min-width:0;width:100%;font-size:12px}
.fia-root .fia-security-search>label{display:block;font-weight:600;color:var(--fia-secondary);margin-bottom:6px}
.fia-root .fia-security-search-input{display:flex;gap:8px;min-width:0}
.fia-root .fia-security-search-input>input{min-width:0;flex:1;width:100%}
.fia-root .fia-security-candidates{position:absolute;top:calc(100% + 5px);left:0;right:0;z-index:20;background:var(--fia-surface);color:var(--fia-text);border:1px solid var(--fia-border);border-radius:8px;box-shadow:var(--fia-shadow-drawer);max-height:360px;overflow-y:auto;overscroll-behavior:contain;padding:5px}
.fia-root .fia-security-candidates [role=option]{display:flex;flex-direction:column;align-items:stretch;gap:4px;background:transparent;border:0;border-bottom:1px solid var(--fia-border);padding:9px 10px;text-align:left;width:100%;min-width:0;cursor:pointer;color:var(--fia-text);font:inherit;min-height:52px}
.fia-root .fia-security-candidates [role=option][aria-selected=true],.fia-root .fia-security-candidates [role=option]:hover{background:var(--fia-selected)}
.fia-root .fia-security-candidates [role=option][aria-disabled=true]{opacity:.65;cursor:not-allowed}
.fia-root .fia-security-candidates [role=option]>span{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.fia-root .fia-security-candidates [role=option] strong{font-weight:600;overflow-wrap:anywhere}
.fia-root .fia-security-candidates code{font-size:11px;font-variant-numeric:tabular-nums;color:var(--fia-secondary)}
.fia-root .fia-security-candidates small{font-size:11px;color:var(--fia-brand)}
.fia-root .fia-security-candidates p{margin:8px;font-size:12px;line-height:1.7}
.fia-root .fia-security-search-note{color:var(--fia-muted);font-size:11px!important}
.fia-root .fia-security-link{background:transparent;border:0;padding:3px 0;min-height:32px;cursor:pointer;color:var(--fia-brand);font:inherit;text-align:left;line-height:1.6;text-decoration:underline;text-decoration-color:color-mix(in srgb,var(--fia-brand) 35%,transparent);text-underline-offset:3px;overflow-wrap:anywhere}
.fia-root .fia-security-page{display:grid;gap:16px;min-width:0}
.fia-root .fia-security-header{display:flex;gap:12px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap}
.fia-root .fia-security-header h2{margin:0;font-size:23px;line-height:1.4}
.fia-root .fia-security-header p{font-size:12px;line-height:1.7;color:var(--fia-secondary);margin:6px 0 0}
.fia-root .fia-security-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.fia-root .fia-security-header-meta{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:11px;color:var(--fia-muted);margin-top:8px}
.fia-root .fia-security-disclosure{border:1px solid var(--fia-border);border-radius:8px;padding:12px 14px;background:var(--fia-surface);min-width:0}
.fia-root .fia-security-disclosure summary{display:flex;gap:8px;align-items:center;flex-wrap:wrap;cursor:pointer;min-height:32px;color:var(--fia-text);font-size:13px;font-weight:600}
.fia-root .fia-security-disclosure summary::before{content:'▸';color:var(--fia-muted)}
.fia-root .fia-security-disclosure[open] summary::before{content:'▾'}
.fia-root .fia-security-disclosure summary::-webkit-details-marker{display:none}
.fia-root .fia-security-disclosure summary small{margin-left:auto;color:var(--fia-muted);font-size:11px;font-weight:400}
.fia-root .fia-security-data-meta{font-size:11px;color:var(--fia-muted);display:flex;gap:12px;flex-wrap:wrap;margin:9px 0;line-height:1.7}
.fia-root .fia-security-data-scroll{max-width:100%;overflow-x:auto;margin-block:8px;overscroll-behavior-x:contain}
.fia-root .fia-security-data-scroll table{min-width:100%;width:max-content;max-width:none}
.fia-root .fia-security-data-scroll th{white-space:nowrap}
.fia-root .fia-security-data-scroll td{max-width:420px;white-space:normal;overflow-wrap:anywhere;vertical-align:top;line-height:1.75}
.fia-root .fia-security-data-scroll td[data-numeric=true]{white-space:nowrap}
.fia-root .fia-security-data-scroll caption{text-align:left;color:var(--fia-muted);font-size:11px;padding:0 0 8px}
.fia-root .fia-security-data-scroll .fia-security-link{font-size:12px}
.fia-root .fia-security-data-gap{font-size:12px;color:var(--fia-warning);line-height:1.7;overflow-wrap:anywhere}
.fia-root .fia-security-data-error{font-size:12px;color:var(--fia-danger);line-height:1.7;overflow-wrap:anywhere}
@container finance-panel (max-width:420px){.fia-root .fia-security-header h2{font-size:20px}.fia-root .fia-security-data-scroll td{max-width:260px}.fia-root .fia-security-disclosure{padding:10px}}
`
