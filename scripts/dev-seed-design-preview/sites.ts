/**
 * Static, self-contained Site HTML for the design preview. Content is plain
 * markup with inline CSS and SVG so the library thumbnail (no scripts) and the
 * full viewer render the same page.
 */

const BASE_CSS = `
:root{--bg:#f7f8fa;--card:#fff;--ink:#11181c;--muted:#687076;--line:#e6e8eb;--accent:#12a594;--warn:#f5a524;--bad:#e5484d}
@media (prefers-color-scheme:dark){:root{--bg:#111416;--card:#191d20;--ink:#ecedee;--muted:#9ba1a6;--line:#2b3034}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1080px;margin:0 auto;padding:28px 24px 40px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:15px;margin:0 0 12px}p.lede{color:var(--muted);margin:0 0 22px}
.grid{display:grid;gap:14px}.kpis{grid-template-columns:repeat(auto-fit,minmax(170px,1fr));margin-bottom:14px}
.two{grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.kpi .label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.kpi .value{font-size:26px;font-weight:650;margin-top:4px}.kpi .delta{font-size:12px;color:var(--muted)}
.up{color:var(--accent)!important}.down{color:var(--bad)!important}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line)}
th{color:var(--muted);font-weight:600;font-size:12px}td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600}
.pill.bad{background:#e5484d22;color:var(--bad)}.pill.warn{background:#f5a52422;color:#ad5700}.pill.ok{background:#12a59422;color:var(--accent)}
.bar{height:8px;border-radius:4px;background:var(--line);overflow:hidden}.bar>i{display:block;height:100%;background:var(--accent)}
footer{color:var(--muted);font-size:12px;margin-top:20px}
`;

const page = (title: string, body: string, marker: string) =>
  `<!doctype html><html lang="en" data-seed="${marker}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${BASE_CSS}</style></head><body><main>${body}</main></body></html>`;

function uptimeChart(): string {
  const sites = [
    ["Oslo", 99.94],
    ["Trondheim", 99.71],
    ["Gdańsk", 98.92],
    ["Tallinn", 99.88],
  ] as const;
  const rows = sites
    .map(([name, value], index) => {
      const y = 18 + index * 42;
      const width = Math.round(((value - 98) / 2) * 300);
      const color = value < 99.5 ? "#e5484d" : "#12a594";
      return `<text x="0" y="${y + 14}" font-size="13" fill="currentColor">${name}</text><rect x="92" y="${y}" width="300" height="20" rx="5" fill="#8881"/><rect x="92" y="${y}" width="${width}" height="20" rx="5" fill="${color}"/><text x="400" y="${y + 15}" font-size="13" fill="currentColor">${value}%</text>`;
    })
    .join("");
  return `<svg viewBox="0 0 460 190" width="100%" role="img" aria-label="Uptime per site">${rows}</svg>`;
}

function firmwareDonut(): string {
  const parts = [
    ["4.2.1", 61, "#12a594"],
    ["4.2.0", 24, "#0091ff"],
    ["4.1.x", 11, "#f5a524"],
    ["older", 4, "#e5484d"],
  ] as const;
  let offset = 25;
  const circles = parts
    .map(([, value, color]) => {
      const circle = `<circle r="15.915" cx="21" cy="21" fill="none" stroke="${color}" stroke-width="6" stroke-dasharray="${value} ${100 - value}" stroke-dashoffset="${offset}"/>`;
      offset -= value;
      return circle;
    })
    .join("");
  const legend = parts
    .map(
      ([name, value, color], index) =>
        `<g transform="translate(56 ${8 + index * 9})"><rect width="5" height="5" rx="1" fill="${color}"/><text x="8" y="5" font-size="5" fill="currentColor">${name} · ${value}%</text></g>`,
    )
    .join("");
  return `<svg viewBox="0 0 110 44" width="100%" role="img" aria-label="Firmware versions">${circles}<text x="21" y="23" text-anchor="middle" font-size="6" font-weight="700" fill="currentColor">412</text><text x="21" y="29" text-anchor="middle" font-size="3.4" fill="currentColor">robots</text>${legend}</svg>`;
}

export const FLEET_SITE_HTML = page(
  "Fleet health",
  `<h1>Fleet health</h1><p class="lede">Acme Robotics · 412 robots across 4 sites · sample data</p>
<section class="grid kpis">
<div class="card kpi"><div class="label">Fleet uptime (7d)</div><div class="value">99.61%</div><div class="delta up">+0.12 pts vs last week</div></div>
<div class="card kpi"><div class="label">Robots online</div><div class="value">405 / 412</div><div class="delta">7 in maintenance</div></div>
<div class="card kpi"><div class="label">Cycles today</div><div class="value">182,440</div><div class="delta up">+4.8%</div></div>
<div class="card kpi"><div class="label">Need attention</div><div class="value down">5</div><div class="delta">2 urgent</div></div>
</section>
<section class="grid two">
<div class="card"><h2>Uptime per site</h2>${uptimeChart()}</div>
<div class="card"><h2>Firmware versions</h2>${firmwareDonut()}</div>
</section>
<section class="card" style="margin-top:14px"><h2>Robots that need attention</h2>
<table><thead><tr><th>Robot</th><th>Site</th><th>Issue</th><th class="num">Since</th><th>Severity</th></tr></thead><tbody>
<tr><td>ARM-2231</td><td>Gdańsk</td><td>Stops mid-cycle after firmware 4.2.0</td><td class="num">6 h</td><td><span class="pill bad">Urgent</span></td></tr>
<tr><td>ARM-1904</td><td>Gdańsk</td><td>Gripper pressure drifting</td><td class="num">1 d</td><td><span class="pill bad">Urgent</span></td></tr>
<tr><td>AGV-0418</td><td>Trondheim</td><td>Battery health 71%</td><td class="num">3 d</td><td><span class="pill warn">Soon</span></td></tr>
<tr><td>ARM-0077</td><td>Oslo</td><td>Firmware 4.0.9 (two releases behind)</td><td class="num">12 d</td><td><span class="pill warn">Soon</span></td></tr>
<tr><td>AGV-0931</td><td>Tallinn</td><td>Lidar recalibration due</td><td class="num">2 d</td><td><span class="pill ok">Planned</span></td></tr>
</tbody></table></section>
<footer>Generated by OpenGeni · refreshes when republished</footer>`,
  "fleet-v1",
);

