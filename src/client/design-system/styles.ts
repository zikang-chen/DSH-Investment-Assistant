import { tokenCss } from './tokens.js'

/** Rendered by FinanceTheme; all selectors are finance-root scoped, including resets. */
export const financeCss = `${tokenCss}
.fia-root{box-sizing:border-box;min-width:0;color:var(--fia-text);background:var(--fia-canvas);font-family:var(--fia-font-sans);font-size:var(--fia-font-base);line-height:var(--fia-line-height);text-align:start;isolation:isolate;-webkit-font-smoothing:antialiased}
.fia-root *,.fia-root *::before,.fia-root *::after{box-sizing:border-box}
.fia-root :where(button,input,select,textarea){font:inherit;color:inherit}
.fia-root :where(button,input,select){min-height:var(--fia-control-height)}
.fia-root :where(input:not([type=checkbox]):not([type=radio]):not([type=range]),select,textarea){max-width:100%;border:1px solid var(--fia-border);border-radius:var(--fia-radius-sm);background:var(--fia-surface);color:var(--fia-text);padding:5px 9px;line-height:20px}
.fia-root :where(input:not([type=checkbox]):not([type=radio]):not([type=range]),select){height:var(--fia-control-height)}
.fia-root textarea{min-height:var(--fia-control-height);resize:vertical}
.fia-root :where(input[type=checkbox],input[type=radio]){min-height:0;accent-color:var(--fia-brand)}
.fia-root :where(input,textarea)::placeholder{color:var(--fia-muted);opacity:1}
.fia-root :where(button,input,select,textarea,a,summary,[tabindex]):focus-visible{outline:2px solid var(--fia-focus);outline-offset:3px}
.fia-root :where(button,input,select,textarea):disabled{cursor:not-allowed;opacity:.5}
.fia-root .fia-button{display:inline-flex;align-items:center;justify-content:center;gap:var(--fia-space-2);height:var(--fia-control-height);padding:0 var(--fia-space-3);border:1px solid var(--fia-border);border-radius:var(--fia-radius-sm);background:var(--fia-surface);color:var(--fia-text);font-size:var(--fia-font-sm);font-weight:600;line-height:1.2;white-space:nowrap;cursor:pointer;text-decoration:none;transition:background-color var(--fia-duration-fast),border-color var(--fia-duration-fast)}
.fia-root .fia-button--primary{border-color:var(--fia-brand);background:var(--fia-brand);color:var(--fia-on-primary)}
.fia-root .fia-button--ghost{border-color:transparent;background:transparent;color:var(--fia-brand)}
.fia-root .fia-button--secondary:hover:not(:disabled),.fia-root .fia-button--ghost:hover:not(:disabled){background:var(--fia-hover)}
.fia-root .fia-button--primary:hover:not(:disabled){outline:1px solid var(--fia-brand);outline-offset:2px}
.fia-root .fia-page-header{display:flex;align-items:flex-start;justify-content:space-between;gap:var(--fia-space-4);padding-bottom:var(--fia-space-4);margin-bottom:var(--fia-space-5);border-bottom:1px solid var(--fia-border)}
.fia-root .fia-page-header__copy{min-width:0}
.fia-root .fia-page-header__eyebrow{margin:0 0 var(--fia-space-1);color:var(--fia-muted);font-size:var(--fia-font-xs);font-weight:600;letter-spacing:.08em;text-transform:uppercase}
.fia-root .fia-page-header__title{margin:0;color:var(--fia-text);font-size:var(--fia-font-2xl);font-weight:650;line-height:1.3;letter-spacing:-.025em;overflow-wrap:anywhere}
.fia-root .fia-page-header__description{margin:var(--fia-space-2) 0 0;color:var(--fia-secondary);font-size:var(--fia-font-sm);max-width:64ch;overflow-wrap:anywhere}
.fia-root .fia-page-header__actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:var(--fia-space-2);flex-shrink:0}
.fia-root .fia-badge{display:inline-flex;align-items:center;gap:var(--fia-space-1);max-width:100%;min-height:22px;padding:2px var(--fia-space-2);border-radius:var(--fia-radius-sm);color:var(--fia-secondary);background:var(--fia-neutral-soft);font-size:var(--fia-font-xs);font-weight:600;line-height:1.5;overflow-wrap:anywhere}
.fia-root .fia-badge--info{color:var(--fia-info);background:var(--fia-info-soft)}
.fia-root .fia-badge--success{color:var(--fia-success);background:var(--fia-success-soft)}
.fia-root .fia-badge--warning{color:var(--fia-warning);background:var(--fia-warning-soft)}
.fia-root .fia-badge--danger{color:var(--fia-danger);background:var(--fia-danger-soft)}
.fia-root .fia-empty{display:flex;flex-direction:column;align-items:flex-start;gap:var(--fia-space-2);padding:var(--fia-space-6);border:1px dashed var(--fia-border);border-radius:var(--fia-radius-md);background:var(--fia-surface-muted)}
.fia-root .fia-empty__title{margin:0;color:var(--fia-text);font-size:var(--fia-font-lg);font-weight:600;line-height:1.4}
.fia-root .fia-empty__description{margin:0;max-width:60ch;color:var(--fia-secondary);font-size:var(--fia-font-sm);overflow-wrap:anywhere}
.fia-root .fia-empty__action{margin-top:var(--fia-space-2)}
.fia-root .fia-metric{display:flex;flex-direction:column;align-items:flex-start;gap:var(--fia-space-2);min-width:0;padding:var(--fia-space-4);border:1px solid var(--fia-border);border-radius:var(--fia-radius-md);background:var(--fia-surface);color:var(--fia-text);text-align:start}
.fia-root button.fia-metric{width:100%;cursor:pointer;font:inherit;transition:border-color var(--fia-duration-fast),background-color var(--fia-duration-fast)}
.fia-root button.fia-metric:hover{border-color:var(--fia-brand);background:var(--fia-hover)}
.fia-root .fia-metric__label{color:var(--fia-secondary);font-size:var(--fia-font-sm);font-weight:500;overflow-wrap:anywhere}
.fia-root .fia-metric__value{color:var(--fia-text);font-size:var(--fia-font-2xl);font-weight:650;line-height:1.25;font-variant-numeric:tabular-nums lining-nums;letter-spacing:-.025em;overflow-wrap:anywhere}
.fia-root .fia-metric__detail{color:var(--fia-secondary);font-size:var(--fia-font-sm);overflow-wrap:anywhere}
.fia-root .fia-metric__asof{margin-top:auto;color:var(--fia-muted);font-size:var(--fia-font-xs);font-variant-numeric:tabular-nums}
.fia-root .fia-theme-controls{display:flex;flex-wrap:wrap;gap:var(--fia-space-2);align-items:center}
.fia-root .fia-theme-controls__field{display:flex;align-items:center;gap:var(--fia-space-2);color:var(--fia-secondary);font-size:var(--fia-font-sm)}
.fia-root .fia-theme-controls select{min-width:112px;max-width:200px;font-size:var(--fia-font-sm)}
.fia-root .fia-theme-controls[data-compact=true] select{min-width:0;max-width:164px;padding-inline:6px}
.fia-root .fia-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.fia-root .fia-number{font-variant-numeric:tabular-nums lining-nums}
.fia-root .fia-up,.fia-root .fia-change[data-direction=up]{color:var(--fia-up)}
.fia-root .fia-down,.fia-root .fia-change[data-direction=down]{color:var(--fia-down)}
.fia-root .fia-flat,.fia-root .fia-change[data-direction=flat]{color:var(--fia-flat)}
.fia-root .fia-text-secondary{color:var(--fia-secondary)}
.fia-root .fia-text-muted{color:var(--fia-muted)}
.fia-root .fia-link{color:var(--fia-brand);text-decoration:underline;text-underline-offset:3px}
.fia-root .fia-card{min-width:0;border:1px solid var(--fia-border);border-radius:var(--fia-radius-md);background:var(--fia-surface);padding:var(--fia-space-4)}
.fia-root .fia-table{width:100%;border-collapse:collapse;color:var(--fia-text);font-size:var(--fia-font-sm);font-variant-numeric:tabular-nums}
.fia-root .fia-table th{padding:10px 12px;background:var(--fia-surface-muted);color:var(--fia-secondary);font-weight:600;text-align:start;border-bottom:1px solid var(--fia-border)}
.fia-root .fia-table td{padding:10px 12px;border-bottom:1px solid var(--fia-border)}
.fia-root .fia-table tbody tr:hover{background:var(--fia-hover)}
.fia-root .fia-table :is(td,th)[data-numeric=true]{text-align:end;white-space:nowrap}
@media(max-width:640px){.fia-root .fia-page-header{flex-direction:column}.fia-root .fia-page-header__actions{justify-content:flex-start;flex-shrink:1}.fia-root .fia-page-header__title{font-size:var(--fia-font-xl)}.fia-root .fia-theme-controls{gap:var(--fia-space-1)}}
@media(prefers-reduced-motion:reduce){.fia-root *,.fia-root *::before,.fia-root *::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`
