---
name: opengeni-visualize
description: "Create visualizations and interactive tools directly in conversation. Proactively use to show how something works; explore 'what happens when', 'what changes', or 'help me understand'; compare or inspect; create simulations, maps, charts, graphs, and mockups. Use standard tools for static scientific figures."
---

# Visualize

- A request for a new standalone file, website, app page, component, or other project change is not an in-conversation visualization request, even when the deliverable contains charts or interactive content.
- A request to preview, explain, or explore a proposed interface in the conversation is an in-conversation visualization request.
- Create a visual only when the user needs to see or explore it in the conversation and it materially improves the explanation. Do not create an inline visual merely because the request involves data, charts, or an interactive page.
- Use a normal Markdown table when the user asks for a table; return it directly and do not create a visualization file.
- Custom image sizing or gallery layout is also an inline HTML use case, even without interactive controls.
- Use normal Markdown for a static explanation that needs no interaction. Use HTML for dynamics, spatial motion, adjustable inputs, and other visuals.
- In user-facing prose, describe only what the visual helps the user see or decide. Keep it concise and do not repeat information already clear from the visual. Avoid unsolicited implementation commentary; explain the implementation when the user asks.

## Context compaction

Reload this Skill before creating or updating an inline visualization after compaction.

## Inline HTML output contract

### Message source

- Write the visualization directly into your reply in an `opengeni-html` fenced code block. The timeline retains and renders this HTML; no sandbox file or upload is required.
- Ordinary `html` code blocks remain source code. Use the dedicated fence for visuals rendered in chat, including static galleries and diagrams.
- For workspace tools, include `<script src="/__opengeni/site-tools/client.js"></script>` before your own scripts, then call `createOpenGeniSiteClient()`. Discover exact tool names and schemas before authoring calls. This uses the existing viewer permissions and approval flow. Never put credentials, workspace ids, or deployment URLs in the fragment. Use `opengeni-sites` for a saved, reusable page or app.
- Build the visual in the conversation. Use the open project when the user asks for a site, app page, component, or change to existing project files.
- Do not create a Site or publish a file merely to show a self-contained visualization.

### Fragment

For inline HTML, the optional script already supplies the client. Do not install
or search for SDK packages merely to use it. The stable tool API is:

```js
const site = createOpenGeniSiteClient();
const catalog = await site.tools.$catalog({ refresh: true });
// catalog.entries contains identity {serverId, toolName}, title, inputSchema,
// and the other catalog metadata. Use these exact identities and schemas.
const names = catalog.entries.map(entry => entry.identity.toolName);
// When the user requests an actual operation:
// const result = await site.tools.$call(entry.identity, argumentsMatchingInputSchema);
```

Call `$catalog({ refresh: true })` on a Refresh action; without `refresh`, the
client may reuse its snapshot. Render loading and errors, and disable a button
while its request is in flight. Never invent `listTools()` or `tools.catalog()`.
For ordinary REST SDK operations use `site.client` and `site.workspaceId`; read
`opengeni-sites` for those workflows and package types. No real workspace id or
API endpoint is needed in authored HTML.

Read-only data can load when the visual opens. Run operations that change data
from an explicit user action, not automatically on rendering or reopening chat.
Do not automatically retry a failed mutation: it may already have succeeded.
Use the actual returned tool schema and result; do not assume every tool returns
plain JSON. Close the client on page exit.

- Write only an HTML fragment: no `<!doctype>`, `<html>`, `<head>`, or `<body>`.
- Write literal markup: use `<div class="card">Hi</div>` plus a real newline, never `<div class=\"card\">Hi</div>\n`. Never embed the fragment in an inline Python, JavaScript, or shell string. Read it back; rewrite literal `\"` or `\n`.
- Keep CSS and JavaScript in the fragment only when base classes are insufficient. Use version-pinned libraries when useful. Network requests are allowed; handle loading and failures. Use the OpenGeni client for authenticated workspace tools instead of copying credentials or calling provider APIs directly.
- Give the fragment root a unique ID and select it with `document.getElementById(...)`. Never derive the root from `document.currentScript`; scripts may sit outside the root.
- Keep visualizations under 1 MB. Aggregate, bin, downsample, reduce precision, or drop unused fields from large inline datasets.
- Do not open a browser or run a separate validation pass by default. Validate when the user explicitly asks or the Maps guidance below requires it. For validation, check out this skill and wrap a temporary copy with assets/base.css in a style tag and assets/helpers.html after the fragment. These are the same styles and helpers supplied by chat. Inspect it with the browser tools; the final visualization still belongs directly in the reply. For tool-using previews, follow the existing Codemode host setup in opengeni-sites when available.

