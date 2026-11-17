/** Every selector is scoped to the finance root; no host or chart styling. */
export const capitalWorkspaceCss = `
.fia-root .fia-capital-workspace,.fia-root .fia-wealth-workspace{min-width:0;container-type:inline-size;container-name:fia-capital}
.fia-root .fia-cw-stack{display:grid;gap:var(--fia-space-4);min-width:0}
.fia-root .fia-cw-split{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--fia-space-4);min-width:0}
.fia-root .fia-cw-section{min-width:0;border:1px solid var(--fia-border);border-radius:var(--fia-radius-md);background:var(--fia-surface);overflow:hidden}
.fia-root .fia-cw-heading{display:flex;align-items:center;justify-content:space-between;gap:var(--fia-space-3);padding:var(--fia-space-3) var(--fia-space-4);border-bottom:1px solid var(--fia-border);flex-wrap:wrap}
.fia-root .fia-cw-heading h2{margin:0;font-size:var(--fia-font-base);font-weight:650;color:var(--fia-text)}
.fia-root .fia-cw-heading__meta{color:var(--fia-muted);font-size:var(--fia-font-xs)}
.fia-root .fia-cw-body{padding:var(--fia-space-4);min-width:0}
.fia-root .fia-cw-meta{display:flex;flex-wrap:wrap;align-items:center;gap:var(--fia-space-2);margin-bottom:var(--fia-space-4);color:var(--fia-secondary);font-size:var(--fia-font-sm)}
.fia-root .fia-cw-note{margin:0;color:var(--fia-secondary);font-size:var(--fia-font-sm);overflow-wrap:anywhere}
.fia-root .fia-cw-note+.fia-cw-note,.fia-root .fia-cw-message+.fia-cw-note{margin-top:var(--fia-space-2)}
.fia-root .fia-cw-message{margin:0;padding:var(--fia-space-3) var(--fia-space-4);border:1px solid var(--fia-border);border-radius:var(--fia-radius-sm);background:var(--fia-surface-muted);color:var(--fia-secondary);font-size:var(--fia-font-sm);overflow-wrap:anywhere}
.fia-root .fia-cw-message--error{color:var(--fia-danger);border-color:var(--fia-danger);background:var(--fia-danger-soft)}
.fia-root .fia-cw-message--warning{color:var(--fia-warning);background:var(--fia-warning-soft)}
.fia-root .fia-cw-message--info{color:var(--fia-info);background:var(--fia-info-soft)}
.fia-root .fia-cw-message ul{margin:var(--fia-space-2) 0 0;padding-left:var(--fia-space-5)}
.fia-root .fia-cw-scroll{min-width:0;max-width:100%;overflow-x:auto;overscroll-behavior-inline:contain}
.fia-root .fia-cw-table{min-width:480px}
.fia-root .fia-cw-table--wide{min-width:740px}
.fia-root .fia-cw-table caption{padding:var(--fia-space-3) var(--fia-space-4);text-align:start;caption-side:bottom;color:var(--fia-muted);font-size:var(--fia-font-xs)}
.fia-root .fia-cw-table :is(td,th)[data-numeric=true]{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums lining-nums}
.fia-root .fia-cw-table td{vertical-align:top;overflow-wrap:anywhere;max-width:240px}
.fia-root .fia-cw-table tbody tr:last-child td{border-bottom:0}
.fia-root .fia-cw-id{display:block;margin-top:var(--fia-space-1);color:var(--fia-muted);font-size:var(--fia-font-xs);overflow-wrap:anywhere}
.fia-root .fia-cw-source{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--fia-space-3);margin-bottom:var(--fia-space-3)}
.fia-root .fia-cw-source-note{display:grid;gap:var(--fia-space-2);margin-bottom:var(--fia-space-4)}
.fia-root .fia-cw-source+.fia-cw-note{margin-bottom:var(--fia-space-4)}
.fia-root .fia-cw-field select{width:100%;min-width:0}
.fia-root .fia-cw-field input[readonly]{background:var(--fia-surface-muted);color:var(--fia-secondary)}
.fia-root .fia-cw-form{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--fia-space-3);min-width:0}
.fia-root .fia-cw-field{display:flex;flex-direction:column;gap:var(--fia-space-2);min-width:0;color:var(--fia-secondary);font-size:var(--fia-font-sm)}
.fia-root .fia-cw-field__label{display:flex;justify-content:space-between;align-items:baseline;gap:var(--fia-space-2)}
.fia-root .fia-cw-field__unit{color:var(--fia-muted);white-space:nowrap;font-size:var(--fia-font-xs)}
.fia-root .fia-cw-field input{width:100%;min-width:0;font-variant-numeric:tabular-nums}
.fia-root .fia-cw-field input[aria-invalid=true]{border-color:var(--fia-danger)}
.fia-root .fia-cw-field__error{color:var(--fia-danger);font-size:var(--fia-font-xs)}
.fia-root .fia-cw-form+.fia-cw-note{margin-top:var(--fia-space-3)}
.fia-root .fia-cw-form-actions{display:flex;gap:var(--fia-space-2);flex-wrap:wrap;align-items:flex-end;margin-top:var(--fia-space-4)}
.fia-root .fia-cw-form-actions .fia-cw-field{flex:1;min-width:min(180px,100%)}
.fia-root .fia-cw-assumptions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--fia-space-3);margin:var(--fia-space-4) 0 0}
.fia-root .fia-cw-assumptions dt{color:var(--fia-muted);font-size:var(--fia-font-xs)}
.fia-root .fia-cw-assumptions dd{margin:var(--fia-space-1) 0 0;font-size:var(--fia-font-sm);font-variant-numeric:tabular-nums}
.fia-root .fia-cw-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--fia-space-3)}
.fia-root .fia-cw-metrics .fia-metric__value{font-size:var(--fia-font-xl)}
.fia-root .fia-cw-rates{display:flex;flex-wrap:wrap;gap:var(--fia-space-4);padding:var(--fia-space-3) 0;color:var(--fia-secondary);font-size:var(--fia-font-sm);font-variant-numeric:tabular-nums}
.fia-root .fia-cw-list{margin:var(--fia-space-3) 0 0;padding-left:var(--fia-space-5);color:var(--fia-secondary);font-size:var(--fia-font-sm)}
.fia-root .fia-cw-list li+li{margin-top:var(--fia-space-1)}
@container fia-capital (max-width:760px){.fia-root .fia-cw-split{grid-template-columns:minmax(0,1fr)}.fia-root .fia-cw-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}
@container fia-capital (max-width:480px){.fia-root .fia-cw-source,.fia-root .fia-cw-form,.fia-root .fia-cw-assumptions,.fia-root .fia-cw-metrics{grid-template-columns:minmax(0,1fr)}.fia-root .fia-cw-form-actions{align-items:stretch}.fia-root .fia-cw-form-actions .fia-cw-field{flex-basis:100%}}
@media(max-width:540px){.fia-root .fia-cw-split,.fia-root .fia-cw-source,.fia-root .fia-cw-form,.fia-root .fia-cw-assumptions,.fia-root .fia-cw-metrics{grid-template-columns:minmax(0,1fr)}}
`
