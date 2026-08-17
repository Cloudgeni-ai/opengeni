#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  ACTIVE_SESSION_HISTORY_MAX_JSON_BYTES,
  ACTIVE_SESSION_HISTORY_MAX_JSON_NODES,
  ACTIVE_SESSION_HISTORY_MAX_JSON_PROPERTIES,
  ACTIVE_SESSION_HISTORY_MAX_ROWS,
  ActiveSessionHistoryLimitExceededError,
  bootstrapWorkspace,
  createDb,
  createSession,
  getActiveSessionHistoryItemsPaged,
  withWorkspaceRls,
} from "@opengeni/db";
import * as schema from "@opengeni/db/schema";
import { startTestServices } from "@opengeni/testing";

const counts = integerListArgument("--counts", [0, 10, 100, 1_000, 8_192, 10_000]);
const pageSizes = integerListArgument("--page-sizes", [16, 32, 64, 100]);
const samplesPerCase = integerArgument("--samples", 3);
const payloadBytes = integerArgument("--payload-bytes", 512);
const outputPath = resolve(
  stringArgument("--output") ??
    `${process.env.OPENGENI_EVIDENCE_DIR ?? "/tmp"}/turn-history-read-benchmark.json`,
);

if (counts.some((value) => value < 0 || value > 10_000)) {
  throw new Error("--counts entries must be between 0 and 10000");
}
if (pageSizes.some((value) => value < 1 || value > 100)) {
  throw new Error("--page-sizes entries must be between 1 and 100");
}
if (samplesPerCase < 1 || samplesPerCase > 20) {
  throw new Error("--samples must be between 1 and 20");
}
if (payloadBytes < 1 || payloadBytes > 32 * 1024) {
  throw new Error("--payload-bytes must be between 1 and 32768");
}

const services = await startTestServices({ temporal: false });
let client: ReturnType<typeof createDb> | null = null;

