// Generates the M8 before/after evidence page (the visual-approval merge gate
// artifact for Jørgen). Pairs the M0 baseline "before" (spinner-parade, default
// xterm) against the pass-5 final "after" + the M8 live cold-paint proof.
// Images are inlined as data URIs so the page is a single portable file.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = "/home/jorge/repos/Cloudgeni-ai/opengeni-workbench-wt";
const BASE = join(ROOT, ".agent/ui-evidence/baseline"); // M0 before (root .agent)
const RE = join(ROOT, "packages/react/.agent/ui-evidence"); // after (package .agent)
const OUT = join(RE, "BEFORE-AFTER.html");

const uri = (p) => `data:image/png;base64,${readFileSync(p).toString("base64")}`;
const img = (dir, name) => uri(join(dir, name));

// [before {src,cap}, after {src,cap}] pairs, grouped by surface.
const sections = [
  {
    id: "files",
    title: "Files — cold open",
    lead: "The headline. Before: opening a session with the box asleep meant a connection error and an empty tree — nothing to look at until a machine warmed. After: the file tree paints instantly from the turn-end capture, no machine call before first paint.",
    pairs: [
      [
        {
          src: img(BASE, "02-cold-connecting.png"),
          cap: "BEFORE (M0 baseline) — cold Files: “Sandbox connection unavailable / Retry”, “no repo”, empty tree, “Select a file…”. A spinner-parade until a box warmed.",
        },
        {
          src: img(RE, "m8-live/coldpaint-files.png"),
          cap: "AFTER (M8 live, box stopped) — full tree painted from the capture: master · 3 changed · .git / .config / created-by-echo.txt / data.txt. Zero Channel-A calls before paint.",
        },
      ],
      [
        {
          src: img(RE, "pass-5/cold-instant__files__dark__wide.png"),
          cap: "AFTER (pass-5 final, dark) — cold-instant Files with honest “as of turn” source + machine chip.",
        },
        {
          src: img(RE, "pass-5/cold-instant__files__light__wide.png"),
          cap: "AFTER (pass-5 final, light).",
        },
      ],
    ],
  },
  {
    id: "changes",
    title: "Changes — PR-review surface",
    lead: "A dedicated Changes tab (there was none before — diffs lived only inside the Files view). Windowed Pierre diffs + a grouped file rail, painting from the capture when cold.",
    pairs: [
      [
        {
          src: img(BASE, "04-changes-diff-app-py.png"),
          cap: "BEFORE (M0 baseline) — the only diff surface was a plain hand-rolled hunk view inside Files, live-only.",
        },
        {
          src: img(RE, "m8-live/coldpaint-changes.png"),
          cap: "AFTER (M8 live, box stopped) — Changes tab from the capture: 3 files changed +2 −5, file rail with ±counts, syntax-highlighted Pierre diffs, Unified/Split.",
        },
      ],
      [
        {
          src: img(RE, "pass-5/warm-live__changes__dark__medium.png"),
          cap: "AFTER (pass-5 final) — warm/live Changes at a dock width.",
        },
        {
          src: img(RE, "pass-5/dense__changes__dark__medium.png"),
          cap: "AFTER (pass-5 final) — dense 40-file changeset: grouped rail + windowed diff pane.",
        },
      ],
    ],
  },
  {
    id: "terminal",
    title: "Terminal",
    lead: "Default xterm (VGA palette, the “I have no name!” prompt, 80×24 flash) → a WebGL-rendered terminal themed from the same design tokens, with a boot-in-terminal state and no first-paint flash.",
    pairs: [
      [
        {
          src: img(BASE, "06b-terminal-tab.png"),
          cap: "BEFORE (M0 baseline) — stock xterm: default VGA colors, “I have no name!@…” prompt.",
        },
        {
          src: img(RE, "m6/terminal-idle-dark.png"),
          cap: "AFTER (M6 final) — og-themed ANSI palette (WebGL renderer), concrete mono font, matched dock ground.",
        },
      ],
    ],
  },
  {
    id: "states",
    title: "States — designed, not placeholder",
    lead: "Every empty / guard / offline state is deliberate copy, not a spinner. Zero spinners after first paint across the matrix (G2).",
    pairs: [
      [
        {
          src: img(RE, "pass-5/empty__changes__dark__medium.png"),
          cap: "Empty — “No changes yet” (welcoming, designed).",
        },
        {
          src: img(RE, "pass-5/guard__changes__dark__medium.png"),
          cap: "Guard — binary / over-cap files: “open it on the machine”.",
        },
      ],
      [
        {
          src: img(RE, "pass-5/selfhosted-offline__files__dark__wide.png"),
          cap: "Self-hosted offline — view-only tree, no mutation toolbar, honest “as of” labeling (read-only affordance gating).",
        },
        {
          src: img(RE, "pass-5/warm-live__files__dark__wide.png"),
          cap: "Warm/live Files — full mutation affordances.",
        },
      ],
    ],
  },
];

const card = (o) => `
  <figure class="shot">
    <img src="${o.src}" alt="" />
    <figcaption>${o.cap}</figcaption>
  </figure>`;

