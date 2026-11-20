/**
 * Opengeni's look for apps (Sites): a small stylesheet an app opts into with
 *
 *   <link rel="stylesheet" href="/__opengeni/ui.css">
 *
 * In Opengeni the tag is replaced by the stylesheet itself (no request, so no
 * unstyled first paint); a published Site's gateway and the local preview
 * serve it at that path. It defines `--og-*` tokens that follow Opengeni's
 * light or dark theme (the frame's `prefers-color-scheme`, or
 * `data-og-theme="light|dark"` on `<html>`), and opt-in classes. Nothing
 * outside `.og-app` and the `og-*` classes is styled, so an app keeps its own
 * look unless it asks for this one.
 */
export const SITE_UI_STYLESHEET_PATH = "/__opengeni/ui.css";

const LIGHT = `--og-bg:#f6f6f6;--og-canvas:#ffffff;--og-surface:#ffffff;--og-surface-2:#eeeeee;--og-surface-3:#e5e5e5;--og-selection:#e2e2e2;--og-border:#dedede;--og-border-strong:#bdbdbd;--og-fg:#242424;--og-fg-label:#3a3a3a;--og-fg-muted:#5f5f5f;--og-fg-subtle:#696969;--og-accent:#545454;--og-accent-fg:#ffffff;--og-primary:#ebf2f0;--og-primary-ink:#292929;--og-primary-edge:#c4d5d0;--og-danger:#b42318;--og-success:#237058;--og-warning:#8c5524;--og-focus:#3884ff;color-scheme:light`;
const DARK = `--og-bg:#303030;--og-canvas:#202020;--og-surface:#333333;--og-surface-2:#383838;--og-surface-3:#404040;--og-selection:#484848;--og-border:#454545;--og-border-strong:#555555;--og-fg:#e6e6e6;--og-fg-label:#d4d4d4;--og-fg-muted:#b8b8b8;--og-fg-subtle:#a3a3a3;--og-accent:#c4c4c4;--og-accent-fg:#242424;--og-primary:#2b3432;--og-primary-ink:#eeeeee;--og-primary-edge:#4e5e59;--og-danger:#f97066;--og-success:#83cbb0;--og-warning:#e9ab77;--og-focus:#488ceb;color-scheme:dark`;

/** The stylesheet `/__opengeni/ui.css` (docs/site-runtime-api.md "Opengeni look"). */
export const SITE_UI_CSS = [
  `:root{${LIGHT};--og-font-sans:"Inter Variable",Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--og-font-mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;--og-radius:10px;--og-radius-card:14px}`,
  `@media (prefers-color-scheme:dark){:root:not([data-og-theme=light]){${DARK}}}`,
  `:root[data-og-theme=dark]{${DARK}}`,
  `.og-app{margin:0;min-height:100vh;box-sizing:border-box;background:var(--og-canvas);color:var(--og-fg);font:400 14px/20px var(--og-font-sans);-webkit-font-smoothing:antialiased}`,
  `.og-app *,.og-app *::before,.og-app *::after{box-sizing:border-box}`,
  `.og-page{max-width:960px;margin:0 auto;padding:24px 24px 44px}.og-page-wide{max-width:1136px}`,
  `.og-title{margin:0 0 4px;font-size:20px;line-height:28px;font-weight:600;letter-spacing:-.5px}`,
  `.og-heading{margin:0 0 12px;font-size:16px;line-height:24px;font-weight:600;letter-spacing:-.2px}`,
  `.og-muted{color:var(--og-fg-muted)}.og-subtle{color:var(--og-fg-subtle);font-size:12px;line-height:18px}`,
  `.og-mono{font-family:var(--og-font-mono);font-size:12px;line-height:18px}`,
  `.og-stack{display:grid;gap:12px}.og-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}`,
  `.og-card{background:var(--og-surface);border:1px solid var(--og-border);border-radius:var(--og-radius-card);padding:16px 20px}`,
  `.og-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border-radius:var(--og-radius);border:1px solid var(--og-border);background:var(--og-surface);color:var(--og-fg);font:500 14px/20px var(--og-font-sans);cursor:pointer;text-decoration:none;transition:background-color .15s}`,
  `.og-button:hover{background:var(--og-surface-2)}.og-button:disabled{opacity:.5;cursor:default}`,
  `.og-button:focus-visible,.og-input:focus-visible{outline:2px solid var(--og-focus);outline-offset:1px}`,
  `.og-button-primary{background:var(--og-accent);border-color:var(--og-accent);color:var(--og-accent-fg)}.og-button-primary:hover{background:var(--og-accent);opacity:.9}`,
  `.og-button-ghost{background:transparent;border-color:transparent}.og-button-danger{color:var(--og-danger)}`,
  `.og-input{height:32px;width:100%;padding:0 10px;border-radius:var(--og-radius);border:1px solid var(--og-border);background:var(--og-canvas);color:var(--og-fg);font:400 14px/20px var(--og-font-sans)}`,
  `textarea.og-input{height:auto;min-height:72px;padding:6px 10px}`,
  `.og-label{display:grid;gap:4px;font-weight:500}`,
  `.og-badge{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;background:var(--og-surface-2);color:var(--og-fg-label);font-size:11px;line-height:16px;font-weight:500}`,
  `.og-badge-success{color:var(--og-success)}.og-badge-warning{color:var(--og-warning)}.og-badge-danger{color:var(--og-danger)}`,
  `.og-table{width:100%;border-collapse:collapse}.og-table th{text-align:left;font-weight:500;color:var(--og-fg-muted);font-size:12px;line-height:18px}`,
  `.og-table th,.og-table td{padding:8px 12px;border-bottom:1px solid var(--og-border)}.og-table tr:last-child td{border-bottom:0}`,
  `.og-link{color:var(--og-fg);text-decoration:underline;text-underline-offset:2px}`,
].join("\n");

const STYLESHEET_TAG =
  /<link\b(?=[^>]*\brel\s*=\s*(["']?)stylesheet\1)(?=[^>]*\bhref\s*=\s*(["'])\/__opengeni\/ui\.css\2)[^>]*>/gi;

/**
 * Replace the opt-in `<link rel="stylesheet" href="/__opengeni/ui.css">`
 * with the stylesheet inline. Comments and scripts stay literal.
 */
export function resolveSiteUiStylesheet(html: string): string {
  if (!html.includes(SITE_UI_STYLESHEET_PATH)) return html;
  return html.replace(
    /<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>|<link\b[^>]*>/gi,
    (tag) => {
      STYLESHEET_TAG.lastIndex = 0;
      if (!tag.toLowerCase().startsWith("<link") || !STYLESHEET_TAG.test(tag)) return tag;
      return `<style data-opengeni-ui>${SITE_UI_CSS.replace(/<\/style/gi, "<\\/style")}</style>`;
    },
  );
}