export const COST_REVIEW_HTML = page(
  "Q3 cost review",
  `<h1>Q3 cost review</h1><p class="lede">Cloud spend by team, July to September 2026 · USD</p>
<section class="grid kpis">
<div class="card kpi"><div class="label">Q3 total</div><div class="value">$126.6k</div><div class="delta down">+11% vs Q2</div></div>
<div class="card kpi"><div class="label">September</div><div class="value">$44.2k</div><div class="delta down">+4.5% vs August</div></div>
<div class="card kpi"><div class="label">Tagged spend</div><div class="value">96%</div><div class="delta up">up from 71%</div></div>
<div class="card kpi"><div class="label">Savings found</div><div class="value up">$4.6k/mo</div><div class="delta">3 changes</div></div>
</section>
<section class="card"><h2>By team</h2><table><thead><tr><th>Team</th><th>Share</th><th class="num">Jul</th><th class="num">Aug</th><th class="num">Sep</th></tr></thead><tbody>
<tr><td>Platform</td><td><div class="bar"><i style="width:41%"></i></div></td><td class="num">15.9k</td><td class="num">16.4k</td><td class="num">17.8k</td></tr>
<tr><td>Data</td><td><div class="bar"><i style="width:23%"></i></div></td><td class="num">8.6k</td><td class="num">9.4k</td><td class="num">10.4k</td></tr>
<tr><td>Fleet telemetry</td><td><div class="bar"><i style="width:19%"></i></div></td><td class="num">7.4k</td><td class="num">7.9k</td><td class="num">8.3k</td></tr>
<tr><td>Web</td><td><div class="bar"><i style="width:12%"></i></div></td><td class="num">4.6k</td><td class="num">5.0k</td><td class="num">5.3k</td></tr>
<tr><td>Other</td><td><div class="bar"><i style="width:5%"></i></div></td><td class="num">2.0k</td><td class="num">2.1k</td><td class="num">2.4k</td></tr>
</tbody></table></section>
<section class="card" style="margin-top:14px"><h2>Biggest savings</h2><table><thead><tr><th>Change</th><th class="num">Monthly</th><th>Status</th></tr></thead><tbody>
<tr><td>Compute Savings Plan for the baseline EC2 fleet</td><td class="num">$2,600</td><td><span class="pill warn">Needs approval</span></td></tr>
<tr><td>Drop the inactive CDC slot, shrink db-2</td><td class="num">$1,100</td><td><span class="pill ok">In progress</span></td></tr>
<tr><td>S3 Intelligent-Tiering for the telemetry archive</td><td class="num">$900</td><td><span class="pill ok">Planned</span></td></tr>
</tbody></table></section>`,
  "cost-v3",
);

export const ONCALL_HTML = page(
  "On-call handbook",
  `<h1>On-call handbook</h1><p class="lede">Platform rotation · updated after INC-2291</p>
<section class="grid two">
<div class="card"><h2>When the pager goes off</h2><ol><li>Acknowledge within 5 minutes.</li><li>Open an incident channel if customers are affected.</li><li>Check the deploy dashboard: roll back first, debug second.</li><li>Post an update every 30 minutes until resolved.</li></ol></div>
<div class="card"><h2>Escalation</h2><table><tbody><tr><th>Level 1</th><td>Primary on-call</td></tr><tr><th>Level 2</th><td>Secondary on-call (after 15 min)</td></tr><tr><th>Level 3</th><td>Maria Chen, platform lead</td></tr><tr><th>Payments</th><td>#payments-oncall</td></tr></tbody></table></div>
</section>
<section class="card" style="margin-top:14px"><h2>Runbooks</h2><table><thead><tr><th>Situation</th><th>Runbook</th><th class="num">Last used</th></tr></thead><tbody>
<tr><td>Checkout errors above 2%</td><td>Warm a cache node from a replica</td><td class="num">7 days ago</td></tr>
<tr><td>Deploy lock stuck</td><td>Release with <code>deployctl unlock</code></td><td class="num">12 days ago</td></tr>
<tr><td>Database disk above 85%</td><td>Check replication slots, then grow the volume</td><td class="num">today</td></tr>
<tr><td>Webhook delays</td><td>Restart the consumer, check the dead-letter queue</td><td class="num">5 days ago</td></tr>
</tbody></table></section>`,
  "oncall-v2",
);
