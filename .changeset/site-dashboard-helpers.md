---
"@opengeni/sdk": patch
"@opengeni/codemode": patch
"@opengeni/runtime": patch
---

Apps get dashboard building blocks: `/__opengeni/ui.css` adds KPI cards, number cells, good and bad tones, chart colours per theme, details and empty states, and `/__opengeni/charts.js` (`SITE_CHARTS_JS`, inlined by `resolveSiteUiStylesheet`) draws formatted KPIs, bars, line and scatter charts and sortable tables. The `sites` Skill sends dashboards to a short `references/dashboards.md`.