### Content and response

- Keep the fragment focused on the visualization. Do not include explanatory paragraphs, formulas, instructions, or narrative callouts. Include only necessary labels, legends, values, and accessible text alternatives.
- Use the normal response flow. Put any necessary concise explanation outside the fragment, and put the literal HTML inside an `opengeni-html` fenced block where the visual should appear.
- Whenever you create or update an inline visualization, include the complete replacement fragment in that same reply. A reference to an earlier fragment does not update it.
- Keep contained mockups, dialogs, and mobile screens compact. Stack independent panels when they cannot fit the conversation width; the reader can expand the preview for more space.
- Never announce the fragment as an artifact, website, output, attachment, link, or download. Do not append a Markdown table repeating its data; add at most one short conclusion when needed.

For a normal inline image, use Markdown outside this HTML block:
`![Description](artifact:<artifactId>)`. Publish a sandbox image with
`sandbox_file_publish` first and use its exact returned id. The artifact scheme
is resolved by Markdown; it is not an ordinary browser image URL inside HTML.

Published outputs are discoverable in the workspace Artifacts library and the
session panel. Publish screenshots you deliberately present to the user, not
every temporary capture. Reuse an existing retained reference when showing the
same image again; never substitute a sandbox filesystem link for its durable
image reference. Message-owned HTML remains in chat unless explicitly saved as
a Site; do not create a Site merely to display a PNG.

### Images inside HTML

Use this path for custom image sizing, side-by-side galleries, or images inside
a visualization. Reuse the existing images; do not regenerate or republish them
just to change their layout. Raw HTML in ordinary Markdown is displayed as text.
Inside an `opengeni-html` fragment, `artifact:` is not a browser URL.

Include the client script above. Discover the Files tool once, then request a
fresh URL at render time for each exact file ID from its receipt:

```js
const site = createOpenGeniSiteClient();
const catalog = await site.tools.$catalog();
const tool = catalog.entries.find(entry =>
  entry.identity.serverId === "files" &&
  entry.identity.toolName === "files_get_download_url"
);
if (!tool) throw new Error("Image access unavailable");

const result = await site.tools.$call(tool.identity, { fileId });
const text = result.content.find(part => part.type === "text");
if (!text) throw new Error("Image download unavailable");
const { downloadUrl } = JSON.parse(text.text);
image.src = downloadUrl.url;
```

The Files tool returns MCP text content containing JSON, including
`downloadUrl.url`. Use normal CSS for width, grid/flex layout, and responsiveness.
An `img` can use this URL directly; fetching a Blob is unnecessary for display.
Set load/error handlers before assigning `src`, show loading/failure visibly,
and request a fresh URL when retrying. Close the client on page exit.

Keep durable file IDs in the fragment, not signed URLs from an earlier tool call:
those expire. Use the exact File ID returned by a tool; do not guess one from an
arbitrary artifact. Generated images in OpenGeni have a backing File with the
same ID. Public image URLs can be used directly.

This workflow needs no package installation, SDK-source inspection, shell commands,
or separate preview server. If the tool is unavailable, show that clearly rather
than guessing endpoints or searching installed packages. For saved Sites using
this workflow, include the Files tool identity in their requested tools.

### External resources

- Prefer version-pinned resources from cdn.jsdelivr.net, esm.sh, unpkg.com, or cdnjs.cloudflare.com. These are recommendations, not an exclusive network allowlist. A third-party resource can fail; make loading failures visible.

## Exporting an existing visualization

