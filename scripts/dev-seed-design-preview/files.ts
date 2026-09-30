/**
 * Real file bytes for the design-preview seed: PNG charts rasterized from SVG,
 * a small PDF, and plain text/code files. Everything is fake Acme Robotics
 * content. (Documents, spreadsheets and decks are written as live edits; see
 * live-edit.ts.)
 */
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// sharp is a dependency of the artifact tool, not of the repository root.
const sharp = createRequire(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../packages/artifact-tool/package.json"),
)("sharp") as (input: Buffer) => {
  png(options?: { compressionLevel?: number }): { toBuffer(): Promise<Buffer> };
};

export type SeedFile = {
  key: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
};

// ---------------------------------------------------------------------------
// Images, PDF, text
// ---------------------------------------------------------------------------

function barChartSvg(options: {
  title: string;
  subtitle: string;
  labels: string[];
  values: number[];
  threshold?: number;
  unit: string;
}): string {
  const width = 960;
  const height = 540;
  const left = 80;
  const bottom = 460;
  const top = 120;
  const max = Math.max(...options.values) * 1.15;
  const slot = (width - left - 60) / options.values.length;
  const barWidth = slot * 0.62;
  const y = (value: number) => bottom - ((bottom - top) * value) / max;
  const bars = options.values
    .map((value, index) => {
      const x = left + slot * index + (slot - barWidth) / 2;
      const hot = options.threshold !== undefined && value > options.threshold;
      return [
        `<rect x="${x.toFixed(1)}" y="${y(value).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${(bottom - y(value)).toFixed(1)}" rx="6" fill="${hot ? "#E5484D" : "#12A594"}"/>`,
        `<text x="${(x + barWidth / 2).toFixed(1)}" y="${(y(value) - 10).toFixed(1)}" text-anchor="middle" font-size="18" fill="#11181C" font-weight="600">${value}${options.unit}</text>`,
        `<text x="${(x + barWidth / 2).toFixed(1)}" y="${bottom + 30}" text-anchor="middle" font-size="18" fill="#687076">${options.labels[index]}</text>`,
      ].join("");
    })
    .join("");
  const rawStep = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((m) => m >= rawStep) ?? rawStep;
  const ticks = Array.from({ length: Math.floor(max / step) }, (_, index) => (index + 1) * step);
  const grid = ticks
    .map((tick) => {
      const value = Number(tick.toFixed(2));
      return `<line x1="${left}" x2="${width - 40}" y1="${y(value)}" y2="${y(value)}" stroke="#E6E8EB"/><text x="${left - 12}" y="${y(value) + 6}" text-anchor="end" font-size="15" fill="#889096">${value}</text>`;
    })
    .join("");
  const threshold =
    options.threshold === undefined
      ? ""
      : `<line x1="${left}" x2="${width - 40}" y1="${y(options.threshold)}" y2="${y(options.threshold)}" stroke="#F5A524" stroke-width="2" stroke-dasharray="8 6"/><text x="${left + 6}" y="${y(options.threshold) - 8}" font-size="15" fill="#AD5700">SLO ${options.threshold}${options.unit} ms</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="DejaVu Sans, Arial, sans-serif"><rect width="${width}" height="${height}" fill="#FFFFFF"/><text x="${left}" y="56" font-size="28" font-weight="700" fill="#11181C">${options.title}</text><text x="${left}" y="88" font-size="17" fill="#687076">${options.subtitle}</text>${grid}<line x1="${left}" x2="${width - 40}" y1="${bottom}" y2="${bottom}" stroke="#C1C8CD"/>${threshold}${bars}</svg>`;
}

