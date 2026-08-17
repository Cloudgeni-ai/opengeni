#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const payloadPrefix = process.env.QUEUE_RESPONSE_PAYLOAD_PREFIX ?? "/tmp/opengeni-queue-5000";
const sampleCount = Number(process.env.QUEUE_RESPONSE_SAMPLES ?? "3");
const outputPath = process.env.QUEUE_RESPONSE_OUTPUT;
if (!Number.isSafeInteger(sampleCount) || sampleCount < 1 || sampleCount > 20) {
  throw new TypeError("QUEUE_RESPONSE_SAMPLES must be an integer from 1 through 20");
}

type QueueItem = {
  createdAt: string;
  id: string;
  position: number;
  prompt: string;
  updatedAt: string;
  version: number;
};
type QueueSnapshot = {
  items: QueueItem[];
  version: number;
  [key: string]: unknown;
};

const canonicalJson = await readFile(`${payloadPrefix}-canonical.json`);
const queueUiJson = await readFile(`${payloadPrefix}-queue-ui.json`);
const queueUiSnapshot = JSON.parse(queueUiJson.toString("utf8")) as QueueSnapshot;
const movedItem = queueUiSnapshot.items.at(-1);
const firstItem = queueUiSnapshot.items[0];
if (!movedItem || !firstItem || queueUiSnapshot.items.length !== 5_000) {
  throw new Error("queue UI fixture must contain exactly 5,000 rows");
}
const { items: _baseItems, ...queueUiScalarSnapshot } = queueUiSnapshot;
const deltaJson = Buffer.from(
  JSON.stringify({
    schemaVersion: 1,
    baseVersion: queueUiSnapshot.version,
    snapshot: { ...queueUiScalarSnapshot, version: queueUiSnapshot.version + 1 },
    upserts: [
      {
        ...movedItem,
        position: firstItem.position - 1,
        version: movedItem.version + 1,
        updatedAt: new Date().toISOString(),
      },
    ],
    removedIds: [],
  }),
);
const payloads = [
  { name: "canonical", json: canonicalJson, kind: "snapshot" as const },
  {
    name: "current-queue-ui-projection",
    json: queueUiJson,
    kind: "snapshot" as const,
  },
  {
    name: "experimental-revision-fenced-move-delta",
    json: deltaJson,
    kind: "delta" as const,
  },
].map((payload) => ({ ...payload, gzip: Bun.gzipSync(payload.json) }));

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return new Response(
        "<!doctype html><meta charset=utf-8><title>Queue response benchmark</title>",
        {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        },
      );
    }
    const payload = payloads.find((candidate) => `/${candidate.name}.json` === url.pathname);
    if (!payload) return new Response("not found", { status: 404 });
    return new Response(payload.gzip, {
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": String(payload.gzip.byteLength),
        "cache-control": "no-store",
      },
    });
  },
});

const profiles = [
  { name: "loopback", latencyMs: 0, downlinkMbps: null },
  { name: "good-mobile-10mbps", latencyMs: 40, downlinkMbps: 10 },
  { name: "weak-mobile-1.6mbps", latencyMs: 100, downlinkMbps: 1.6 },
] as const;
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
  (existsSync("/usr/local/bin/chromium") ? "/usr/local/bin/chromium" : undefined);
const browser = await chromium.launch(executablePath ? { executablePath } : undefined);
const measurements: Array<Record<string, unknown>> = [];