- Keep the reply fragment as the editable inline source. When the user asks to save or export it, write a standalone HTML document in the sandbox, include assets/base.css and assets/helpers.html from this skill plus the fragment, and publish the exact file with sandbox_file_publish.
- A downloaded HTML file has no OpenGeni tool host. For an offline export, embed the displayed data and images; keep live tool access in a Site. Do not claim live tools work in a standalone download.
- When the user asks to publish or host an existing visualization, use opengeni-sites. A Site can be a small HTML component or a React application; follow that Skill for preview, tool access, and publication.
- For a general website request, build a responsive Site directly rather than applying the inline visualization workflow.
- Do not claim an export or Site was published before its tool confirms success.

## Composition

Choose the smallest composition that fits.

- Prefer interaction detail over permanent panels, toolbars, repeated legends, or long stacks. Add only requested controls, use one mechanism per state, and never invent search, filter, or reset controls.
- Keep filters, selections, and other presentation-only interactions local. Use createOpenGeniSiteClient() for live workspace tools. Put suggested agent investigations outside the fragment as ordinary follow-up prose.
- Show only metrics that explain the requested behavior. Put live values in control headers or on the visual before cards. Treat maxima as ceilings, not targets. Never invent qualitative scores, status cards, or secondary fact grids to fill space.

### UI mockups

- Include a few thoughtfully chosen design alternatives whenever they would help the user explore a mockup, without waiting for the user to ask. Use compact, labeled local controls for these alternatives. Do not assume a Tweak helper or host annotation API exists. Do not add design controls to charts, explainers, or simulations unless requested.
- "In the widget" means the in-conversation visualization, not a widget inside the depicted product.
- Use product and platform context already available in the conversation; don't search the project to render a mockup. Match the product's chrome, navigation, typography, colors, and content. If its design is unavailable, infer one from the platform and request.
- NEVER use visualization CSS variables or utility classes inside a mockup (for example, `--card`, `--font-size-base`, `.card`, or `.btn`). Define root-scoped, product-specific colors, typography, surfaces, and controls instead. This rule overrides all general visualization guidance.
- Keep only the surrounding conversation surface transparent. Give product windows, cards, menus, and popovers opaque backgrounds, and stack overlays above the product content.
- Follow the host's active appearance with product-specific `light-dark(<light>, <dark>)` colors unless a fixed theme is requested.
- **Contained mockup:** Frame a component, dialog, small feature, or mobile screen as a compact product surface.
- **Full-page mockup:** Render a desktop window, application shell, or page at full width without an additional visualization card.
- Put app-wide navigation and pickers in the app chrome, and local controls in their component. Omit single-option pickers. Show realistic states, not invented dashboards, filler cards, or oversized icons.

### Interactive explainer or simulation

- Use compact controls or status, one compact dominant visual, and at most one single-line selected-state detail. Default to no summary cards; allow up to three only when changing metrics are central.
- Crop empty space and fit the available inline width. For step-throughs, add only requested step controls and update one current visual; never add parameter controls, formulas, metric cards, or side-by-side steps unless asked.

### Graphs and plots