try {
  await services.migrate();
  client = createDb(services.databaseUrl);
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "benchmark",
    accountExternalId: `turn-history-account-${suffix}`,
    accountName: "Turn history benchmark",
    workspaceExternalSource: "benchmark",
    workspaceExternalId: `turn-history-workspace-${suffix}`,
    workspaceName: "Turn history benchmark",
    subjectId: `turn-history-subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0];
  if (!grant?.workspaceId) throw new Error("Turn history benchmark bootstrap failed");

  const seeded = new Map<number, string>();
  for (const count of counts) {
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: `History benchmark ${count}`,
      resources: [],
      tools: [],
      metadata: { benchmarkHistoryRows: count },
      model: "scripted-model",
      sandboxBackend: "none",
    });
    seeded.set(count, session.id);
    const text = deterministicText(payloadBytes);
    for (let offset = 0; offset < count; offset += 100) {
      const length = Math.min(100, count - offset);
      await withWorkspaceRls(client.db, grant.workspaceId, async (db) => {
        await db.insert(schema.sessionHistoryItems).values(
          Array.from({ length }, (_, index) => {
            const position = offset + index;
            const role = position % 2 === 0 ? "user" : "assistant";
            return {
              accountId: grant.accountId,
              workspaceId: grant.workspaceId,
              sessionId: session.id,
              position,
              item: {
                type: "message",
                role,
                status: "completed",
                content: [
                  {
                    type: role === "user" ? "input_text" : "output_text",
                    text: `${position}:${text}`,
                  },
                ],
              },
            };
          }),
        );
      });
    }
  }

  const cases: BenchmarkCase[] = [];
  for (const count of counts) {
    const sessionId = seeded.get(count)!;
    let productionLimitRejection: LimitRejection | null = null;
    if (count > ACTIVE_SESSION_HISTORY_MAX_ROWS) {
      try {
        await getActiveSessionHistoryItemsPaged(client.db, grant.workspaceId, sessionId, 16);
        throw new Error(`Production limits unexpectedly admitted ${count} rows`);
      } catch (error) {
        if (!(error instanceof ActiveSessionHistoryLimitExceededError)) throw error;
        productionLimitRejection = {
          limitKind: error.limitKind,
          actual: error.actual,
          maximum: error.maximum,
        };
      }
    }

    const measurements = new Map(
      pageSizes.map((pageSize) => [
        pageSize,
        {
          elapsedMs: [] as number[],
          rssDeltaBytes: [] as number[],
          peakRssDeltaBytes: [] as number[],
        },
      ]),
    );
    for (let sample = 0; sample < samplesPerCase; sample += 1) {
      // Rotate which page size runs first so one candidate does not receive all
      // cold-driver/heap samples while another receives only warmed samples.
      const offset = sample % pageSizes.length;
      const sampleOrder = [...pageSizes.slice(offset), ...pageSizes.slice(0, offset)];
      for (const pageSize of sampleOrder) {
        const measurement = measurements.get(pageSize)!;
        if (globalThis.Bun?.gc) Bun.gc(true);
        const rssBefore = process.memoryUsage().rss;
        let peakRss = rssBefore;
        const peakSampler = setInterval(() => {
          peakRss = Math.max(peakRss, process.memoryUsage().rss);
        }, 1);
        const startedAt = performance.now();
        let rows: Awaited<ReturnType<typeof getActiveSessionHistoryItemsPaged>>;
        try {
          rows = await getActiveSessionHistoryItemsPaged(
            client.db,
            grant.workspaceId,
            sessionId,
            pageSize,
            Math.max(ACTIVE_SESSION_HISTORY_MAX_JSON_BYTES, 32 * 1024 * 1024),
            Math.max(ACTIVE_SESSION_HISTORY_MAX_ROWS, count),
            Math.max(ACTIVE_SESSION_HISTORY_MAX_JSON_NODES, count * 16),
            Math.max(ACTIVE_SESSION_HISTORY_MAX_JSON_PROPERTIES, count * 12),
          );
        } finally {
          clearInterval(peakSampler);
          peakRss = Math.max(peakRss, process.memoryUsage().rss);
        }
        measurement.elapsedMs.push(performance.now() - startedAt);
        measurement.rssDeltaBytes.push(Math.max(0, process.memoryUsage().rss - rssBefore));
        measurement.peakRssDeltaBytes.push(Math.max(0, peakRss - rssBefore));
        if (rows.length !== count) {
          throw new Error(`History read returned ${rows.length} rows; expected ${count}`);
        }
        for (let index = 0; index < rows.length; index += 1) {
          if (rows[index]?.position !== index) {
            throw new Error(`History read changed order at index ${index}`);
          }
        }
      }
    }
    for (const pageSize of pageSizes) {
      const measurement = measurements.get(pageSize)!;
      cases.push({
        rows: count,
        pageSize,
        pageQueries: Math.floor(count / pageSize) + 1,
        totalQueries: Math.floor(count / pageSize) + 4,
        elapsedMs: distribution(measurement.elapsedMs),
        rssDeltaBytes: distribution(measurement.rssDeltaBytes),
        peakRssDeltaBytes: distribution(measurement.peakRssDeltaBytes),
        productionLimitRejection,
      });
    }
  }

  const receipt = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
    invariants: {
      completeAdmittedRowSetReturned: true,
      exactPositionOrderChecked: true,
      uiTimelineChanged: false,
      modelCalled: false,
    },
    productionLimits: {
      jsonBytes: ACTIVE_SESSION_HISTORY_MAX_JSON_BYTES,
      rows: ACTIVE_SESSION_HISTORY_MAX_ROWS,
      jsonNodes: ACTIVE_SESSION_HISTORY_MAX_JSON_NODES,
      jsonProperties: ACTIVE_SESSION_HISTORY_MAX_JSON_PROPERTIES,
    },
    config: { counts, pageSizes, samplesPerCase, payloadBytes },
    cases,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ outputPath, cases })}\n`);
} finally {
  await client?.close().catch(() => undefined);
  await services.down();
}

type LimitRejection = { limitKind: string; actual: number; maximum: number };
type Distribution = {
  samples: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
};
type BenchmarkCase = {
  rows: number;
  pageSize: number;
  pageQueries: number;
  totalQueries: number;
  elapsedMs: Distribution;
  rssDeltaBytes: Distribution;
  peakRssDeltaBytes: Distribution;
  productionLimitRejection: LimitRejection | null;
};

function deterministicText(bytes: number): string {
  return "history-0123456789abcdef".repeat(Math.ceil(bytes / 24)).slice(0, bytes);
}

function distribution(values: number[]): Distribution {
  const ordered = [...values].sort((left, right) => left - right);
  const percentile = (value: number) =>
    ordered[Math.min(ordered.length - 1, Math.ceil(value * ordered.length) - 1)]!;
  return {
    samples: ordered.length,
    min: ordered[0]!,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: ordered.at(-1)!,
  };
}

function integerListArgument(name: string, fallback: number[]): number[] {
  const raw = stringArgument(name);
  if (!raw) return fallback;
  const values = raw.split(",").map((value) => Number(value));
  if (values.some((value) => !Number.isSafeInteger(value))) {
    throw new Error(`${name} must be a comma-separated integer list`);
  }
  return values;
}

function integerArgument(name: string, fallback: number): number {
  const raw = stringArgument(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function stringArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
