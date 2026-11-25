# Dashboards

A dashboard answers a few questions at a glance. Build it from the Opengeni
look and the host's chart helpers; don't hand-draw SVG charts. For dashboards
this page takes precedence over general layout advice.

```html
<link rel="stylesheet" href="/__opengeni/ui.css">
<script src="/__opengeni/charts.js"></script>
<body class="og-app"><main class="og-page og-page-wide og-stack" style="gap:28px">
  <header><h1 class="og-title">Q3 sales</h1><p class="og-muted">Jul–Sep 2026 · updated 1 Oct</p></header>
  <p style="font-size:1.125rem">Revenue beat target by 4%; Europe carried the quarter.</p>
  <div id="kpis"></div>
  <div class="og-grid">
    <section><h2 class="og-heading">Revenue beat target every month</h2><div id="trend"></div></section>
    <section><h2 class="og-heading">Europe grew most</h2><div id="regions"></div></section>
  </div>
  <section><h2 class="og-heading">Products</h2><div id="products"></div></section>
  <details class="og-details"><summary>Method and raw counts</summary>…</details>
</main>
<script>
  // months, regions, products: your data arrays
  og.kpis("#kpis", [{ label: "Revenue", value: 3.1e6, format: "money", delta: 12.4, deltaLabel: "vs Q2" }]);
  og.line("#trend", { data: months, x: "month", series: [{ key: "revenue", label: "Revenue" }, { key: "target", label: "Target" }], format: "money" });
  og.bars("#regions", { data: regions, label: "region", value: "growth", format: "pct" });
  og.table("#products", { rows: products, columns: [{ key: "name", label: "Product" }, { key: "revenue", label: "Revenue", format: "money", better: "higher" }], limit: 8 });
</script>
```

`og` (from `/__opengeni/charts.js`):

| Call | For |
| --- | --- |
| `og.kpis(el, [{label, value, format, delta, deltaUnit, better, deltaLabel, note}])` | Headline numbers with their change. `deltaUnit` `"%"` (default) or `"pp"`; `better: "lower"` for costs, latency, errors. `value: null` shows a dash and the `note`. |
| `og.bars(el, {data, label, value or series, format, highlight, ci, sort})` | Comparing categories: sorted horizontal bars with values at the ends; negatives diverge from zero. `ci: [lowKey, highKey]` draws intervals. |
| `og.line(el, {data, x, y or series, format, refs, zero, area})` | Change over time; `refs: [{value, label}]` for targets and limits. |
| `og.scatter(el, {data, x, y, label, group, xFormat, yFormat, xLabel, yLabel, better, highlight, ci})` | Trade-offs such as cost against quality; `better: {x: "lower", y: "higher"}` marks the good corner. |
| `og.table(el, {rows, columns: [{key, label, format, better, bar, optional}], sort, highlight, limit})` | Exact values: sortable, numbers right-aligned, best value bold, `optional` columns hidden on phones, `limit` adds Show all. |

- Formats: `"num"`, `"int"`, `"compact"`, `"money"` (`{type: "money", currency: "EUR"}`), `"pct"` (already in percent), `"ratio"` (0–1), `"ms"`, `"minutes"`, `"date"`, `"month"`, `"time"` or a function. `og.fmt.<name>(value)` formats your own text; `og.fmt.delta(value, {unit, better})` returns `{text, tone}` for class `og-good`, `og-bad` or `og-flat`.
- `highlight`: a series, group or label name (a table matches its first column), or `row => boolean`. It colours that item and greys the rest.
- Empty data shows "No data yet" (`empty` changes it). Your own markup uses `og-num` for numbers and `og-details` for secondary detail.

- **Answer first, calmly.** A title, one line of scope and freshness, the verdict in one plain sentence, then three to six KPIs, each against a comparison (target, last period, competitors). Words carry the direction ("18% cheaper"), colour confirms it. Charts and tables sit on the page, not in cards; no banners or tinted panels.
- **One question per chart**, titled with the question or the finding. Trend: line. Compare: bars. Trade-off: scatter. Exact values: table. No pies, gauges, 3D or dual axes.
- **Colour means something.** Neutral by default, one highlight for the subject, green and red only for good and bad, never colour alone. Series colours come from `--og-series-1`…`6`; don't invent palettes or token names.
- **Density.** About six KPIs, two to four charts and tables of six columns or fewer in the main view. Secondary metrics (token counts, raw totals, ids, method) go in `og-details` or a second view.
- **Early or missing data** shows a dash and why ("12 of 120 tasks, too early"), never a zero or a verdict, and the subtitle says the results are interim.
- **Check** at 1280 and 390 px, light and dark.

A bundler can't resolve the script tag, so a built app adds
`<script src="/__opengeni/charts.js"></script>` to `dist/index.html` after the
build.
