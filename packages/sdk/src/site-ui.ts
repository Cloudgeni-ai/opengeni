/**
 * Opengeni's look for apps (Sites): a small stylesheet an app opts into with
 *
 *   <link rel="stylesheet" href="/__opengeni/ui.css">
 *
 * or, in an app built by a bundler (which would try to resolve the link),
 *
 *   <style>@import "/__opengeni/ui.css";</style>
 *
 * In Opengeni either is replaced by the stylesheet itself (no request, so no
 * unstyled first paint); a published Site's gateway and the local preview
 * serve it at that path. It defines `--og-*` tokens that follow Opengeni's
 * light or dark theme (the frame's `prefers-color-scheme`, or
 * `data-og-theme="light|dark"` on `<html>`), and opt-in classes. Nothing
 * outside `.og-app` and the `og-*` classes is styled, so an app keeps its own
 * look unless it asks for this one.
 *
 * Dashboards also add `<script src="/__opengeni/charts.js"></script>` (see
 * `./site-charts`): KPI cards, charts and tables drawn with the dashboard
 * classes below, inlined the same way.
 */
import { SITE_CHARTS_JS, SITE_CHARTS_SCRIPT_PATH } from "./site-charts";

export { SITE_CHARTS_JS, SITE_CHARTS_SCRIPT_PATH };
export const SITE_UI_STYLESHEET_PATH = "/__opengeni/ui.css";

const LIGHT = `--og-bg:#f6f6f6;--og-canvas:#ffffff;--og-surface:#ffffff;--og-surface-2:#eeeeee;--og-surface-3:#e5e5e5;--og-selection:#e2e2e2;--og-border:#dedede;--og-border-strong:#bdbdbd;--og-fg:#242424;--og-fg-label:#3a3a3a;--og-fg-muted:#5f5f5f;--og-fg-subtle:#696969;--og-accent:#545454;--og-accent-fg:#ffffff;--og-primary:#ebf2f0;--og-primary-ink:#292929;--og-primary-edge:#c4d5d0;--og-danger:#b42318;--og-success:#237058;--og-warning:#8c5524;--og-focus:#3884ff;--og-series-1:#2f6fdb;--og-series-2:#d9721c;--og-series-3:#1b9670;--og-series-4:#8a57cc;--og-series-5:#cc4458;--og-series-6:#7f7f22;--og-series-muted:#c2c2c2;color-scheme:light`;
const DARK = `--og-bg:#303030;--og-canvas:#202020;--og-surface:#333333;--og-surface-2:#383838;--og-surface-3:#404040;--og-selection:#484848;--og-border:#454545;--og-border-strong:#555555;--og-fg:#e6e6e6;--og-fg-label:#d4d4d4;--og-fg-muted:#b8b8b8;--og-fg-subtle:#a3a3a3;--og-accent:#c4c4c4;--og-accent-fg:#242424;--og-primary:#2b3432;--og-primary-ink:#eeeeee;--og-primary-edge:#4e5e59;--og-danger:#f97066;--og-success:#83cbb0;--og-warning:#e9ab77;--og-focus:#488ceb;--og-series-1:#6f9df5;--og-series-2:#efa05a;--og-series-3:#4cc79d;--og-series-4:#b48af0;--og-series-5:#f07a8a;--og-series-6:#c2c25a;--og-series-muted:#5c5c5c;color-scheme:dark`;