const sectionHtml = (s) => `
  <section id="${s.id}">
    <h2>${s.title}</h2>
    <p class="lead">${s.lead}</p>
    ${s.pairs.map((p) => `<div class="pair">${p.map(card).join("")}</div>`).join("")}
  </section>`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Workbench v2 — before / after</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; background:#0b0d10; color:#e7e9ec; font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  header.top { padding:40px 32px 24px; border-bottom:1px solid #23272e; }
  header.top h1 { margin:0 0 8px; font-size:26px; letter-spacing:-.02em; }
  header.top p { margin:0; max-width:70ch; color:#9aa2ad; }
  nav { display:flex; gap:16px; padding:14px 32px; position:sticky; top:0; background:rgba(11,13,16,.9); backdrop-filter:blur(8px); border-bottom:1px solid #23272e; font-size:13px; z-index:2; }
  nav a { color:#9aa2ad; text-decoration:none; } nav a:hover { color:#e7e9ec; }
  main { padding:8px 32px 80px; max-width:1400px; margin:0 auto; }
  section { padding:36px 0; border-bottom:1px solid #1a1e24; }
  h2 { font-size:20px; margin:0 0 6px; letter-spacing:-.01em; }
  .lead { margin:0 0 20px; max-width:80ch; color:#9aa2ad; }
  .pair { display:grid; grid-template-columns:1fr 1fr; gap:20px; margin-bottom:22px; }
  @media (max-width:860px){ .pair{ grid-template-columns:1fr; } }
  figure.shot { margin:0; }
  figure.shot img { width:100%; height:auto; display:block; border:1px solid #23272e; border-radius:8px; background:#000; }
  figcaption { margin-top:8px; font-size:12.5px; color:#8a929d; }
  .badge { display:inline-block; font-size:11px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; padding:2px 8px; border-radius:999px; margin-left:8px; vertical-align:middle; }
  .verdict { background:#0f1417; border:1px solid #23303a; border-radius:10px; padding:20px 22px; margin:26px 0 4px; }
  .verdict h3 { margin:0 0 12px; font-size:15px; }
  .verdict table { border-collapse:collapse; width:100%; font-size:13.5px; }
  .verdict td { padding:6px 10px; border-top:1px solid #1a2229; vertical-align:top; }
  .verdict td:first-child { color:#e7e9ec; white-space:nowrap; font-weight:600; width:230px; }
  .verdict td:last-child { color:#9aa2ad; }
  .pass { color:#4ade80; } .warn { color:#fbbf24; }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px; color:#c9d1d9; background:#151a1f; padding:1px 5px; border-radius:4px; }
</style></head><body>
<header class="top">
  <h1>Workbench v2 — before / after</h1>
  <p>Instant, capture-backed, embeddable workbench dock. Left = the M0 baseline (spinner-parade cold open, stock xterm). Right = the shipped surfaces (5 UI passes) + M8 live cold-paint proof against a real stopped box. This is the visual-approval merge gate.</p>
</header>
<nav>${sections.map((s) => `<a href="#${s.id}">${s.title.split(" — ")[0]}</a>`).join("")}<a href="#live">Live proof</a></nav>
<main>
  ${sections.map(sectionHtml).join("")}
  <section id="live">
    <h2>M8 live verification — real stack, real box</h2>
    <p class="lead">Brought up the full docker-sandbox stack (postgres/nats/temporal/minio + api + worker), drove a real gpt-5.5 turn, and verified the deferred live-only checks against real capture data.</p>
    <div class="verdict">
      <h3>Live check results</h3>
      <table>
        <tr><td>Cold-paint (headline)</td><td><span class="pass">PASS</span> — isolated embedder, box removed: capture GET @300ms, tree/Changes painted @559ms, <code>channelACallsBeforePaint: []</code>. apps/web (box stopped) rendered the full Changes+Files tree from the capture (screenshots above).</td></tr>
        <tr><td>D1 pre-paint default tab</td><td><span class="pass">PASS</span> (with embedder contract) — events preloaded at mount (apps/web-style) → default <b>Changes</b>, no post-paint switch. Async-arriving events → default Files (documented: an embedder must pass the event log at mount).</td></tr>
        <tr><td>C2 wake-on-edit conflict</td><td><span class="pass">PASS</span> — live on a real warm box: base read “hello”, out-of-band mutation to “AGENT CHANGED THIS”, guard re-read detected divergence, <b>no silent overwrite</b>, explicit force overrode. Client state transition covered by the C2 hook test.</td></tr>
        <tr><td>Offline read-only</td><td><span class="warn">PARTIAL</span> — affordance gating unit + demo-fixture verified (self-hosted-offline state, above). A genuine self-hosted offline machine (<code>FileSystem.readOnly=true</code>) is the one documented human-verify fallback; a cold cloud box is warmable-by-design.</td></tr>
      </table>
    </div>
  </section>
</main></body></html>`;

writeFileSync(OUT, html);
console.log(`wrote ${OUT} (${(html.length / 1024 / 1024).toFixed(2)} MB)`);