- Use D3 for data-rich Cartesian or statistical plots and handwritten SVG for simple, directly labeled values. Keep diagrams, simulations, and maps under their existing guidance. Load the version-pinned CDN script `https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js`.
- Render the figure, legend, and subplots directly on the transparent host surface. Frame only the SVG plot area; never wrap charts in `.card`, rounded panels, filled backgrounds, or shadowed containers.
- Give the figure a concise visible title. Render each Cartesian subplot in its own responsive SVG with a matching `viewBox`, a thin frame, and visible `text.axis-title[data-axis="x"]` and `text.axis-title[data-axis="y"]` showing quantities and units.
- Set each SVG `viewBox` from its own container's measured width, redraw with `ResizeObserver`, and reserve at least 64px for the y axis. Never scale down a fixed-width `viewBox`.
- Derive padded domains with `d3.extent(...)` over all observations, uncertainty, and references. Inset scale ranges for marker radii and keep every path inside `rect[data-chart-frame]`; never draw endpoint connectors outside the frame or guess or hard-code the domain.
- After every draw, measure tick, axis, and value-label bounds together. Leave 4px between labels, anchor edge labels inward, and remove optional annotations first. At 360px, show at most four x ticks and stack panels.
- Prefer `--viz-series-1` through `--viz-series-6` for chart series; use `--foreground` and `--border` for neutrals, cycle the six series tokens when more are needed, and never use literal or fallback colors. Give every SVG label `fill: var(--foreground)` and `font-size: 12px`; never shrink labels below 11 screen pixels. Stack subplots when their labels no longer fit.
- Keep observations, trends, and important values visible. Use bands for dense uncertainty, whiskers for isolated estimates, and one compact, wrapping legend. Render one real `<button type="button" aria-pressed="true">` per series with a small swatch and neutral text; toggle its line, markers, and tooltip row together. Keep buttons transparent, borderless, and indistinguishable from inline text; never use `.btn`, pills, badges, rounded borders, or filled and selected backgrounds.
- Share one root-relative, pointer-transparent `<div class="tooltip" role="tooltip">` using `--popover` and `--popover-foreground`. In each multi-series SVG, give the full-plot overlay both `data-chart-hit` and `data-chart-hover-overlay="cross-series"`. Keep the `data-chart-hover-guide` at the exact cursor x, interpolate every visible series there, and show one aligned `data-chart-hover-marker` and tooltip row per visible series; never snap the guide to a nearby sample. Let touch users pin the same cross-series details without requiring hover.
- Find ordered observations with `d3.bisector(d => d.x).center(values, x)`; never pass an accessor to `d3.bisectCenter`.
- Give isolated marks transparent `data-chart-hit` targets at least 32 screen pixels across on fine pointers and about 44px on coarse pointers; use one nearest-point overlay for dense scatter.
- For named numeric data and one-off analyses, start with the plot. Put values and takeaways on its marks, axes, or annotations. Never add a KPI row, controls, cards, or panels unless those UI elements are explicitly requested.
- For sequences or parallel work, use aligned lanes on one time axis. Encode phase and resource in the marks; annotate totals, waits, and bottlenecks on the axis or lanes, not above the plot.
- For distributions or multi-metric comparisons, use shared-scale facets or small multiples. Render every requested dimension simultaneously; never hide one behind a toggle.

### Maps

- Let the map dominate the composition. Use at most one compact selection/detail area and only requested controls.
- Always project published GeoJSON/TopoJSON and sourced longitude/latitude with `d3-geo`; never hard-code or hand-draw geographic outlines. Use schematic maps only when asked.
- For world countries, import `https://esm.sh/@d3-maps/atlas@1.0.0/world/countries/countries-110m` and convert it with `topojson-client@3.1.0` using `feature(world, world.objects.features).features`. Join input ISO3 directly to `feature.properties.id`, which is already ISO3; do not convert it to numbers.
- For US states or counties, use `https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json/+esm`. For ZIP/ZCTA or city boundaries, download official Census or local open-data GeoJSON; do not guess sibling atlas paths or import raw JSON as JavaScript.
- Keep maps geographically legible: for local points, fetch published neighborhood, street, or comparable geometry; a blank field or lone administrative outline is not a basemap. Show the full city or region behind points or partial choropleths, and frame the locations with modest padding.
- Include the verified geometry in the final HTML. Open it before replying and fix blank basemaps, failed imports, missing labels, or unprojected points.

### Dense categorical grid

- Use one compact horizontal selected-item summary, then a grid with exactly one readable identifier per cell, then one small legend. Render only that identifier as visible cell text; put all other metadata in an accessible label or one summary line, not badges or fact grids. Allow only selection unless asked.

### Part-to-whole or time allocation

- Use compact metrics and one stacked chart of category allocation per period. Never substitute totals-only bars or duplicate it as a heatmap and totals chart.

## Layout and accessibility