function lineChartSvg(): string {
  const width = 960;
  const height = 540;
  const points = [0.4, 0.5, 0.3, 0.6, 11.8, 9.4, 6.1, 2.2, 0.3, 0.2, 0.1, 0.1];
  const labels = ["08:50", "", "09:00", "", "09:10", "", "09:20", "", "09:30", "", "09:40", ""];
  const left = 80;
  const bottom = 460;
  const top = 120;
  const x = (index: number) => left + ((width - left - 60) * index) / (points.length - 1);
  const y = (value: number) => bottom - ((bottom - top) * value) / 14;
  const path = points
    .map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`)
    .join(" ");
  const area = `${left},${bottom} ${path} ${x(points.length - 1)},${bottom}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="DejaVu Sans, Arial, sans-serif"><rect width="${width}" height="${height}" fill="#FFFFFF"/><text x="${left}" y="56" font-size="28" font-weight="700" fill="#11181C">INC-2291 checkout error rate</text><text x="${left}" y="88" font-size="17" fill="#687076">% of POST /checkout requests failing, 22 Sep 2026 (UTC)</text>${[
    2, 6, 10, 14,
  ]
    .map(
      (value) =>
        `<line x1="${left}" x2="${width - 40}" y1="${y(value)}" y2="${y(value)}" stroke="#E6E8EB"/><text x="${left - 12}" y="${y(value) + 6}" text-anchor="end" font-size="15" fill="#889096">${value}%</text>`,
    )
    .join(
      "",
    )}<rect x="${x(4)}" y="${top}" width="${x(9) - x(4)}" height="${bottom - top}" fill="#E5484D" opacity="0.08"/><polygon points="${area}" fill="#E5484D" opacity="0.15"/><polyline points="${path}" fill="none" stroke="#E5484D" stroke-width="4" stroke-linejoin="round"/>${labels
    .map((label, index) =>
      label
        ? `<text x="${x(index)}" y="${bottom + 30}" text-anchor="middle" font-size="16" fill="#687076">${label}</text>`
        : "",
    )
    .join(
      "",
    )}<line x1="${left}" x2="${width - 40}" y1="${bottom}" y2="${bottom}" stroke="#C1C8CD"/><text x="${x(4) + 8}" y="${top + 24}" font-size="16" fill="#CD2B31">Cache node restarted</text></svg>`;
}

async function png(svg: string): Promise<Uint8Array> {
  return new Uint8Array(await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer());
}

/** A minimal single-page PDF with real text, hand-assembled with a valid xref. */
function simplePdf(title: string, lines: string[]): Uint8Array {
  const escape = (text: string) => text.replace(/[\\()]/g, (c) => `\\${c}`);
  const content = [
    "BT",
    "/F2 20 Tf 72 740 Td",
    `(${escape(title)}) Tj`,
    "/F1 11 Tf 0 -34 Td 15 TL",
    ...lines.map((line) => `(${escape(line)}) Tj T*`),
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, "latin1"));
}

const text = (value: string) => new Uint8Array(Buffer.from(value, "utf8"));

const PG_QUEUE_TS = `import type { Sql } from "postgres";

export type Handler<T> = (job: { id: string; data: T; attempt: number }) => Promise<void>;

/**
 * A small Postgres-backed job queue. Workers claim due jobs with
 * FOR UPDATE SKIP LOCKED, so any number of replicas can poll safely.
 */
export class PgQueue<T> {
  constructor(
    private readonly sql: Sql,
    readonly name: string,
  ) {}

  async add(data: T, options: { runAt?: Date } = {}) {
    await this.sql\`
      insert into jobs (queue, payload, run_at)
      values (\${this.name}, \${this.sql.json(data)}, \${options.runAt ?? new Date()})\`;
  }

  async claim(): Promise<{ id: string; data: T; attempt: number } | null> {
    const [job] = await this.sql\`
      update jobs set locked_until = now() + interval '5 minutes', attempt = attempt + 1
      where id = (
        select id from jobs
        where queue = \${this.name} and run_at <= now() and locked_until < now()
        order by run_at for update skip locked limit 1)
      returning id, payload as data, attempt\`;
    return job ?? null;
  }

  async complete(id: string) {
    await this.sql\`delete from jobs where id = \${id}\`;
  }

  async dueCount(): Promise<number> {
    const [row] = await this.sql\`
      select count(*)::int as count from jobs
      where queue = \${this.name} and run_at <= now() and locked_until < now()\`;
    return row?.count ?? 0;
  }
}
`;

const RUNBOOK_MD = `# Runbook: warm a cache node from a replica

Use this when a cache node restarted empty and checkout latency is climbing.

## 1. Confirm the node is cold

\`\`\`bash
redis-cli -h cache-3.eu-north-1.internal info keyspace
# db0:keys=0 means the node is empty
\`\`\`

## 2. Take it out of rotation

\`\`\`bash
kubectl -n cache annotate pod cache-3 acme.dev/drain=true
\`\`\`

## 3. Warm it

\`\`\`bash
redis-cli -h cache-3.eu-north-1.internal replicaof cache-1.eu-north-1.internal 6379
# wait for master_sync_in_progress:0, then:
redis-cli -h cache-3.eu-north-1.internal replicaof no one
\`\`\`

## 4. Put it back

Remove the drain annotation and watch the checkout p95 panel for 10 minutes.

| Check | Expected |
| --- | --- |
| Keys on cache-3 | Within 5% of cache-1 |
| Checkout p95 | Under 400 ms |
| Error rate | Under 0.1% |
`;

const PRICE_SHEET_CSV = `tier,storage_tb,price_per_tb_nok,monthly_nok,change_vs_2025
Standard,0-50,1840,,-4%
Standard,50-200,1620,,-4%
Archive,0-500,410,,-2%
Egress,per TB,690,,0%
Support,Business,,12500,+9%
`;

export async function buildSeedFiles(): Promise<Record<string, SeedFile>> {
  const files: SeedFile[] = [
    {
      key: "latencyChart",
      filename: "checkout-p95-7d.png",
      contentType: "image/png",
      bytes: await png(
        barChartSvg({
          title: "POST /checkout p95 latency",
          subtitle: "Daily p95 in milliseconds, last 7 days",
          labels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
          values: [271, 279, 276, 498, 527, 512, 531],
          threshold: 400,
          unit: "",
        }),
      ),
    },
    {
      key: "errorRateChart",
      filename: "inc-2291-error-rate.png",
      contentType: "image/png",
      bytes: await png(lineChartSvg()),
    },
    {
      key: "awsChart",
      filename: "aws-spend-by-service.png",
      contentType: "image/png",
      bytes: await png(
        barChartSvg({
          title: "AWS spend by service, September",
          subtitle: "USD thousands",
          labels: ["EC2", "RDS", "S3", "Transfer", "EKS", "CDN"],
          values: [19.9, 12.0, 3.6, 3.4, 2.4, 1.7],
          unit: "k",
        }),
      ),
    },
    {
      key: "pgQueueTs",
      filename: "pg-queue.ts",
      contentType: "text/plain",
      bytes: text(PG_QUEUE_TS),
    },
    {
      key: "runbookMd",
      filename: "warm-cache-node.md",
      contentType: "text/markdown",
      bytes: text(RUNBOOK_MD),
    },
    {
      key: "contract",
      filename: "Northwind Storage renewal agreement 2027.pdf",
      contentType: "application/pdf",
      bytes: simplePdf("Northwind Storage AS - Storage Services Agreement (Renewal)", [
        'Between Northwind Storage AS ("Vendor") and Acme Robotics AS ("Customer"). Fake sample document.',
        "",
        "2.1 Term. This Agreement renews automatically for successive 24-month terms",
        "    unless either party gives written notice at least 90 days before renewal.",
        "5.3 Price changes. Vendor may adjust prices once per term by up to 9%.",
        "8.2 Liability. Vendor's aggregate liability is limited to fees paid in the",
        "    preceding 3 months.",
        "11.4 Data export. Export at termination is available for 30 days at list price.",
      ]),
    },
    {
      key: "pricing",
      filename: "nordstore-price-sheet-2027.csv",
      contentType: "text/csv",
      bytes: text(PRICE_SHEET_CSV),
    },
  ];
  return Object.fromEntries(files.map((file) => [file.key, file]));
}