/** The stylesheet `/__opengeni/ui.css` (docs/site-runtime-api.md "Opengeni look"). */
export const SITE_UI_CSS = [
  `:root{${LIGHT};--og-font-sans:"Inter Variable",Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--og-font-mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;--og-radius:10px;--og-radius-card:14px}`,
  `@media (prefers-color-scheme:dark){:root:not([data-og-theme=light]){${DARK}}}`,
  `:root[data-og-theme=dark]{${DARK}}`,
  `.og-app{margin:0;min-height:100vh;box-sizing:border-box;background:var(--og-canvas);color:var(--og-fg);font:400 0.875rem/1.43 var(--og-font-sans);-webkit-font-smoothing:antialiased}`,
  `.og-app *,.og-app *::before,.og-app *::after{box-sizing:border-box}`,
  `.og-page{max-width:960px;margin:0 auto;padding:24px 24px 44px}.og-page-wide{max-width:1136px}`,
  `.og-title{margin:0 0 4px;font-size:1.25rem;line-height:1.4;font-weight:600;letter-spacing:-.5px}`,
  `.og-heading{margin:0 0 12px;font-size:1rem;line-height:1.5;font-weight:600;letter-spacing:-.2px}`,
  `.og-muted{color:var(--og-fg-muted)}.og-subtle{color:var(--og-fg-subtle);font-size:0.75rem;line-height:1.5}`,
  `.og-mono{font-family:var(--og-font-mono);font-size:0.75rem;line-height:1.5}`,
  `.og-stack{display:grid;gap:12px}.og-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}`,
  `.og-card{background:var(--og-surface);border:1px solid var(--og-border);border-radius:var(--og-radius-card);padding:16px 20px}`,
  `.og-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:2rem;padding:0 12px;border-radius:var(--og-radius);border:1px solid var(--og-border);background:var(--og-surface);color:var(--og-fg);font:500 0.875rem/1.43 var(--og-font-sans);cursor:pointer;text-decoration:none;transition:background-color .15s}`,
  `.og-button:hover{background:var(--og-surface-2)}.og-button:disabled{opacity:.5;cursor:default}`,
  `.og-button:focus-visible,.og-input:focus-visible{outline:2px solid var(--og-focus);outline-offset:1px}`,
  `.og-button-primary{background:var(--og-accent);border-color:var(--og-accent);color:var(--og-accent-fg)}.og-button-primary:hover{background:var(--og-accent);opacity:.9}`,
  `.og-button-ghost{background:transparent;border-color:transparent}.og-button-danger{color:var(--og-danger)}`,
  `.og-input{min-height:2rem;width:100%;padding:0 10px;border-radius:var(--og-radius);border:1px solid var(--og-border);background:var(--og-canvas);color:var(--og-fg);font:400 0.875rem/1.43 var(--og-font-sans)}`,
  `textarea.og-input{min-height:4.5rem;padding:6px 10px}`,
  `@media (pointer:coarse){.og-input{font-size:1rem}}`,
  `.og-label{display:grid;gap:4px;font-weight:500}`,
  `.og-badge{display:inline-flex;align-items:center;min-height:1.25rem;padding:0 8px;border-radius:999px;background:var(--og-surface-2);color:var(--og-fg-label);font-size:0.6875rem;line-height:1.45;font-weight:500}`,
  `.og-badge-success{color:var(--og-success)}.og-badge-warning{color:var(--og-warning)}.og-badge-danger{color:var(--og-danger)}`,
  `.og-table{width:100%;border-collapse:collapse}.og-table th{text-align:left;font-weight:500;color:var(--og-fg-muted);font-size:0.75rem;line-height:1.5}`,
  `.og-table th,.og-table td{padding:8px 12px;border-bottom:1px solid var(--og-border)}.og-table tr:last-child td{border-bottom:0}`,
  `.og-link{color:var(--og-fg);text-decoration:underline;text-underline-offset:2px}`,
  // Selected state for toggles and tab-like buttons.
  `.og-button[aria-pressed=true],.og-button[aria-selected=true]{background:var(--og-surface-3);border-color:var(--og-border-strong);font-weight:600}`,
  // Dashboards: layout, KPI cards, numbers, tones, details, empty state.
  `.og-grid{display:grid;gap:16px;align-items:start;grid-template-columns:repeat(auto-fit,minmax(min(100%,22rem),1fr))}.og-grid>*,.og-stack>*{min-width:0}`,
  `.og-kpis{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(min(100%,9rem),1fr))}`,
  `.og-kpi{display:grid;gap:2px;align-content:start;min-width:0;background:var(--og-surface);border:1px solid var(--og-border);border-radius:var(--og-radius-card);padding:14px 16px}.og-kpi-highlight{border-color:var(--og-border-strong)}`,
  `.og-kpi-label{color:var(--og-fg-muted);font-size:0.8125rem;line-height:1.4;font-weight:500}`,
  `.og-kpi-value{font-size:1.75rem;line-height:1.2;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}`,
  `.og-kpi-delta{font-size:0.8125rem;line-height:1.4;font-weight:600;font-variant-numeric:tabular-nums}.og-kpi-delta-label{font-weight:400;color:var(--og-fg-muted)}`,
  `.og-kpi-note{color:var(--og-fg-subtle);font-size:0.75rem;line-height:1.4}`,
  `.og-good{color:var(--og-success)}.og-bad{color:var(--og-danger)}.og-warn{color:var(--og-warning)}.og-flat{color:var(--og-fg-muted)}.og-strong{font-weight:600;color:var(--og-fg)}`,
  `.og-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}`,
  `.og-empty{padding:24px 16px;text-align:center;color:var(--og-fg-muted);border:1px dashed var(--og-border);border-radius:var(--og-radius-card)}`,
  `.og-details>summary{cursor:pointer;font-weight:500;padding:8px 0;color:var(--og-fg-label)}.og-details[open]>summary{margin-bottom:8px}`,
  `.og-table-wrap{overflow-x:auto;max-width:100%}`,
  `.og-table td,.og-table tbody th{font-size:0.875rem;line-height:1.43;text-align:left;font-weight:400;color:var(--og-fg)}.og-table .og-num{text-align:right}.og-table tbody tr:last-child>*{border-bottom:0}`,
  `.og-table tbody tr:hover>*{background:var(--og-surface-2)}.og-table tr.og-highlight>*{background:var(--og-primary);font-weight:500}`,
  `.og-table .og-best{font-weight:600}.og-table .og-sort{all:unset;cursor:pointer;color:inherit}.og-table .og-sort:focus-visible{outline:2px solid var(--og-focus)}`,
  `.og-table th[aria-sort=descending] .og-sort::after{content:" \\2193"}.og-table th[aria-sort=ascending] .og-sort::after{content:" \\2191"}`,
  `.og-cell-bar{display:inline-block;width:56px;height:6px;margin-right:8px;border-radius:3px;background:var(--og-surface-2);vertical-align:middle;overflow:hidden}.og-cell-bar-fill{display:block;height:100%;background:var(--og-series-1)}`,
  `.og-more{margin-top:8px}`,
  // Charts drawn by /__opengeni/charts.js.
  `.og-chart{position:relative;width:100%;min-width:0}.og-chart svg{display:block;overflow:visible}`,
  `.og-chart text{font-family:var(--og-font-sans);font-size:0.75rem;fill:var(--og-fg-muted);font-variant-numeric:tabular-nums}`,
  `.og-chart .og-axis-title{fill:var(--og-fg-label);font-weight:500}.og-chart .og-point-label{fill:var(--og-fg-label)}.og-chart .og-strong{fill:var(--og-fg);font-weight:600}`,
  `.og-chart .og-better{fill:var(--og-fg-subtle);font-style:italic}.og-chart .og-ref-label{fill:var(--og-fg-subtle)}`,
  `.og-chart .og-grid{stroke:var(--og-border);stroke-width:1}.og-chart .og-grid-x{stroke-dasharray:2 3}.og-chart .og-ref{stroke:var(--og-fg-subtle);stroke-dasharray:4 4}`,
  `.og-chart .og-line{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}.og-chart .og-line-hl{stroke-width:3}.og-chart .og-area{opacity:.12;stroke:none}`,
  `.og-chart .og-guide{stroke:var(--og-border-strong)}.og-chart .og-dot{stroke:var(--og-canvas);stroke-width:1.5}.og-chart .og-dot:focus{outline:none;stroke:var(--og-focus);stroke-width:2}.og-chart .og-whisker{stroke-width:2;opacity:.45}`,
  `.og-legend{display:flex;flex-wrap:wrap;gap:4px 16px;margin:0 0 8px;font-size:0.8125rem;line-height:1.4;color:var(--og-fg-label)}`,
  `.og-swatch{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px}`,
  `.og-tip{position:absolute;z-index:2;pointer-events:none;background:var(--og-surface);color:var(--og-fg);border:1px solid var(--og-border);border-radius:8px;padding:6px 8px;font-size:0.75rem;line-height:1.5;box-shadow:0 4px 16px rgb(0 0 0/.14);white-space:nowrap}.og-tip-title{font-weight:600}`,
  `.og-bars{display:grid;grid-template-columns:minmax(5rem,max-content) minmax(0,1fr);gap:8px 12px;align-items:center}`,
  `.og-bars-label{font-size:0.875rem;line-height:1.3;color:var(--og-fg-label);max-width:14rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
  `.og-bars-cell{display:grid;gap:3px;min-width:0;padding-right:4.5rem}.og-bars-neg .og-bars-cell{padding-left:4.5rem}`,
  `.og-bars-track{position:relative;height:14px}.og-bars-multi .og-bars-track{height:10px}`,
  `.og-bars-bar{position:absolute;top:0;bottom:0;border-radius:3px;min-width:2px}.og-bars-ci{position:absolute;top:50%;height:2px;margin-top:-1px;background:var(--og-fg);opacity:.55}`,
  `.og-bars-value{position:absolute;top:50%;transform:translateY(-50%);font-size:0.8125rem;line-height:1;white-space:nowrap;font-variant-numeric:tabular-nums;color:var(--og-fg)}`,
  `@media (max-width:480px){.og-bars{grid-template-columns:minmax(0,1fr);gap:2px 0}.og-bars-label{max-width:none}.og-bars-cell{margin-bottom:6px}.og-kpi{padding:12px}.og-kpi-value{font-size:1.375rem}.og-hide-narrow{display:none}}`,
].join("\n");

const STYLESHEET_TAG =
  /<link\b(?=[^>]*\brel\s*=\s*(["']?)stylesheet\1)(?=[^>]*\bhref\s*=\s*(["'])\/__opengeni\/ui\.css\2)[^>]*>/gi;
/** A `<style>` whose whole content is the import of the stylesheet. */
const STYLESHEET_IMPORT =
  /^<style\b[^>]*>\s*@import\s+(?:url\(\s*)?(["']?)\/__opengeni\/ui\.css\1\s*\)?\s*;?\s*<\/style\s*>$/i;
/** An empty `<script src="/__opengeni/charts.js">` (other attributes such as `defer` allowed). */
const CHARTS_SCRIPT_TAG =
  /^<script\b(?=[^>]*\bsrc\s*=\s*(["']?)\/__opengeni\/charts\.js\1(?:[\s>]))[^>]*>\s*<\/script\s*>$/i;

/**
 * Replace the opt-in `<link rel="stylesheet" href="/__opengeni/ui.css">`, or a
 * `<style>` holding only `@import "/__opengeni/ui.css";`, with the stylesheet
 * inline, and `<script src="/__opengeni/charts.js"></script>` with the chart
 * helpers inline. Comments and other scripts stay literal.
 */
export function resolveSiteUiStylesheet(html: string): string {
  if (!html.includes(SITE_UI_STYLESHEET_PATH) && !html.includes(SITE_CHARTS_SCRIPT_PATH)) return html;
  const inline = `<style data-opengeni-ui>${SITE_UI_CSS.replace(/<\/style/gi, "<\\/style")}</style>`;
  return html.replace(
    /<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>|<link\b[^>]*>/gi,
    (tag) => {
      const lower = tag.slice(0, 6).toLowerCase();
      if (lower === "<scrip")
        return CHARTS_SCRIPT_TAG.test(tag)
          ? `<script data-opengeni-charts>${SITE_CHARTS_JS.replace(/<\/script/gi, "<\\/script")}</script>`
          : tag;
      if (lower === "<style") return STYLESHEET_IMPORT.test(tag) ? inline : tag;
      STYLESHEET_TAG.lastIndex = 0;
      if (!lower.startsWith("<link") || !STYLESHEET_TAG.test(tag)) return tag;
      return inline;
    },
  );
}