- Use semantic HTML, keyboard-accessible controls, and concise labels.
- Use `aria-live="polite"` for dynamic results, selections, and simulator updates. Use `role="alert"` for validation errors. Do not announce every hover or animation frame.
- Keep the top-level surface transparent and unframed, and fill the available conversation width. Design for the conversation width (roughly 736px), and support widths down to 320px. Stack side-by-side content when it no longer fits.
- At every supported width, text, controls, cards, toolbars, and dynamic content must fit without overlap or clipping. Reflow by stacking or wrapping; use `.table-responsive` only when table columns cannot fit. The host sizes the frame to its content up to 1,200px, with scrolling above that limit. Avoid fixed outer widths, other horizontal overflow, internal scrolling, `position: fixed`, and viewport-height layouts.
- Size every SVG from its actual container. At narrow widths, reduce ticks, declutter annotations, and keep visible text at least 11 screen pixels; never shrink a fixed-width `viewBox`.
- Prefer native controls and their tab order. Use `tabindex="0"` only when a custom interactive mark needs keyboard focus, with equivalent keyboard behavior; never use positive tabindex values.
- Use native `button`, `input`, `select`, and `textarea` elements with matching utilities; never recreate controls.
- Keep browser or utility focus styles; never override them.
- On coarse pointers, provide non-overlapping effective targets about 44px by 44px without breaking 320px layouts; visible icons and marks may stay small. Keep fine-pointer controls compact, and let shared utilities own touch sizing and at least 16px editable-field text.
- Keep essential content and actions available without hover.

## Typography

- Scale type with `--font-size-base`. Use normal text by default and `.text-small` only for secondary annotations; at the default scale these are 14px and 12px. Never make supporting text smaller than 11px.
- `h1`, `h2`, and `h3` are available; use one concise visible heading for a self-contained chart or graph, with short panel headings only when needed. Do not restate the prompt or add a redundant title to other visualizations.
- Use only weights `400` and `500`. Never set custom font sizes or line heights.
- Use `.tabular-nums` on changing or aligned numbers. Avoid it for editorial or decorative numerals.

## Color

- Make every fill, stroke, text, border, shadow, chart, and canvas color theme-aware. Never hardcode light or dark palettes such as white panels, off-white backgrounds, black text, slate strokes, or Tailwind color literals.
- Keep text readable against its actual background. Muted or secondary colors must retain clear contrast; never use `.text-muted` inside `.card` or another filled container unless its background preserves that contrast.
- Available theme variables include `--background`, `--foreground`, `--card`, `--card-foreground`, `--popover`, `--popover-foreground`, `--primary`, `--primary-foreground`, `--secondary`, `--secondary-foreground`, `--muted`, `--muted-foreground`, `--accent`, `--accent-foreground`, `--destructive`, `--border`, `--input`, `--ring`, `--blue`, `--orange`, `--green`, `--red`, `--purple`, and `--yellow`. Use `currentColor` inside SVG.
- Never add decorative borders, outlines, or strokes to progress tracks, meters, bars, stacked segments, or other filled quantitative marks. Use a subtle neutral or translucent track and distinguish marks with fill, contrast, spacing, or opacity.
- Use `--viz-series-1` for one measure or active state. Use `--viz-series-2` through `--viz-series-6` only for important persistent category, series, or status identity; never give every peer a different color by default.
  - For categorical tiles or nodes, prefer a soft low-opacity series fill with a neutral or transparent border; never color every outline.
  - Keep mappings stable and pair color with labels, shapes, or line styles.
  - Secondary series colors are theme-derived; never assume hues or use them decoratively.
- When color encodes a category or series, apply it consistently to the corresponding visual marks—not just the legend—and keep large-area fills subtle.
- Use series colors only for chart lines, marks, and legend swatches. Keep values, axis text, and direct labels in `--foreground` or `--muted-foreground`.
- Keep chart grids and inactive structure thin and neutral. Use 1-2px neutral structural paths; never thicken, dash, or double-stroke the whole structure.
- In each color pair, the base token is a surface and its `-foreground` token is the content on that surface. Use `.btn-primary` for high-emphasis actions; its neutral fill is supplied by the utility. Use `--primary` and `--primary-foreground` for filled selected, active, or pressed controls. Reserve `--accent` and `--accent-foreground` for subtle interactive surfaces and soft highlights. Buttons with `aria-pressed="true"`, `aria-selected="true"`, or `.is-selected` already use the primary pairing; `.nav-pills .nav-link.active` keeps selection neutral.

## Design system

- Let utilities own geometry, appearance, and interaction. Use the matching utility for every button and form control. Never restyle utilities, descendants, or pseudo-elements: no custom sizes, spacing, borders, radii, shadows, colors, or interaction states.

