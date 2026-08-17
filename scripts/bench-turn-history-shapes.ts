#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { MODEL_ATTACHMENT_REFS_FIELD, type FileAsset } from "@opengeni/contracts";
import { bootstrapWorkspace, createDb, createSession, withWorkspaceRls } from "@opengeni/db";
import * as schema from "@opengeni/db/schema";
import { createNatsEventBus } from "@opengeni/events";
import { createObservability } from "@opengeni/observability";
import { createProductionAgentRuntime } from "@opengeni/runtime";
import { ScriptedModel, startTestServices, testSettings } from "@opengeni/testing";
import postgres from "postgres";
import { createActivityTestHarness } from "../apps/worker/src/activities";
import { modelAttachmentContentForFiles } from "../apps/worker/src/activities/run-input";
import { runtimeMetricsHooksForObservability } from "../apps/worker/src/observability-metrics";
import { submitTestHumanPrompt } from "../test/integration/helpers/session-control";

const SAMPLES = 3;
const HISTORY_CASES = [
  { name: "messages-small", rows: 1_000, bodyBytes: 768, shape: "message" },
  { name: "messages-large", rows: 1_000, bodyBytes: 8_192, shape: "message" },
  { name: "tool-pairs-large", rows: 1_000, bodyBytes: 8_192, shape: "tool-pair" },
  { name: "attachment-refs-authorized", rows: 1_000, bodyBytes: 128, shape: "attachment" },
  { name: "attachment-refs-missing", rows: 1_000, bodyBytes: 128, shape: "missing-attachment" },
] as const;

const services = await startTestServices({ temporal: true });
let dbClient: ReturnType<typeof createDb> | undefined;
let bus: Awaited<ReturnType<typeof createNatsEventBus>> | undefined;

