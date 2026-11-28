// Fixtures for the artifact previews harness. Sites written the way agents
// write them (pages drawn by script into an empty body, styled inline or with
// the Opengeni look, and one that draws nothing), and the pictures core draws
// for a document, a spreadsheet and a presentation.
import {
  documentPreviewSvg,
  presentationPreviewSvg,
  spreadsheetPreviewSvg,
} from "../../core/src/domain/editable-artifacts/preview-picture";

const deployments = `<!doctype html><html><head><meta charset="utf-8"><title>Deployments</title>
<link rel="stylesheet" href="/__opengeni/ui.css"></head>
<body class="og-app"><main class="og-page" id="app"></main>
<script>
const rows = [
  ["api", "v2026.11.27-3", "production", "Succeeded", "4 min"],
  ["web", "v2026.11.27-3", "production", "Succeeded", "6 min"],
  ["worker", "v2026.11.27-2", "production", "Rolling back", "2 min"],
  ["site-gateway", "v2026.11.26-9", "staging", "Succeeded", "3 min"],
  ["browserd", "v2026.11.26-7", "staging", "Failed", "1 min"],
];
const tone = (s) => s === "Succeeded" ? "og-badge-success" : s === "Failed" ? "og-badge-danger" : "og-badge-warning";
document.getElementById("app").innerHTML =
  '<h1 class="og-title">Deployments</h1><p class="og-muted">Last 24 hours across environments.</p>' +
  '<div class="og-grid" style="grid-template-columns:repeat(3,1fr);gap:12px;margin:16px 0">' +
  [["Deploys today", "23"], ["Success rate", "91%"], ["Median duration", "4m 12s"]]
    .map(([k, v]) => '<div class="og-card"><div class="og-muted">' + k + '</div><div style="font-size:28px;font-weight:650">' + v + '</div></div>').join("") +
  '</div><table class="og-table"><thead><tr><th>Service</th><th>Version</th><th>Environment</th><th>Status</th><th>Duration</th></tr></thead><tbody>' +
  rows.map((r) => '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td><td>' + r[2] + '</td><td><span class="og-badge ' + tone(r[3]) + '">' + r[3] + '</span></td><td>' + r[4] + '</td></tr>').join("") +
  '</tbody></table>';
</script></body></html>`;

const benchmarks = `<!doctype html><html><head><meta charset="utf-8"><title>Benchmark results</title>
<style>
body{margin:0;background:#0f1115;color:#e8eaed;font:15px/1.5 Inter,system-ui,sans-serif}
main{padding:40px 48px}h1{font-size:30px;margin:0 0 6px}p{color:#9aa0a6;margin:0 0 28px}
.bars{display:grid;gap:14px}.bar{display:grid;grid-template-columns:220px 1fr 70px;align-items:center;gap:16px}
.track{height:22px;background:#1d2128;border-radius:6px;overflow:hidden}.fill{height:100%;border-radius:6px}
</style></head><body><main id="root"></main>
<script>
const data = [["Opengeni (Opus 5.5)", 78.4, "#8ab4f8"], ["Opengeni (GPT-6)", 74.1, "#81c995"], ["Baseline agent A", 61.0, "#5f6368"], ["Baseline agent B", 55.7, "#5f6368"], ["Baseline agent C", 49.3, "#5f6368"]];
const root = document.getElementById("root");
root.innerHTML = "<h1>Opengeni benchmark results</h1><p>Terminal-Bench 2.0 · pass@1 · 89 tasks</p><div class=bars>" +
  data.map(([name, score, color]) => "<div class=bar><span>" + name + "</span><div class=track><div class=fill style='width:" + score + "%;background:" + color + "'></div></div><b>" + score.toFixed(1) + "%</b></div>").join("") + "</div>";
</script></body></html>`;

const ideas = `<!doctype html><html><head><meta charset="utf-8"><title>Opengeni ideas</title>
<style>
body{margin:0;background:#f6f7f9;font:14px/1.45 system-ui,sans-serif;color:#1f2328}
header{padding:28px 32px 8px}h1{margin:0;font-size:26px}.board{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;padding:16px 32px}
.col{background:#eceef2;border-radius:12px;padding:12px}.col h2{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#57606a;margin:4px 4px 10px}
.card{background:#fff;border-radius:10px;padding:10px 12px;margin-bottom:10px;box-shadow:0 1px 2px rgba(0,0,0,.08)}.votes{color:#6e7781;font-size:12px;margin-top:6px}
</style></head><body><div id="app"></div>
<script>
const columns = { Proposed: ["Voice notes in chat", "Slack thread summaries", "Offline mode on iOS"], Exploring: ["Shared prompt library", "Usage alerts"], Building: ["Artifact previews", "Faster cold starts"], Shipped: ["Projects in the sidebar", "Meeting notes"] };
document.getElementById("app").innerHTML = "<header><h1>Opengeni ideas</h1></header><div class=board>" +
  Object.entries(columns).map(([name, cards]) => "<section class=col><h2>" + name + "</h2>" + cards.map((c, i) => "<div class=card>" + c + "<div class=votes>▲ " + (24 - i * 7) + " votes</div></div>").join("") + "</section>").join("") + "</div>";
</script></body></html>`;