### Surfaces and layout

- `.card`: The only card-like HTML surface. Use its base class unchanged for a necessary numeric summary, selected-item summary, or bounded interactive field. Before adding a fill, border, radius, or shadow to any layout container, either use `.card` or leave it transparent and unframed; never recreate card chrome on rows, panels, tiles, sections, or wrappers. Keep charts, maps, diagrams, tables, controls, and the whole visualization unframed. Never nest cards; show at most three summaries near the top only when changing metrics are central. Structural groupings and repeated content are not bounded interactive fields. Organize them with layout or visual marks, not container chrome.
- `.viz-stat`: Use a summary `.card` with one muted label, one `.viz-stat-value`, and at most one short context or delta line.
- `.viz-grid`: Use for peer metrics or choices instead of a custom grid. It creates as many equal-width columns as fit and stacks when narrow. Never use it for the whole visual or a horizontally scrolling card row. Keep groups to 2-3 columns at 736px and controls in a separate row.
- `.viz-row`: Use as a wrapping horizontal group with centered related values or inline actions that may wrap when narrow.
- `<hr>`: Use a native horizontal rule for a subtle theme-aware separator.
- `.nav.nav-pills` + `.nav-link`: Use the accessible, interactive [Tabs](#tabs) API below.
- `.progress` + `.progress-bar`: `<div class="progress" role="progressbar" aria-label="Progress" aria-valuenow="25" aria-valuemin="0" aria-valuemax="100"><div class="progress-bar" style="width:25%"></div></div>`
- `.viz-tile`: Add to a selectable dense-grid `.btn`; it stretches to fill its grid cell, preserves category fill, and uses an accent ring instead of solid selection. Never add another selected, pressed, border, outline, or shadow rule.
- `.viz-badge`: Use as a compact display-only accent pill for a short status, category, or value; never as a button.
- `.viz-controls`: Use as a wrapping row for controls affecting the same visualization. Keep button groups compact. Put labeled fields directly inside as `.form-label`; fields form at most two columns and stack when narrow.

### Tabs

- `.nav.nav-pills[role="tablist"]`: Group content-width native `.nav-link[role="tab"]` buttons and label the group with `aria-label`. Add `.nav-justified` only when tabs should share and fill the row equally.
- `.nav-link[role="tab"]`: Give each button a unique `id`, `type="button"`, `aria-controls`, and `aria-selected`. Mark the initial tab `.active` and `aria-selected="true"`; use `disabled` or `aria-disabled="true"` when needed.
- `[role="tabpanel"]`: Match `id` to its tab's `aria-controls`, set `aria-labelledby` to the tab's `id`, and mark inactive panels `hidden`. Tabs can have separate panels or point to one shared panel.
- Tab behavior is already implemented by the JavaScript runtime and does not need to be wired.

```html
<div class="nav nav-pills" role="tablist" aria-label="Platform">
  <button class="nav-link active" id="mac" role="tab" aria-controls="mac-panel" aria-selected="true" type="button">macOS</button>
  <button class="nav-link" id="linux" role="tab" aria-controls="linux-panel" aria-selected="false" type="button">Linux</button>
</div>
<div id="mac-panel" role="tabpanel" aria-labelledby="mac">macOS content</div>
<div id="linux-panel" role="tabpanel" aria-labelledby="linux" hidden>Linux content</div>
```

### Controls

- `.btn`: Use for a content-sized secondary action. Add `.btn-primary` for one main action per control group or `.btn-ghost` for low emphasis.
- `.btn-block`: Add to a `.btn` only when the action should intentionally fill the available inline space. Never use it for ordinary row actions.
- `<a>`: Use for links. Add `.btn` to style a link as a button.
- `[data-tooltip]`: Use for concise supplementary plain text on static or dynamic triggers; the sandbox handles hover, focus, and touch and creates `.tooltip` elements. Keep essential content visible and triggers labeled. Never use `title`, custom markup, or initialization. Example: `<button type="button" data-tooltip="Reset view">Reset</button>`.
- `[data-tooltip-placement]`: Optionally prefer `top` (default), `right`, `bottom`, or `left`; collision handling may flip it.
- `.form-check`: Prefer a wrapping `<label class="form-check">` around the native `.form-check-input` and `.form-check-label` text so the whole row is tappable. An explicit label with matching `for` and input `id` also works.
- `.form-switch`: Add to `.form-check` around a native checkbox.
- `.form-control`: Pair a native text, date, file, or color input—or a textarea—with `.form-label`.
- `.form-control-color`: Add to `.form-control` for a compact native color input.
- `.form-select`: Pair a native select with `.form-label`.
- `.form-range`: Pair a native range with a visible label; put its current value and units immediately before it.

### Tables

- `.table`: Use on a semantic table for a quiet, unframed data view. It provides wrapping cells and subtle horizontal dividers without vertical gridlines. Use sentence case for headers.
- `.table-responsive`: Wrap a table when its columns cannot fit at narrow widths. It contains horizontal overflow without clipping the visualization.
- `.table-sm`: Add to `.table` when more rows need to fit; it reduces cell padding without shrinking text.
- `.text-end`, `.text-center`, and `.text-nowrap`: Use inside `.table` for numeric/end alignment, centered values, or values that must stay on one line. Numeric cells use tabular figures when end-aligned.

### Text

- `.text-small`: Use for the smallest host-scaled secondary chart labels and annotations, never below 11px or for essential content.
- `.text-muted`: Use for secondary units, captions, timestamps, and context, never essential values or labels.
- `.text-destructive`: Use only for error or validation text the user needs to notice or act on.
- `<code>`: Use for inline commands, file names, symbols, or short references; put multiline code in `<pre><code>`.
- `.sr-only`: Use for visually hidden accessible text.

## Charts

- Prefer inline SVG for simple charts and version-pinned CDN libraries when native interaction, scales, legends, or layout materially improve the result.
- Resolve theme colors before passing them to canvas or chart APIs that cannot parse CSS variables or `light-dark(...)`; redraw when the theme changes.
- Use a tooltip unless it would distract from a simple, directly labeled chart. Keep chart-library tooltips and grouped legend interactions native; never replace them with a custom one-point tooltip. For SVG, attach `data-tooltip` directly to the real pointer-accessible mark and include its label, value, and units; the sandbox handles themed positioning, keyboard focus, and touch.
- Animate transitions between chart states so lines and marks move to their new values, resampling paths when point counts differ. Do not animate initial appearance or use fade-only effects; never loop motion, and honor `prefers-reduced-motion`.
- Scope SVG styles to the chart class. Never target every `svg` in a container that also contains Lucide icons.
- Include labeled axes, units, and directly labeled important values. Give every chart, SVG, canvas, and widget a concise screen-reader summary using a role and accessible name or description, SVG `<title>`/`<desc>`, fallback text, or an `.sr-only` heading or description.
- Reserve space for the longest formatted label at every supported width. Axis ticks are secondary and may use `.text-small` when space is tight. Never overlap or clip text against marks, axes, legends, labels, or edges; move or reduce labels rather than squeeze them.
- Add a legend only when multiple series cannot be labeled directly.
- Pair color with shape or text so meaning never depends on color alone.

## Icons and mockups

- Use the host-provided global `lucide`. Add an icon name with `data-lucide`:

  ```html
  <i data-lucide="search" aria-hidden="true"></i>
  ```

- Never author inline icon SVG or icon paths. Use only supplied Lucide names; the sandbox replaces each placeholder with a host-sized `currentColor` SVG. Reserve authored inline SVG for charts and data marks.
- Mark decorative icons `aria-hidden="true"`. Put action icons inside labeled controls; use a visible label or `aria-label` for icon-only actions.
- Let the sandbox initialize static icons after the fragment without blocking first render. After adding icons dynamically, use `lucide.createIcons({ attrs: { width: 16, height: 16 } })`.
- Do not load Lucide a second time; the host supplies a pinned script.
- Use visibly labeled buttons and inputs for small interactions. Keep all presentation-only interaction local to the fragment and make the first render useful before input changes.
- Use semantic controls, realistic spacing, and restrained chrome for mockups. Never fake product screenshots when inspectable UI is needed.