try {
  await migrateQuietly();
  dbClient = createDb(services.databaseUrl);
  bus = await createNatsEventBus(services.natsUrl);
  const suffix = crypto.randomUUID();
  const context = await bootstrapWorkspace(dbClient.db, {
    accountExternalSource: "bench:turn-history-shapes",
    accountExternalId: `account:${suffix}`,
    accountName: "Turn history shape benchmark",
    workspaceExternalSource: "bench:turn-history-shapes",
    workspaceExternalId: `workspace:${suffix}`,
    workspaceName: "Turn history shape benchmark",
    subjectId: `user:${suffix}`,
    subjectLabel: "Turn history shape benchmark",
  });
  const grant = context.workspaceGrants[0];
  if (!grant) throw new Error("benchmark workspace grant was not created");

  const historyReceipts = [];
  for (const benchmarkCase of HISTORY_CASES) {
    const samples: Array<{
      wallMs: number;
      workerPreparationMs: number;
      phasesMs: Record<string, number>;
      resultStatus: string;
      modelInputCount: number;
      seededHistoryObserved: boolean;
    }> = [];
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      const session = await createSession(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        initialMessage: `measure ${benchmarkCase.name} sample ${sample}`,
        resources: [],
        tools: [],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "none",
      });
      const attachmentIds =
        benchmarkCase.shape === "attachment" || benchmarkCase.shape === "missing-attachment"
          ? Array.from({ length: benchmarkCase.rows }, () => crypto.randomUUID())
          : [];
      if (benchmarkCase.shape === "attachment") {
        await seedFiles(dbClient.db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          fileIds: attachmentIds,
        });
      }
      await seedHistoryRows(services.databaseUrl, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        count: benchmarkCase.rows,
        bodyBytes: benchmarkCase.bodyBytes,
        shape: benchmarkCase.shape,
        attachmentIds,
      });
      await submitTestHumanPrompt(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        subjectId: grant.subjectId,
        text: `measure ${benchmarkCase.name} sample ${sample}`,
        resources: [],
        tools: [],
        delivery: "send",
        reasoningEffortFallback: "medium",
      });

      const settings = testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        temporalHost: services.temporalHost,
        sandboxBackend: "none",
        sandboxOwnershipEnabled: true,
        observabilityMetricsEnabled: true,
      });
      const observability = createObservability(settings, {
        component: `turn-history-shape-${benchmarkCase.name}-${sample}`,
      });
      const model = new ScriptedModel([{ outputText: "ready" }]);
      const runtime = createProductionAgentRuntime({
        model,
        metrics: runtimeMetricsHooksForObservability(observability),
      });
      const activities = createActivityTestHarness({
        settings,
        db: dbClient.db,
        bus,
        observability,
        runtime,
      });
      const startedAt = performance.now();
      const result = await activities.runAgentTurn({
        attemptId: crypto.randomUUID(),
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        trigger: { kind: "next" },
        workflowId: `bench-session-${session.id}`,
        workflowRunId: crypto.randomUUID(),
      });
      const metrics = await observability.prometheusMetrics();
      const modelInput = model.requests[0]?.input as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(modelInput)) throw new Error("model request did not contain array input");
      const expectedModelInputCount = benchmarkCase.rows + 1;
      const seededHistoryObserved =
        modelInput.length === expectedModelInputCount &&
        modelInputPreservesSeededHistory(modelInput, benchmarkCase);
      if (!seededHistoryObserved) {
        throw new Error(
          `model input did not preserve ${benchmarkCase.rows} seeded rows for ${benchmarkCase.name}`,
        );
      }
      samples.push({
        wallMs: performance.now() - startedAt,
        workerPreparationMs: requiredMetricSumMs(
          metrics,
          "opengeni_turn_worker_preparation_duration_seconds",
        ),
        phasesMs: phaseSumsMs(metrics),
        resultStatus: result.status,
        modelInputCount: modelInput.length,
        seededHistoryObserved,
      });
    }
    const phaseNames = [...new Set(samples.flatMap((sample) => Object.keys(sample.phasesMs)))];
    historyReceipts.push({
      ...benchmarkCase,
      samples: SAMPLES,
      allTurnsSettled: samples.every(
        (sample) => sample.resultStatus === "idle" || sample.resultStatus === "completed",
      ),
      modelInputCounts: samples.map((sample) => sample.modelInputCount),
      allSeededHistoryObserved: samples.every((sample) => sample.seededHistoryObserved),
      wallMs: distribution(samples.map((sample) => sample.wallMs)),
      workerPreparationMs: distribution(samples.map((sample) => sample.workerPreparationMs)),
      phasesMs: Object.fromEntries(
        phaseNames
          .map((phase) => [
            phase,
            distribution(samples.map((sample) => sample.phasesMs[phase] ?? 0)),
          ])
          .sort((left, right) => (right[1] as Distribution).p50 - (left[1] as Distribution).p50),
      ),
    });
  }

  const inlineAttachmentReceipts = [];
  for (const attachmentCase of [
    { name: "one-small-local", count: 1, bytes: 4_096, readDelayMs: 0 },
    { name: "eight-small-20ms", count: 8, bytes: 4_096, readDelayMs: 20 },
    { name: "thirty-two-small-20ms", count: 32, bytes: 4_096, readDelayMs: 20 },
    { name: "one-twenty-eight-small-20ms", count: 128, bytes: 4_096, readDelayMs: 20 },
    { name: "four-large-local", count: 4, bytes: 4 * 1024 * 1024, readDelayMs: 0 },
    { name: "six-large-over-inline-limit", count: 6, bytes: 4 * 1024 * 1024, readDelayMs: 0 },
  ]) {
    const bytes = new Uint8Array(attachmentCase.bytes).fill(97);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const files = Array.from({ length: attachmentCase.count }, (_, index) =>
      syntheticFile(crypto.randomUUID(), index, bytes.byteLength, checksum),
    );
    const elapsed: number[] = [];
    const outputCounts: number[] = [];
    const readCounts: number[] = [];
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      let reads = 0;
      const startedAt = performance.now();
      const projected = await modelAttachmentContentForFiles(files, async () => {
        reads += 1;
        await sleep(attachmentCase.readDelayMs);
        return bytes;
      });
      elapsed.push(performance.now() - startedAt);
      outputCounts.push(projected.length);
      readCounts.push(reads);
    }
    inlineAttachmentReceipts.push({
      ...attachmentCase,
      samples: SAMPLES,
      elapsedMs: distribution(elapsed),
      outputCounts,
      readCounts,
      expectedIncluded: Math.min(
        attachmentCase.count,
        Math.floor((20 * 1024 * 1024) / attachmentCase.bytes),
      ),
    });
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        modelTransport: "ScriptedModel (no provider network request)",
        invariants: {
          modelInputCountAndFirstLastSeedMarkersAsserted: true,
          inlineAttachmentLimitBytes: 20 * 1024 * 1024,
          nonInlinedFilesRemainAvailableBySandboxPath: true,
        },
        historyReceipts,
        inlineAttachmentReceipts,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await Promise.allSettled([bus?.close(), dbClient?.close()]);
  await services.down();
}

process.exit(0);

async function migrateQuietly(): Promise<void> {
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => undefined;
  console.warn = () => undefined;
  try {
    await services.migrate();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

async function seedFiles(
  db: ReturnType<typeof createDb>["db"],
  input: { accountId: string; workspaceId: string; fileIds: readonly string[] },
): Promise<void> {
  for (let offset = 0; offset < input.fileIds.length; offset += 100) {
    const ids = input.fileIds.slice(offset, offset + 100);
    await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
      await scopedDb.insert(schema.files).values(
        ids.map((id, index) => ({
          id,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          status: "ready" as const,
          filename: `attachment-${offset + index}.bin`,
          safeFilename: `attachment-${offset + index}.bin`,
          contentType: "application/octet-stream",
          sizeBytes: 1,
          sha256: null,
          bucket: "benchmark",
          objectKey: `benchmark/${id}`,
        })),
      );
    });
  }
}