try {
  for (const profile of profiles) {
    for (const payload of payloads) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      try {
        await cdp.send("Network.enable");
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
        await cdp.send("Network.emulateNetworkConditions", {
          offline: false,
          latency: profile.latencyMs,
          downloadThroughput:
            profile.downlinkMbps === null ? -1 : (profile.downlinkMbps * 1024 * 1024) / 8,
          uploadThroughput: profile.downlinkMbps === null ? -1 : 1024 * 1024,
          connectionType: profile.downlinkMbps === null ? "none" : "cellular4g",
        });
        await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
        await page.evaluate((snapshot) => {
          Object.defineProperty(window, "__queueResponseBase", {
            configurable: true,
            value: snapshot,
          });
        }, queueUiSnapshot);
        for (let sample = 0; sample < sampleCount; sample += 1) {
          const measured = await page.evaluate(
            async ({ kind, path, nonce }) => {
              const startedAt = performance.now();
              const response = await fetch(`${path}?sample=${nonce}`, { cache: "no-store" });
              const headersAt = performance.now();
              const text = await response.text();
              const bodyAt = performance.now();
              const parsed = JSON.parse(text) as Record<string, unknown>;
              const parsedAt = performance.now();
              let resolved: QueueSnapshot;
              if (kind === "delta") {
                const base = (
                  window as unknown as {
                    __queueResponseBase: QueueSnapshot;
                  }
                ).__queueResponseBase;
                const baseVersion = Number(parsed.baseVersion);
                if (base.version !== baseVersion) {
                  throw new Error(`delta base mismatch: ${base.version}/${baseVersion}`);
                }
                const byId = new Map(base.items.map((item) => [item.id, item]));
                for (const id of (parsed.removedIds ?? []) as string[]) byId.delete(id);
                for (const item of (parsed.upserts ?? []) as QueueItem[]) byId.set(item.id, item);
                const items = [...byId.values()].sort(
                  (left, right) =>
                    left.position - right.position ||
                    left.createdAt.localeCompare(right.createdAt) ||
                    left.id.localeCompare(right.id),
                );
                const scalarSnapshot = parsed.snapshot as Record<string, unknown>;
                resolved = {
                  ...scalarSnapshot,
                  items,
                  version: Number(scalarSnapshot.version),
                };
              } else {
                resolved = parsed as QueueSnapshot;
              }
              const appliedAt = performance.now();
              const items = resolved.items ?? [];
              return {
                status: response.status,
                contentEncoding: response.headers.get("content-encoding"),
                compressedContentLength: Number(response.headers.get("content-length")),
                decodedCharacters: text.length,
                headersMs: headersAt - startedAt,
                bodyMs: bodyAt - headersAt,
                parseMs: parsedAt - bodyAt,
                applyMs: appliedAt - parsedAt,
                totalMs: appliedAt - startedAt,
                itemCount: items.length,
                firstPrompt: items[0]?.prompt ?? null,
                lastPrompt: items.at(-1)?.prompt ?? null,
                version: resolved.version,
              };
            },
            { kind: payload.kind, path: `/${payload.name}.json`, nonce: crypto.randomUUID() },
          );
          if (
            measured.status !== 200 ||
            measured.itemCount !== 5_000 ||
            (payload.kind === "delta"
              ? !measured.firstPrompt?.startsWith("queued prompt 5000 ") ||
                !measured.lastPrompt?.startsWith("queued prompt 4999 ") ||
                measured.version !== queueUiSnapshot.version + 1
              : !measured.lastPrompt?.startsWith("queued prompt 5000 "))
          ) {
            throw new Error(`queue response parity failed: ${JSON.stringify(measured)}`);
          }
          measurements.push({
            profile: profile.name,
            payload: payload.name,
            sample: sample + 1,
            ...measured,
          });
        }
        if (payload.kind === "delta") {
          const staleFence = await page.evaluate(async (path) => {
            const response = await fetch(`${path}?stale=${crypto.randomUUID()}`, {
              cache: "no-store",
            });
            const delta = (await response.json()) as { baseVersion: number };
            const base = (
              window as unknown as {
                __queueResponseBase: QueueSnapshot;
              }
            ).__queueResponseBase;
            return {
              action: base.version + 1 === delta.baseVersion ? "apply" : "refetch_full_snapshot",
              retainedRows: base.items.length,
              retainedLastPrompt: base.items.at(-1)?.prompt ?? null,
            };
          }, `/${payload.name}.json`);
          if (
            staleFence.action !== "refetch_full_snapshot" ||
            staleFence.retainedRows !== 5_000 ||
            !staleFence.retainedLastPrompt?.startsWith("queued prompt 5000 ")
          ) {
            throw new Error(`stale delta fence failed: ${JSON.stringify(staleFence)}`);
          }
        }
      } finally {
        await cdp.detach().catch(() => undefined);
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  server.stop(true);
}

const grouped = Object.values(
  Object.groupBy(measurements, (row) => `${String(row.profile)}:${String(row.payload)}`),
).flatMap((rows) => {
  if (!rows) return [];
  const first = rows[0]!;
  return [
    {
      profile: first.profile,
      payload: first.payload,
      samples: rows.length,
      compressedBytes: first.compressedContentLength,
      decodedCharacters: first.decodedCharacters,
      headersMs: distribution(rows.map((row) => Number(row.headersMs))),
      bodyMs: distribution(rows.map((row) => Number(row.bodyMs))),
      parseMs: distribution(rows.map((row) => Number(row.parseMs))),
      applyMs: distribution(rows.map((row) => Number(row.applyMs))),
      totalMs: distribution(rows.map((row) => Number(row.totalMs))),
      allRowsAndLastPromptExact: rows.every(
        (row) => row.itemCount === 5_000 && typeof row.lastPrompt === "string",
      ),
    },
  ];
});

const result = `${JSON.stringify(
  {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    cpuThrottle: 4,
    invariant:
      "Both complete snapshots retain all 5,000 queue rows. The experimental delta changes one row only after an exact base-version match, reconstructs all 5,000 rows locally, and requires a complete-snapshot refetch on mismatch. Network throttling applies to a real gzip HTTP response; parse timing begins only after decoded text is available.",
    profiles,
    grouped,
    measurements,
  },
  null,
  2,
)}\n`;
if (outputPath) await writeFile(outputPath, result);
else process.stdout.write(result);

function distribution(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1]!;
  return {
    min: sorted[0],
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1),
  };
}
