/** Component layout only. All paint comes from the scoped Institutional Finance tokens. */
export const WORKSPACE_CSS = `
.fia-root.fia-panel{container-type:inline-size;container-name:finance-panel;min-width:0;isolation:isolate}
.fia-root .fia-shell-body{display:flex;flex-direction:column;flex:1;min-height:0;min-width:0;height:100%;color:var(--fia-text)}
.fia-root .fia-brandbar{display:flex;align-items:center;gap:10px;padding:12px 16px;background:var(--fia-navy);color:var(--fia-on-dark);border-bottom:2px solid var(--fia-gold);min-height:64px;flex-shrink:0}
.fia-root .fia-brandbar .fia-brand-name{font-size:15px;font-weight:700;letter-spacing:.02em}
.fia-root .fia-brand-subtitle{font-size:10px;letter-spacing:.06em;color:var(--fia-header-muted,var(--fia-on-dark));opacity:.85}
.fia-root .fia-brandbar .fia-header-actions{display:flex;align-items:center;gap:4px;flex-wrap:wrap;justify-content:flex-end}
.fia-root .fia-brandbar .fia-header-action{background:transparent;border:1px solid transparent;color:var(--fia-on-dark);height:32px;padding:4px 8px;border-radius:6px;cursor:pointer;font-size:12px;min-width:32px}
.fia-root .fia-brandbar .fia-header-action:focus-visible,.fia-root .fia-brandbar .fia-appearance>summary:focus-visible{outline-color:var(--fia-on-dark)}
.fia-root .fia-brandbar .fia-header-action:hover{background:color-mix(in srgb,var(--fia-on-dark) 10%,transparent)}
.fia-root .fia-appearance{position:relative;flex:none}
.fia-root .fia-appearance>summary{list-style:none;cursor:pointer;font-size:12px;min-height:32px;display:flex;align-items:center;padding:4px 8px;border-radius:6px}
.fia-root .fia-appearance>summary::-webkit-details-marker{display:none}
.fia-root .fia-appearance[open]>summary{background:color-mix(in srgb,var(--fia-on-dark) 12%,transparent)}
.fia-root .fia-appearance-content{position:absolute;top:calc(100% + 12px);right:0;padding:14px;z-index:10;background:var(--fia-surface);color:var(--fia-text);border:1px solid var(--fia-border);box-shadow:var(--fia-shadow-overlay,0 10px 36px #0003);border-radius:10px;width:min(290px,80vw)}
.fia-root .fia-appearance-content>strong{display:block;margin-bottom:10px}
.fia-root .fia-workspace{display:flex;flex-direction:column;min-height:0;min-width:0;flex:1}
.fia-root .fia-main-nav{background:var(--fia-surface);border-bottom:1px solid var(--fia-border);padding:6px 10px;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:2px;flex:none}
.fia-root .fia-main-nav button{background:transparent;color:var(--fia-secondary);border:0;border-radius:6px;min-width:0;min-height:36px;padding:7px 2px;cursor:pointer;font-size:12px;font-weight:500;line-height:1.4}
.fia-root .fia-main-nav button[aria-current=true]{background:var(--fia-selected);color:var(--fia-brand);font-weight:700;box-shadow:inset 0 -2px var(--fia-brand)}
.fia-root .fia-main-nav button:hover{background:var(--fia-hover)}
.fia-root .fia-workspace-main{display:flex;flex-direction:column;min-width:0;min-height:0;flex:1}
.fia-root .fia-subnav{display:flex;gap:4px;padding:6px 12px;min-height:40px;overflow-x:auto;border-bottom:1px solid var(--fia-border);background:var(--fia-surface);flex:none}
.fia-root .fia-subnav button{background:transparent;border:0;color:var(--fia-secondary);padding:4px 9px;min-height:30px;border-radius:5px;white-space:nowrap;font-size:12px;cursor:pointer}
.fia-root .fia-subnav button[aria-current=page]{color:var(--fia-brand);background:var(--fia-selected);font-weight:650}
.fia-root .fia-panel-content{background:var(--fia-canvas);overflow-y:auto;overscroll-behavior:contain;min-height:0;min-width:0;flex:1;padding:18px;scrollbar-gutter:stable}
.fia-root .fia-panel-content>div{min-width:0}
.fia-root .fia-session-strip{border-bottom:1px solid var(--fia-border);background:var(--fia-surface);font-size:12px}
.fia-root .fia-eyebrow{font-size:10px;letter-spacing:.1em;font-weight:650;color:var(--fia-muted)}
.fia-root .fia-number{font-variant-numeric:tabular-nums lining-nums;text-align:right}
.fia-root .fia-page{display:grid;gap:16px;min-width:0;max-width:1240px;margin-inline:auto;width:100%}
.fia-root .fia-meta-line{color:var(--fia-muted);font-size:11px;display:flex;gap:8px;flex-wrap:wrap;justify-content:space-between;font-variant-numeric:tabular-nums}
.fia-root .fia-question-bar{display:flex;align-items:center;gap:8px;background:var(--fia-surface);border:1px solid var(--fia-border);border-radius:10px;padding:8px 10px;min-width:0}
.fia-root .fia-question-mark{font-size:20px;color:var(--fia-brand);padding:0 2px}
.fia-root .fia-question-bar input{flex:1;min-width:0;border:0;background:transparent;height:36px;box-shadow:none;font-size:13px}
.fia-root .fia-question-bar:focus-within{border-color:var(--fia-focus);outline:2px solid color-mix(in srgb,var(--fia-focus) 20%,transparent)}
.fia-root .fia-metric-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.fia-root .fia-metric-grid>*{min-width:0;height:100%}
.fia-root .fia-research-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:14px;min-width:0}
.fia-root .fia-research-section{background:var(--fia-surface);border:1px solid var(--fia-border);border-radius:10px;padding:16px;min-width:0}
.fia-root .fia-section-heading{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.fia-root .fia-section-heading :is(h2,h3){margin:0;font-size:14px;line-height:1.5;font-weight:650;color:var(--fia-text)}
.fia-root .fia-research-section h4{font-size:13px;margin:12px 0 8px}
.fia-root .fia-task-block{padding-bottom:12px;margin-bottom:12px;border-bottom:1px solid var(--fia-border)}
.fia-root .fia-task-block:last-child{margin-bottom:0;border-bottom:0;padding-bottom:0}
.fia-root .fia-task-block h4{margin:0 0 5px;font-size:13px}
.fia-root .fia-task-block p{font-size:12px;margin:5px 0;line-height:1.65}
.fia-root .fia-last-question{overflow-wrap:anywhere;color:var(--fia-secondary)}
.fia-root .fia-timeline{display:grid;gap:0}
.fia-root .fia-timeline-item{position:relative;display:flex;flex-direction:column;align-items:flex-start;text-align:left;gap:6px;background:transparent;border:0;border-bottom:1px solid var(--fia-border);padding:12px 0;color:var(--fia-text);cursor:pointer;min-width:0;width:100%}
.fia-root .fia-timeline-item:first-child{padding-top:0}
.fia-root .fia-timeline-item:last-child{border:0;padding-bottom:0}
.fia-root .fia-timeline-item strong{font-size:13px;font-weight:550;line-height:1.65;overflow-wrap:anywhere}
.fia-root .fia-timeline-date{display:flex;gap:10px;flex-wrap:wrap;color:var(--fia-muted);font-size:11px;font-variant-numeric:tabular-nums}
.fia-root .fia-timeline-item:hover strong{color:var(--fia-brand)}
.fia-root .fia-timeline-item>.fia-muted{font-size:11px}
.fia-root .fia-notice{padding:10px 12px;background:var(--fia-selected);border-left:3px solid var(--fia-brand);font-size:12px;color:var(--fia-text);border-radius:4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;overflow-wrap:anywhere}
.fia-root .fia-notice--error{background:var(--fia-danger-soft);border-left-color:var(--fia-danger);color:var(--fia-danger)}
.fia-root .fia-muted{color:var(--fia-muted);font-size:12px;line-height:1.65}
.fia-root .fia-secondary{color:var(--fia-secondary)}
.fia-root .fia-error-text{color:var(--fia-danger)}
.fia-root .fia-caution{color:var(--fia-warning);font-size:12px;line-height:1.65}
.fia-root .fia-text-link{background:transparent;border:0;color:var(--fia-brand);padding:4px 0;cursor:pointer;min-height:28px;text-align:left;font-size:12px;line-height:1.6;display:inline-block;text-decoration:underline;text-underline-offset:3px;overflow-wrap:anywhere}
.fia-root .fia-source-details{border-top:1px solid var(--fia-border);padding-top:10px;font-size:12px;color:var(--fia-secondary)}
.fia-root .fia-source-details summary{min-height:32px;cursor:pointer;color:var(--fia-brand)}
.fia-root .fia-source-details dl{display:grid;grid-template-columns:86px minmax(0,1fr);gap:8px;margin:10px 0}
.fia-root .fia-source-details dt{color:var(--fia-muted)}
.fia-root .fia-source-details dd{margin:0;overflow-wrap:anywhere}
.fia-root .fia-source-details dd p{margin:0 0 8px}
.fia-root .fia-value-row{display:flex;justify-content:space-between;gap:10px;padding:4px 0}
.fia-root .fia-research-composer{border:1px solid var(--fia-border);border-radius:10px;background:var(--fia-surface);padding:16px;min-width:0}
.fia-root .fia-composer-heading{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.fia-root .fia-composer-heading>label{font-size:13px;font-weight:650}
.fia-root .fia-research-composer textarea{width:100%;min-height:94px;padding:12px;line-height:1.7;border:1px solid var(--fia-border);background:var(--fia-surface-muted);border-radius:7px;resize:vertical;font-family:inherit;font-size:13px;color:var(--fia-text)}
.fia-root .fia-composer-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:12px}
.fia-root .fia-consent{display:flex;align-items:flex-start;gap:7px;color:var(--fia-secondary);font-size:12px;min-width:0;line-height:1.6}
.fia-root .fia-consent input{width:16px;height:16px;margin:2px 0 0;flex-shrink:0;accent-color:var(--fia-brand)}
.fia-root .fia-composer-help{font-size:11px;margin:8px 0 0}
.fia-root .fia-segmented{display:inline-flex;padding:3px;border:1px solid var(--fia-border);border-radius:7px;background:var(--fia-surface-muted);gap:3px}
.fia-root .fia-segmented button{min-height:28px;font-size:12px;padding:4px 9px;border:0;border-radius:4px;background:transparent;color:var(--fia-secondary);cursor:pointer}
.fia-root .fia-segmented button[aria-pressed=true]{background:var(--fia-selected);color:var(--fia-brand);font-weight:650}
.fia-root .fia-prompt-examples{margin-top:12px;color:var(--fia-secondary);font-size:12px}
.fia-root .fia-prompt-examples summary{cursor:pointer;min-height:28px;line-height:2}
.fia-root .fia-prompt-examples>div{display:grid;gap:2px;margin-top:4px}
.fia-root .fia-inline-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.fia-root .fia-filter-label{display:flex;gap:6px;align-items:center;color:var(--fia-secondary);font-size:12px}
.fia-root .fia-filter-label select{width:auto;min-width:104px}
.fia-root .fia-advice-layout{display:flex;flex-direction:column;gap:14px;min-width:0;align-items:stretch}
.fia-root .fia-advice-history{display:grid;gap:8px;align-content:start;min-width:0}
.fia-root .fia-advice-layout.has-selection .fia-advice-history{max-height:240px;overflow-y:auto;padding-right:4px}
.fia-root .fia-history-row{display:flex;flex-direction:column;align-items:stretch;gap:8px;width:100%;background:var(--fia-surface);border:1px solid var(--fia-border);border-radius:8px;padding:12px;text-align:left;cursor:pointer;color:var(--fia-text);font:inherit;min-width:0}
.fia-root .fia-history-row:hover{border-color:var(--fia-brand)}
.fia-root .fia-history-row.is-selected{border-color:var(--fia-brand);box-shadow:inset 3px 0 var(--fia-brand);background:var(--fia-selected)}
.fia-root .fia-history-row>strong{font-size:13px;font-weight:600;line-height:1.65;overflow-wrap:anywhere}
.fia-root .fia-history-top{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--fia-muted);font-size:11px;flex-wrap:wrap}
.fia-root .fia-history-meta,.fia-root .fia-history-footer{display:flex;gap:8px;flex-wrap:wrap;font-size:11px;line-height:1.5;color:var(--fia-secondary)}
.fia-root .fia-history-footer{padding-top:6px;border-top:1px solid var(--fia-border);color:var(--fia-muted)}
.fia-root .fia-history-footer>span:last-child{margin-left:auto;color:var(--fia-brand)}
.fia-root .fia-advice-report{background:var(--fia-surface);border:1px solid var(--fia-border);border-radius:10px;padding:18px;display:grid;gap:16px;min-width:0;line-height:1.75}
.fia-root .fia-advice-report>h2{font-size:18px;line-height:1.5;margin:0;font-weight:650;overflow-wrap:anywhere}
.fia-root .fia-advice-report .fia-research-section{padding:0;border:0;border-radius:0}
.fia-root .fia-report-meta{display:flex;flex-wrap:wrap;gap:10px;font-size:11px;color:var(--fia-muted)}
.fia-root .fia-verdict{border-left:3px solid var(--fia-brand);background:var(--fia-surface-muted);padding:12px 14px;display:flex;flex-direction:column;align-items:flex-start;gap:8px}
.fia-root .fia-verdict p{margin:0;font-size:12px;color:var(--fia-secondary)}
.fia-root .fia-advice-report .fia-research-section p{font-size:13px;margin:8px 0;overflow-wrap:anywhere}
.fia-root .fia-report-list{margin:8px 0;padding-left:20px;font-size:13px;line-height:1.8;overflow-wrap:anywhere}
.fia-root .fia-evidence-list{list-style:none;padding:0;margin:8px 0 0;display:grid;gap:10px}
.fia-root .fia-evidence-list li{padding:10px 12px;background:var(--fia-surface-muted);border-radius:6px;min-width:0}
.fia-root .fia-evidence-list li>div:first-child{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.fia-root .fia-evidence-list p{margin:6px 0!important;font-size:13px}
.fia-root .fia-evidence-date,.fia-root .fia-citation{font-size:11px;color:var(--fia-muted);line-height:1.65;overflow-wrap:anywhere}
.fia-root .fia-citation a{color:var(--fia-brand)}
.fia-root .fia-counter-evidence{border-left:2px solid var(--fia-warning)!important;padding-left:12px!important}
.fia-root .fia-local-note{margin:0;color:var(--fia-secondary);font-size:12px;padding:8px 0;border-block:1px solid var(--fia-border)}
.fia-root .fia-review-note{border-left:2px solid var(--fia-border);padding:8px 12px;margin:10px 0;font-size:12px}
.fia-root .fia-review-note p{margin:4px 0}
.fia-root .fia-report-actions{border-top:1px solid var(--fia-border);padding-top:12px;display:flex;gap:8px;flex-wrap:wrap}
.fia-root .fia-learning-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding-block:10px;border-top:1px solid var(--fia-border);color:var(--fia-secondary);font-size:12px}
.fia-root .fia-learning-toolbar>div{display:flex;gap:4px;flex-wrap:wrap}
.fia-root .fia-learning-toolbar form{display:flex;gap:4px;flex:1;min-width:140px}
.fia-root .fia-learning-toolbar input{min-width:60px;width:100%;max-width:170px}
.fia-root .fia-term-button{border:0;background:transparent;color:var(--fia-brand);cursor:pointer;font-size:12px;min-height:32px;padding:4px 6px}
.fia-root .fia-explain-shortcuts{display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:12px}
.fia-root .fia-explain-drawer{position:fixed;inset:0 0 0 auto;margin:0;width:min(440px,calc(100vw - 20px));height:100dvh;max-height:100dvh;max-width:calc(100vw - 20px);border:0;border-left:1px solid var(--fia-border);padding:24px;background:var(--fia-surface);color:var(--fia-text);box-shadow:var(--fia-shadow-overlay);overflow-y:auto;font:inherit;font-size:13px;line-height:1.8;box-sizing:border-box}
.fia-root .fia-explain-drawer::backdrop{background:color-mix(in srgb,var(--fia-navy) 38%,transparent)}
.fia-root .fia-explain-drawer h2{margin:0;font-size:18px}
.fia-root .fia-explain-drawer h3{font-size:14px;margin:20px 0 8px}
.fia-root .fia-explain-drawer .fia-segmented{margin-top:10px}
.fia-root .fia-explanation-text{font-size:14px;line-height:1.9}
.fia-root .fia-formula{padding:12px;background:var(--fia-surface-muted);border:1px solid var(--fia-border);border-radius:6px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
@container finance-panel (min-width:740px){
  .fia-root .fia-workspace{display:grid;grid-template-columns:140px minmax(0,1fr)}
  .fia-root .fia-main-nav{display:flex;flex-direction:column;gap:6px;justify-content:flex-start;padding:16px 10px;background:var(--fia-navy);color:var(--fia-on-dark);border:0}
  .fia-root .fia-main-nav button{color:var(--fia-on-dark);text-align:left;padding:10px 12px;font-size:13px;flex:none}
  .fia-root .fia-main-nav button[aria-current=true]{background:color-mix(in srgb,var(--fia-on-dark) 10%,transparent);color:var(--fia-on-dark);box-shadow:inset 2px 0 var(--fia-gold)}
  .fia-root .fia-main-nav button:hover{background:color-mix(in srgb,var(--fia-on-dark) 7%,transparent)}
  .fia-root .fia-panel-content{padding:22px}
}
@container finance-panel (min-width:1050px){.fia-root .fia-metric-grid{grid-template-columns:repeat(4,minmax(0,1fr))}.fia-root .fia-research-grid{grid-template-columns:minmax(0,1.15fr) minmax(0,1fr)}.fia-root .fia-advice-layout.has-selection{display:grid;grid-template-columns:270px minmax(0,1fr);align-items:start}.fia-root .fia-advice-layout.has-selection .fia-advice-history{max-height:none}}
@container finance-panel (max-width:420px){
  .fia-root .fia-brandbar{padding:10px;gap:7px;flex-wrap:wrap}
  .fia-root .fia-brand-subtitle{font-size:9px;letter-spacing:0}
  .fia-root .fia-brandbar .fia-header-actions{gap:0}
  .fia-root .fia-brandbar .fia-header-action{padding:4px 6px}
  .fia-root .fia-panel-content{padding:12px}
  .fia-root .fia-metric-grid{grid-template-columns:minmax(0,1fr)}
  .fia-root .fia-page-header{flex-direction:column;margin-bottom:0}
  .fia-root .fia-page-header__actions{justify-content:flex-start;flex-shrink:1}
  .fia-root .fia-question-mark{display:none}
  .fia-root .fia-question-bar{flex-wrap:wrap}
  .fia-root .fia-question-bar input{flex-basis:100%}
  .fia-root .fia-question-bar button{margin-left:auto}
  .fia-root .fia-research-section,.fia-root .fia-research-composer,.fia-root .fia-advice-report{padding:12px}
  .fia-root .fia-composer-actions{align-items:stretch;flex-direction:column}
  .fia-root .fia-source-details dl{grid-template-columns:1fr;gap:4px}
  .fia-root .fia-source-details dd{margin-bottom:8px}
}
@media (max-width:900px){.fia-root .fia-expand-action{display:none}}
@media (max-width:820px){
  .fia-root .fia-research-modal{inset:12px!important;flex-direction:column!important}
  .fia-root .fia-research-modal-side{width:100%!important;max-height:32vh;flex-shrink:0;border-right:0!important;border-bottom:1px solid var(--fia-border)}
  .fia-root .fia-research-modal>div:last-child{min-height:0}
}
@media (prefers-reduced-motion:reduce){.fia-root *{scroll-behavior:auto!important;animation:none!important;transition:none!important}}
@keyframes dsn-pulse{0%,100%{opacity:.45}50%{opacity:.8}}
.fia-root .dsn-tabs::-webkit-scrollbar{height:4px}
.fia-root .dsn-tabs::-webkit-scrollbar-thumb{background:var(--fia-border);border-radius:8px}
.fia-root .dsn-row:hover{background:var(--fia-hover)}
`