// Waits for data it can't get in a preview and draws nothing meanwhile.
const draft = `<!doctype html><html><body><div id="app"></div>
<script>fetch("/api/report").then((r) => r.json()).then((d) => { app.textContent = d.title; });</script>
</body></html>`;

export const PREVIEW_SITES: Record<string, string> = { deployments, benchmarks, ideas, draft };

const emu = (pixels: number) => pixels * 9_525;
const solid = (color: number) => ({ kind: "solid", color });
const none = { kind: "none" };
const noLine = { fill: none, width: 0, dash: "solid" };
const style = (size: number, color: number, bold = false) => ({
  fontSizeCentipoints: size * 100,
  color,
  bold,
  italic: false,
});
const textBox = (
  id: string,
  [x, y, width, height]: number[],
  text: string,
  size: number,
  color: number,
  bold = false,
  fill: unknown = none,
  geometry = "text-box",
) => ({
  id,
  source: { kind: "slide", id: "s1" },
  inherited: false,
  parentId: null,
  order: 0,
  name: id,
  bounds: { x: emu(x!), y: emu(y!), width: emu(width!), height: emu(height!) },
  transform: { rotation: 0, flipHorizontal: false, flipVertical: false },
  content: {
    kind: "shape",
    geometry,
    fill,
    line: noLine,
    text: {
      verticalAlignment: "top",
      paragraphs: text.split("\n").map((line) => ({
        alignment: "left",
        runs: [{ text: line, style: style(size, color, bold) }],
      })),
    },
  },
});

export const PREVIEW_PICTURES: Record<string, string> = {
  plan: documentPreviewSvg(
    { items: [{ kind: "summary", page: {} }] } as never,
    {
      items: [
        {
          kind: "paragraph",
          runs: [{ text: "Q3 launch plan", style: {} }],
          style: { headingLevel: 1 },
        },
        {
          kind: "paragraph",
          runs: [
            {
              text: "We ship the new onboarding in three phases, each gated on activation and support load. This plan lists the milestones, owners and risks.",
              style: {},
            },
          ],
          style: {},
        },
        {
          kind: "paragraph",
          runs: [{ text: "Milestones", style: {} }],
          style: { headingLevel: 2 },
        },
        ...[
          "Private beta with 20 design partners",
          "Public beta and pricing page",
          "General availability",
        ].map((text) => ({
          kind: "paragraph",
          runs: [{ text, style: {} }],
          style: { list: { kind: "number", level: 0 } },
        })),
        {
          kind: "table",
          rows: [
            ["Phase", "Owner", "Date"],
            ["Private beta", "Maya", "Jul 14"],
            ["Public beta", "Jon", "Aug 18"],
            ["GA", "Ana", "Sep 29"],
          ].map((row) => row.map((text) => [{ text, style: {} }])),
          style: { headerRows: 1 },
        },
        { kind: "paragraph", runs: [{ text: "Risks", style: {} }], style: { headingLevel: 2 } },
        {
          kind: "paragraph",
          runs: [
            {
              text: "Support volume during the public beta may exceed the current rota.",
              style: {},
            },
          ],
          style: {},
        },
      ],
    } as never,
  ),
  forecast: spreadsheetPreviewSvg(null, {
    startRow: 0,
    startColumn: 0,
    rowCount: 14,
    columnCount: 6,
    defaultRowHeight: 22,
    defaultColumnWidth: 92,
    rowHeights: [],
    columnWidths: [[0, 130]],
    cells: [
      ["Region", "Q1", "Q2", "Q3", "Q4", "Total"],
      ["Nordics", 412000, 448500, 471200, 502900],
      ["DACH", 298400, 310200, 344800, 361000],
      ["UK & Ireland", 255100, 262300, 270900, 301400],
      ["Benelux", 141700, 150900, 166300, 172800],
      ["France", 120400, 133000, 139900, 151200],
      ["Iberia", 88200, 91600, 97400, 104100],
    ].flatMap((row, r) =>
      [...row, ...(r > 0 ? [(row.slice(1) as number[]).reduce((a, b) => a + b, 0)] : [])].map(
        (value, c) => ({
          row: r,
          column: c,
          formula: null,
          value: typeof value === "number" ? { kind: "number", value } : { kind: "text", value },
        }),
      ),
    ),
  } as never),
  review: presentationPreviewSvg({ width: emu(1280), height: emu(720) }, {
    slide: { background: solid(0x0e1b33ff), layout: null },
    nodes: [
      textBox("t", [80, 90, 900, 110], "Quarterly review", 54, 0xffffffff, true),
      textBox("s", [80, 210, 900, 60], "Q3 2026 · Growth, product and operations", 24, 0x9fb3d9ff),
      textBox(
        "k1",
        [80, 380, 330, 180],
        "+38%\nnet revenue",
        32,
        0xffffffff,
        true,
        solid(0x1f3a66ff),
        "rounded-rectangle",
      ),
      textBox(
        "k2",
        [470, 380, 330, 180],
        "12,400\nactive teams",
        32,
        0xffffffff,
        true,
        solid(0x1f3a66ff),
        "rounded-rectangle",
      ),
      textBox(
        "k3",
        [860, 380, 330, 180],
        "99.97%\nuptime",
        32,
        0xffffffff,
        true,
        solid(0x1f3a66ff),
        "rounded-rectangle",
      ),
    ],
  } as never),
};