async function seedHistoryRows(
  databaseUrl: string,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    count: number;
    bodyBytes: number;
    shape: (typeof HISTORY_CASES)[number]["shape"];
    attachmentIds: readonly string[];
  },
): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const body = "h".repeat(input.bodyBytes);
    for (let offset = 0; offset < input.count; offset += 500) {
      const length = Math.min(500, input.count - offset);
      const values = Array.from({ length }, (_, index) => {
        const position = offset + index;
        return {
          id: crypto.randomUUID(),
          account_id: input.accountId,
          workspace_id: input.workspaceId,
          session_id: input.sessionId,
          position,
          item: JSON.stringify(
            historyItem(input.shape, position, body, input.attachmentIds[position]),
          ),
        };
      });
      await sql`
        insert into session_history_items
          (id, account_id, workspace_id, session_id, position, item, active)
        select
          source.id::uuid,
          source.account_id::uuid,
          source.workspace_id::uuid,
          source.session_id::uuid,
          source.position::numeric,
          source.item::jsonb,
          true
        from jsonb_to_recordset(${sql.json(values)}::jsonb) as source(
          id text,
          account_id text,
          workspace_id text,
          session_id text,
          position integer,
          item text
        )
      `;
    }
  } finally {
    await sql.close();
  }
}

function historyItem(
  shape: (typeof HISTORY_CASES)[number]["shape"],
  position: number,
  body: string,
  attachmentId: string | undefined,
): Record<string, unknown> {
  if (shape === "tool-pair") {
    const callId = `call-${Math.floor(position / 2)}`;
    return position % 2 === 0
      ? { type: "function_call", callId, name: "benchmark_tool", arguments: "{}" }
      : {
          type: "function_call_result",
          callId,
          output: { type: "text", text: `${position}:${body}` },
        };
  }
  if (shape === "attachment" || shape === "missing-attachment") {
    if (!attachmentId) throw new Error(`attachment id missing at position ${position}`);
    return {
      type: "message",
      role: "user",
      content: `${position}:${body}`,
      [MODEL_ATTACHMENT_REFS_FIELD]: [{ kind: "file", fileId: attachmentId }],
    };
  }
  const user = position % 2 === 0;
  return {
    type: "message",
    role: user ? "user" : "assistant",
    status: "completed",
    content: [
      {
        type: user ? "input_text" : "output_text",
        text: `${position}:${body}`,
      },
    ],
  };
}

function modelInputPreservesSeededHistory(
  modelInput: Array<Record<string, unknown>>,
  benchmarkCase: (typeof HISTORY_CASES)[number],
): boolean {
  if (benchmarkCase.shape === "tool-pair") {
    const finalCallId = `call-${benchmarkCase.rows / 2 - 1}`;
    return (
      modelInput.some((item) => item.type === "function_call" && item.callId === "call-0") &&
      modelInput.some((item) => item.type === "function_call_result" && item.callId === finalCallId)
    );
  }
  const serialized = modelInput.map((item) => JSON.stringify(item));
  return (
    serialized.some((item) => item.includes("0:")) &&
    serialized.some((item) => item.includes(`${benchmarkCase.rows - 1}:`))
  );
}

function syntheticFile(id: string, index: number, sizeBytes: number, sha256: string): FileAsset {
  return {
    id,
    workspaceId: "00000000-0000-4000-8000-000000000001",
    status: "ready",
    filename: `file-${index}.txt`,
    safeFilename: `file-${index}.txt`,
    contentType: "text/plain",
    sizeBytes,
    sha256,
    bucket: "benchmark",
    objectKey: `benchmark/${id}`,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  };
}

function requiredMetricSumMs(metrics: string, name: string): number {
  const line = metrics.split("\n").find((candidate) => candidate.startsWith(`${name}_sum`));
  if (!line) throw new Error(`missing metric: ${name}_sum`);
  const value = Number(line.slice(line.lastIndexOf(" ") + 1));
  if (!Number.isFinite(value)) throw new Error(`invalid metric: ${name}_sum`);
  return value * 1_000;
}

function phaseSumsMs(metrics: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const line of metrics.split("\n")) {
    if (!line.startsWith("opengeni_turn_startup_phase_duration_seconds_sum{")) continue;
    const phase = /(?:^|,)phase="([^"]+)"/u.exec(line)?.[1];
    const value = Number(line.slice(line.lastIndexOf(" ") + 1));
    if (!phase || !Number.isFinite(value)) continue;
    result[phase] = (result[phase] ?? 0) + value * 1_000;
  }
  return result;
}

type Distribution = {
  samples: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
};

function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) throw new Error("cannot summarize an empty distribution");
  const ordered = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number) =>
    ordered[Math.min(ordered.length - 1, Math.ceil(fraction * ordered.length) - 1)]!;
  return {
    samples: ordered.length,
    min: ordered[0]!,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: ordered.at(-1)!,
  };
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
