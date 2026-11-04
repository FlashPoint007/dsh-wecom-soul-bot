/**
 * Page stylesheet, modelled on DSH's own Plugin Manager and Settings pages:
 * sections separated by whitespace rather than boxed, one settings card per
 * object the operator manages, hairline rows inside a card, and a recessed
 * "well" for inline editors. Colors, radii and focus rings are DSH theme
 * tokens (with fallbacks), so light/dark and future theme changes follow the
 * host. Every class is prefixed `wcb-` to stay out of the host's namespace.
 */
export const STYLES = /* css */ `
/* Dialogs are portalled to document.body, outside .wcb-page, so the aliases
   are declared on both roots — and nothing else is: .wcb-dialog is DSH's own
   Modal element, whose padding and layout must stay DSH's. */
.wcb-page, .wcb-dialog {
  --wcb-text: var(--dsw-alias-label-primary, #0f1115);
  --wcb-text-2: var(--dsw-alias-label-secondary, #61666b);
  --wcb-text-3: var(--dsw-alias-label-tertiary, #81858c);
  --wcb-line: var(--dsw-alias-border-l2, rgba(0, 0, 0, .1));
  --wcb-line-strong: var(--dsw-alias-border-l3, rgba(0, 0, 0, .12));
  --wcb-field-line: var(--dsw-alias-border-l4, rgba(0, 0, 0, .16));
  --wcb-card: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2, #fff));
  --wcb-card-line: var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l4, rgba(0, 0, 0, .16)));
  --wcb-well: var(--dsw-alias-bg-module-platform, #f5f6f7);
  --wcb-field: var(--dsw-alias-bg-layer-1, #fff);
  --wcb-hover: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, .06));
  --wcb-hover-danger: var(--dsw-alias-interactive-bg-hover-danger, rgba(236, 19, 19, .05));
  --wcb-accent: var(--dsw-alias-state-business-primary, #4176e6);
  --wcb-ok: var(--dsw-alias-state-success-primary, #22c55e);
  --wcb-warn: var(--dsw-alias-state-warn-primary, #f59e0b);
  --wcb-warn-text: var(--dsw-alias-state-warn-label, #dd8629);
  --wcb-warn-bg: var(--dsw-alias-state-warn-tertiary, #fef5e7);
  --wcb-err: var(--dsw-alias-state-error-primary, #ec1313);
  --wcb-focus: var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4176e6));
  --wcb-focus-width: var(--dsw-focus-ring-width, 2px);
  --wcb-radius-card: var(--dsw-radius-xl, 20px);
  --wcb-radius-lg: var(--dsw-radius-lg, 16px);
  --wcb-radius-md: var(--dsw-radius-md, 12px);
  --wcb-radius-sm: var(--dsw-radius-sm, 8px);
  --wcb-radius-xs: var(--dsw-radius-xs, 4px);
  --wcb-mono: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
}

/* The page sits in the Plugin Manager's detail column (max 960px), between
   the package header and its rows, so it uses that page's 32px rhythm. */
.wcb-page {
  display: flex; flex-direction: column; gap: 32px; min-width: 0;
  color: var(--wcb-text); font-size: 13px; line-height: 20px;
}
.wcb-page *, .wcb-page *::before, .wcb-page *::after,
.wcb-dialog-body, .wcb-dialog-body *, .wcb-dialog-body *::before, .wcb-dialog-body *::after { box-sizing: border-box; }
.wcb-status-text { margin: 0; color: var(--wcb-text-3); font-size: 13px; line-height: 20px; }
.wcb-spacer { flex: 1; min-width: 0; }
.wcb-mono { font-family: var(--wcb-mono); font-size: 12px; }
.wcb-muted { color: var(--wcb-text-3); }

/* Sections: a 14px title, a quiet count, actions on the right. */
.wcb-section { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.wcb-section-head { display: flex; align-items: center; gap: 8px; min-height: 28px; }
.wcb-section-title { margin: 0; font-size: 14px; font-weight: 500; line-height: 20px; color: var(--wcb-text); }
.wcb-section-count { color: var(--wcb-text-2); font-size: 12px; line-height: 18px; font-variant-numeric: tabular-nums; }
.wcb-section-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.wcb-section-desc { margin: -6px 0 0; color: var(--wcb-text-3); font-size: 12px; line-height: 18px; }
.wcb-section-toggle {
  display: inline-flex; align-items: center; gap: 8px; min-width: 0; padding: 0;
  border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.wcb-section-toggle:focus-visible { outline: var(--wcb-focus-width) solid var(--wcb-focus); outline-offset: 2px; border-radius: var(--wcb-radius-xs); }
.wcb-section-summary { color: var(--wcb-text-3); font-size: 12px; line-height: 18px; }

/* Notices: DSH's inline warning surface. */
.wcb-notices { display: flex; flex-direction: column; gap: 8px; }
.wcb-notice {
  display: flex; align-items: flex-start; gap: 8px; margin: 0; padding: 10px 12px;
  border-radius: var(--wcb-radius-md); background: var(--wcb-warn-bg);
  color: var(--wcb-text-2); font-size: 12px; line-height: 18px;
}
.wcb-notice-icon { flex: none; display: inline-flex; margin-top: 1px; color: var(--wcb-warn); }
.wcb-notice[data-tone="error"] { background: color-mix(in srgb, var(--wcb-err) 8%, transparent); color: var(--wcb-err); }
.wcb-notice[data-tone="error"] .wcb-notice-icon { color: var(--wcb-err); }

/* Settings cards: one per object (the connection, a group, a list). */
.wcb-card {
  min-width: 0; border: .5px solid var(--wcb-card-line); border-radius: var(--wcb-radius-card);
  background: var(--wcb-card);
}
.wcb-card-body { display: flex; flex-direction: column; gap: 8px; padding: 12px 16px; }
.wcb-empty-line { margin: 0; color: var(--wcb-text-3); font-size: 12px; line-height: 18px; }
.wcb-empty {
  margin: 0; padding: 12px; border: 1px dashed var(--wcb-line-strong); border-radius: var(--wcb-radius-lg);
  color: var(--wcb-text-3); font-size: 12px; line-height: 18px; text-align: center;
}

/* Inline key/value facts in a summary line. */
.wcb-kvs { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 16px; margin: 0; font-size: 12px; line-height: 18px; }
.wcb-kv { display: inline-flex; align-items: baseline; gap: 6px; min-width: 0; }
.wcb-kv-label { flex: none; color: var(--wcb-text-3); }
.wcb-kv-value { min-width: 0; color: var(--wcb-text-2); overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }

/* Connection */
.wcb-connection-head { display: flex; align-items: center; gap: 8px; min-height: 28px; }
.wcb-status { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.wcb-status-label { font-size: 14px; font-weight: 500; line-height: 22px; }
.wcb-status-since { color: var(--wcb-text-3); font-size: 12px; line-height: 18px; }
.wcb-status-detail { margin: 0; color: var(--wcb-text-2); font-size: 12px; line-height: 18px; }
.wcb-status-detail[data-tone="error"] { color: var(--wcb-err); }
.wcb-status-detail[data-tone="warning"] { color: var(--wcb-warn-text); }
.wcb-saved { color: var(--wcb-ok); font-size: 12px; line-height: 18px; }
.wcb-card-body > .wcb-editor { margin-top: 6px; }

/* Lists inside a card: hairline rows, DSH row rhythm. */
.wcb-list { list-style: none; margin: 0; padding: 0 16px; }
.wcb-list > li { padding: 12px 0; border-top: .5px solid var(--wcb-line); }
.wcb-list > li:first-child { border-top: 0; }
.wcb-row-line { display: flex; align-items: center; gap: 12px; min-width: 0; }
.wcb-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.wcb-row-title { min-width: 0; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wcb-row-quote { min-width: 0; color: var(--wcb-text-3); font-size: 12px; line-height: 18px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wcb-row-meta { flex: none; color: var(--wcb-text-3); font-size: 12px; line-height: 18px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.wcb-list > li > .wcb-editor { margin-top: 12px; }

/* People: a kind badge (person / group chat) and the name it is known by. */
.wcb-avatar {
  flex: none; display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 50%;
}
.wcb-avatar[data-kind="user"] { color: var(--wcb-accent); background: color-mix(in srgb, var(--wcb-accent) 12%, transparent); }
.wcb-avatar[data-kind="group"] { color: var(--wcb-warn-text); background: color-mix(in srgb, var(--wcb-warn) 16%, transparent); }
.wcb-person {
  display: inline-flex; align-items: center; gap: 8px; min-width: 0; max-width: 100%; padding: 0;
  border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.wcb-person-name { min-width: 0; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wcb-person-chevron { flex: none; display: inline-flex; color: var(--wcb-text-3); }
.wcb-person:hover:not(:disabled) .wcb-person-name { text-decoration: underline; text-underline-offset: 3px; }
.wcb-person:hover:not(:disabled) .wcb-person-chevron { color: var(--wcb-text); }
.wcb-person:disabled { cursor: default; opacity: .5; }
.wcb-person:focus-visible { outline: var(--wcb-focus-width) solid var(--wcb-focus); outline-offset: 2px; border-radius: var(--wcb-radius-xs); }
.wcb-identity { display: flex; align-items: center; gap: 8px; min-width: 0; }

/* Groups */
.wcb-groups { display: flex; flex-direction: column; gap: 8px; }
.wcb-group-head { display: flex; align-items: flex-start; gap: 12px; padding: 12px 16px; }
.wcb-group-toggle {
  flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: stretch; gap: 2px; padding: 0;
  border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.wcb-group-toggle:focus-visible { outline: var(--wcb-focus-width) solid var(--wcb-focus); outline-offset: 4px; border-radius: var(--wcb-radius-xs); }
.wcb-group-title-line { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 28px; }
.wcb-chevron { flex: none; display: inline-flex; color: var(--wcb-text-3); transition: transform .14s ease, color .1s ease; }
.wcb-group-toggle:hover .wcb-chevron, .wcb-section-toggle:hover .wcb-chevron { color: var(--wcb-text); }
.wcb-group[data-open] .wcb-group-head .wcb-chevron, .wcb-section-toggle[aria-expanded="true"] .wcb-chevron,
.wcb-scope-toggle[aria-expanded="true"] .wcb-chevron { transform: rotate(90deg); }
.wcb-group-name { min-width: 0; font-size: 14px; font-weight: 500; line-height: 22px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wcb-group-count { flex: none; color: var(--wcb-text-3); font-size: 12px; line-height: 18px; }
/* The overview names every fact a group owns; values wrap instead of hiding
   behind an ellipsis, and the line is indented under the name. */
.wcb-group-facts { padding-left: 22px; }
.wcb-group-actions { flex: none; display: flex; align-items: center; gap: 8px; min-height: 28px; }
.wcb-group-error { margin: -4px 16px 12px 38px; color: var(--wcb-err); font-size: 12px; line-height: 18px; }
.wcb-group > .wcb-editor { margin: 0 16px 14px; }
.wcb-group-body { padding: 0 16px 8px; }
.wcb-group-body > .wcb-empty { margin-bottom: 8px; }

/* Members: a semantic table, left-aligned like every DSH list. */
.wcb-table-scroll { overflow-x: auto; margin: 0 -16px; padding: 0 16px; }
.wcb-table-scroll:focus-visible { outline: var(--wcb-focus-width) solid var(--wcb-focus); outline-offset: -2px; }
.wcb-table { width: 100%; min-width: 790px; border-collapse: collapse; table-layout: fixed; }
.wcb-table th, .wcb-table td { padding: 8px 12px 8px 0; text-align: left; vertical-align: middle; white-space: nowrap; }
.wcb-table th:last-child, .wcb-table td:last-child { padding-right: 0; }
.wcb-table th { border-top: .5px solid var(--wcb-line); color: var(--wcb-text-3); font-size: 12px; font-weight: 400; line-height: 18px; }
.wcb-table td { border-top: .5px solid var(--wcb-line); overflow: hidden; text-overflow: ellipsis; }
.wcb-col-session { width: 108px; }
.wcb-col-model { width: 200px; }
.wcb-col-effort { width: 108px; }
.wcb-col-access { width: 128px; }
.wcb-col-context { width: 140px; }
.wcb-member-error td { white-space: normal; }

/* The bound Session: a pill that opens its details, never navigates itself. */
.wcb-session {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%; height: 24px; padding: 0 6px 0 8px;
  border: .5px solid var(--wcb-line-strong); border-radius: 999px; background: transparent;
  color: var(--wcb-text-2); font: inherit; font-size: 12px; line-height: 18px; cursor: pointer;
}
.wcb-session:hover:not(:disabled) { background: var(--wcb-hover); color: var(--wcb-text); }
.wcb-session:focus-visible { outline: var(--wcb-focus-width) solid var(--wcb-focus); outline-offset: 2px; }
.wcb-session:disabled { cursor: default; opacity: .5; }
.wcb-session[data-running] { color: var(--wcb-text); }
.wcb-session-chevron { display: inline-flex; color: var(--wcb-text-3); }

/* Context occupancy: a short bar that turns amber and red as it fills. */
.wcb-meter { display: inline-flex; align-items: center; gap: 8px; max-width: 100%; }
.wcb-meter-track { flex: none; width: 36px; height: 4px; border-radius: 2px; background: var(--wcb-line); overflow: hidden; }
.wcb-meter-fill { display: block; height: 100%; border-radius: inherit; background: var(--wcb-text-3); }
.wcb-meter[data-level="warn"] .wcb-meter-fill { background: var(--wcb-warn); }
.wcb-meter[data-level="high"] .wcb-meter-fill { background: var(--wcb-err); }
.wcb-meter-text { color: var(--wcb-text-2); font-size: 12px; font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; }

/* Native select dressed like DSH's settings selects. */
.wcb-select {
  box-sizing: border-box; min-width: 0; max-width: 100%; height: 32px; padding: 0 30px 0 10px;
  border: .5px solid var(--wcb-field-line); border-radius: var(--wcb-radius-md);
  background: var(--wcb-field) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 10px center / 12px 12px;
  color: var(--wcb-text); font: inherit; font-size: 13px; line-height: 20px;
  appearance: none; -webkit-appearance: none; cursor: pointer; text-overflow: ellipsis;
}
.wcb-select:focus-visible { outline: none; border-color: var(--wcb-focus); }
.wcb-select:disabled { cursor: default; opacity: .5; }
.wcb-select[data-compact] { height: 28px; padding: 0 24px 0 8px; border-radius: var(--wcb-radius-sm); font-size: 12px; line-height: 18px; background-position: right 7px center; }
.wcb-table .wcb-select { width: 100%; }
.wcb-input { width: 100%; }
.wcb-input-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.wcb-input-row > .wcb-input { flex: 1; }
.wcb-number { width: 88px; }

/* Inline editors: a recessed well with stacked fields, actions at the end. */
.wcb-editor {
  display: flex; flex-direction: column; gap: 14px; min-width: 0; padding: 14px 16px;
  border-radius: var(--wcb-radius-lg); background: var(--wcb-well);
}
.wcb-editor-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 16px; }
.wcb-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.wcb-field-label { color: var(--wcb-text-2); font-size: 12px; font-weight: 500; line-height: 18px; }
.wcb-hint { margin: 0; color: var(--wcb-text-3); font-size: 12px; line-height: 18px; }
.wcb-error { margin: 0; color: var(--wcb-err); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.wcb-field[data-invalid] .wcb-input { border-color: var(--wcb-err); }
.wcb-footer { display: flex; align-items: center; gap: 8px; min-width: 0; }
.wcb-footer-message { flex: 1; min-width: 0; margin: 0; color: var(--wcb-text-3); font-size: 12px; line-height: 18px; }
.wcb-footer-message[data-tone="error"] { color: var(--wcb-err); }
.wcb-footer-message[data-tone="success"] { color: var(--wcb-ok); }
.wcb-footer-message[data-tone="dirty"] { color: var(--wcb-warn-text); }
.wcb-switch-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; color: var(--wcb-text-2); }
.wcb-textarea {
  width: 100%; box-sizing: border-box; min-height: 240px; resize: vertical; padding: 10px 12px;
  border: 1px solid var(--wcb-field-line); border-radius: var(--wcb-radius-sm); background: var(--wcb-field);
  color: var(--wcb-text); font: 12px/1.7 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.wcb-textarea:focus-visible { outline: 2px solid var(--wcb-accent); outline-offset: 1px; }
.wcb-path { display: flex; align-items: center; gap: 4px; min-width: 0; }
.wcb-path-text { flex: 1; min-width: 0; color: var(--wcb-text-2); font-family: var(--wcb-mono); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }

/* Buttons beyond the primitives: danger, text links and small icon buttons. */
.wcb-page .wcb-danger, .wcb-dialog .wcb-danger {
  color: var(--wcb-err); border-color: color-mix(in srgb, var(--wcb-err) 30%, transparent);
  --dsw-alias-interactive-bg-hover: var(--wcb-hover-danger);
}
.wcb-page .wcb-danger-solid, .wcb-dialog .wcb-danger-solid {
  --dsw-alias-button-primary-fill: var(--wcb-err); --dsw-alias-button-primary-hover: var(--wcb-err);
}
.wcb-link {
  padding: 0; border: 0; background: none; color: var(--wcb-accent); font: inherit;
  font-size: 12px; line-height: 18px; cursor: pointer; white-space: nowrap;
}
.wcb-link:hover:not(:disabled) { text-decoration: underline; text-underline-offset: 3px; }
.wcb-link:disabled { color: var(--wcb-text-3); cursor: default; }
.wcb-link:focus-visible { outline: var(--wcb-focus-width) solid var(--wcb-focus); outline-offset: 2px; border-radius: var(--wcb-radius-xs); }
.wcb-icon-button {
  flex: none; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0;
  border: 0; border-radius: var(--wcb-radius-sm); background: none; color: var(--wcb-text-3); cursor: pointer;
}
.wcb-icon-button:hover:not(:disabled) { background: var(--wcb-hover); color: var(--wcb-text); }
.wcb-icon-button:focus-visible { outline: var(--wcb-focus-width) solid var(--wcb-focus); outline-offset: 1px; }

/* Administrators and their notification scope. */
.wcb-scope { padding: 10px 16px 12px; border-top: .5px solid var(--wcb-line); }
.wcb-scope-head { display: flex; align-items: center; gap: 8px; min-height: 28px; }
.wcb-scope-toggle {
  display: inline-flex; align-items: center; gap: 8px; min-width: 0; padding: 0;
  border: 0; background: none; color: inherit; font: inherit; cursor: pointer;
}
.wcb-scope-toggle:focus-visible { outline: var(--wcb-focus-width) solid var(--wcb-focus); outline-offset: 2px; border-radius: var(--wcb-radius-xs); }
.wcb-scope-list { list-style: none; margin: 6px 0 0; padding: 0 0 0 22px; }
.wcb-scope-list > li { border-top: .5px solid var(--wcb-line); }
.wcb-scope-list > li:first-child { border-top: 0; }
.wcb-check-row { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 8px 0; cursor: pointer; }
.wcb-check-row input { flex: none; width: 16px; height: 16px; margin: 0; accent-color: var(--dsw-alias-brand-primary, #0f1115); cursor: inherit; }
.wcb-check-row input:focus-visible { outline: var(--wcb-focus-width) solid var(--wcb-focus); outline-offset: 2px; }
.wcb-check-row:has(input:disabled) { cursor: default; opacity: .5; }
.wcb-scope-list + .wcb-hint { margin: 4px 0 0 22px; }

/* Dialog content. The dialog itself keeps DSH's padding; only its width and
   the stacking of our own content are set here. */
[role="dialog"].wcb-dialog { width: min(480px, 100%); }
.wcb-dialog-body { display: flex; flex-direction: column; gap: 14px; min-width: 0; color: var(--wcb-text); font-size: 13px; line-height: 20px; }
.wcb-facts { margin: 0; }
.wcb-facts > div {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  min-height: 44px; padding: 8px 0; border-bottom: .5px solid var(--wcb-line);
}
.wcb-facts > div:last-child { border-bottom: 0; }
.wcb-facts dt { flex: none; color: var(--wcb-text-2); }
.wcb-facts dd { display: flex; align-items: center; justify-content: flex-end; gap: 6px; min-width: 0; margin: 0; text-align: end; overflow-wrap: anywhere; }
.wcb-facts dd .wcb-input, .wcb-facts dd .wcb-select { width: 220px; max-width: 100%; }
.wcb-check { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; }
.wcb-check input { flex: none; width: 14px; height: 14px; margin: 3px 0 0; accent-color: var(--wcb-focus); cursor: pointer; }
.wcb-confirm-text { margin: 0; color: var(--wcb-text-2); }
.wcb-footer-start { margin-right: auto; }
span.wcb-footer-start { display: inline-flex; align-items: center; gap: 8px; }
.wcb-picker-list { display: flex; flex-direction: column; max-height: 300px; overflow: auto; margin: 0 -8px; }
.wcb-picker-row {
  display: flex; align-items: baseline; gap: 10px; width: 100%; padding: 8px; border: 0; border-radius: var(--wcb-radius-sm);
  background: none; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.wcb-picker-row:hover, .wcb-picker-row:focus-visible { background: var(--wcb-hover); outline: none; }
.wcb-picker-hint { min-width: 0; color: var(--wcb-text-3); font-size: 12px; line-height: 18px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wcb-picker-manual { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px dashed var(--wcb-line-strong); border-radius: var(--wcb-radius-md); }

@media (max-width: 640px) {
  .wcb-editor-grid { grid-template-columns: minmax(0, 1fr); }
  .wcb-row-meta { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .wcb-chevron { transition: none; }
}
`;

export function insertStyles(doc: Document = document): () => void {
  const element = doc.createElement('style');
  element.setAttribute('data-dsh-plugin', 'wecom-soul-bot');
  element.textContent = STYLES;
  doc.head.appendChild(element);
  return () => element.remove();
}
