#!/usr/bin/env bun

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createObservability } from "@opengeni/observability";
import { createProductionAgentRuntime } from "@opengeni/runtime";
import { functionCall, ScriptedModel, startTestServices, testSettings } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  createDb,
  createRig,
  createSession,
  createVariableSet,
  listSessionEvents,
} from "@opengeni/db";
import { createNatsEventBus } from "@opengeni/events";
import { createActivityTestHarness } from "../apps/worker/src/activities";
import { runtimeMetricsHooksForObservability } from "../apps/worker/src/observability-metrics";
import { submitTestHumanPrompt } from "../test/integration/helpers/session-control";

// Keep the machine-readable receipt on stdout; production observability logs
// remain visible on stderr while the real activity path runs.
console.log = (...values: unknown[]) => console.error(...values);

const image = "opengeni-sandbox:local";
const setupChars = 131_072;
const variableSetCount = 25;
const providerDelayMs = 20;
const services = await startTestServices({ temporal: true });
const workspaceBaseDir = await mkdtemp(join(tmpdir(), "opengeni-huge-rig-turn-"));
const containersBefore = await dockerContainerIds(image);
let dbClient: ReturnType<typeof createDb> | undefined;
let bus: Awaited<ReturnType<typeof createNatsEventBus>> | undefined;

try {
  await migrateQuietly();
  dbClient = createDb(services.databaseUrl);
  bus = await createNatsEventBus(services.natsUrl);
  const identity = await bootstrapWorkspace(dbClient.db, {
    accountExternalSource: "bench:huge-rig-turn",
    accountExternalId: crypto.randomUUID(),
    accountName: "Huge rig turn benchmark",
    workspaceExternalSource: "bench:huge-rig-turn",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Huge rig turn benchmark",
    subjectId: `bench:huge-rig-turn:${crypto.randomUUID()}`,
    subjectLabel: "Huge rig turn benchmark",
  });
  const grant = identity.workspaceGrants[0]!;
  const variableSets = [];
  for (let index = 0; index < variableSetCount; index += 1) {
    variableSets.push(
      await createVariableSet(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        name: `rig-default-${String(index).padStart(2, "0")}`,
      }),
    );
  }
  const setupPrefix = "set -eu\nprintf ready > /workspace/rig-ready\n#";
  const setupScript = `${setupPrefix}${"界".repeat(setupChars - setupPrefix.length)}`;
  const rig = await createRig(dbClient.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    name: "maximum-runtime-rig",
    createdBy: `user:${grant.subjectId}`,
    initialVersion: {
      image,
      setupScript,
      checks: [],
      credentialHooks: [],
      defaultVariableSetIds: variableSets.map((set) => set.id),
      changelog: "Maximum runtime benchmark",
      createdBy: `user:${grant.subjectId}`,
    },
  });
  if (!rig.activeVersion) throw new Error("benchmark rig has no active version");
  const session = await createSession(dbClient.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "exercise complete huge rig",
    resources: [],
    tools: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "docker",
    rigId: rig.id,
    rigVersionId: rig.activeVersion.id,
  });

  const settings = testSettings({
    databaseUrl: services.databaseUrl,
    natsUrl: services.natsUrl,
    temporalHost: services.temporalHost,
    openaiModel: "scripted-model",
    sandboxBackend: "docker",
    dockerImage: image,
    dockerWorkspaceBaseDir: workspaceBaseDir,
    sandboxOwnershipEnabled: true,
    sandboxLazyProvisionEnabled: true,
    sandboxIdleGraceMs: 1,
    observabilityMetricsEnabled: true,
  });
  const observability = createObservability(settings, { component: "huge-rig-turn-benchmark" });
  const model = new ScriptedModel([
    {
      output: [
        functionCall(
          "exec_command",
          {
            cmd: 'test -f /workspace/rig-ready && test "$ORDER" = 24 && printf first-ok',
          },
          "huge-rig-first",
        ),
      ],
    },
    { outputText: "first-complete" },
    {
      output: [
        functionCall(
          "exec_command",
          {
            cmd: 'test -f /workspace/rig-ready && test "$ORDER" = 24 && printf warm-ok',
          },
          "huge-rig-warm",
        ),
      ],
    },
    { outputText: "warm-complete" },
  ]);
  const runtime = createProductionAgentRuntime({
    model,
    metrics: runtimeMetricsHooksForObservability(observability),
  });
  let activeSecretReads = 0;
  let peakSecretReads = 0;
  let secretReads = 0;
  const activities = createActivityTestHarness({
    settings,
    db: dbClient.db,
    bus,
    observability,
    runtime,
    connectionCredentials: {
      sandboxSecrets: async ({ workspaceId, variableSetId }) => {
        activeSecretReads += 1;
        peakSecretReads = Math.max(peakSecretReads, activeSecretReads);
        secretReads += 1;
        try {
          await Bun.sleep(providerDelayMs);
          const index = variableSets.findIndex((set) => set.id === variableSetId);
          if (index < 0) throw new Error(`unknown benchmark variable set ${variableSetId}`);
          return {
            workspaceId,
            id: variableSetId,
            values: { [`SET_${String(index).padStart(2, "0")}`]: "present", ORDER: String(index) },
          };
        } finally {
          activeSecretReads -= 1;
        }
      },
    },
  });

  const turns = [];
  for (const label of ["cold", "warm"] as const) {
    const existingEvents = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, {
      direction: "before",
      before: Number.MAX_SAFE_INTEGER,
      limit: 1,
      payloadMode: "none",
    });
    const afterSequence = existingEvents.at(-1)?.sequence ?? 0;
    await submitTestHumanPrompt(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      subjectId: grant.subjectId,
      text: `${label} huge rig turn`,
      resources: [],
      tools: [],
      delivery: "send",
      reasoningEffortFallback: "medium",
    });
    const readsBefore = secretReads;
    const metricsBefore = phaseSumsMs(await observability.prometheusMetrics());
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
    const metricsAfter = phaseSumsMs(await observability.prometheusMetrics());
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, {
      after: afterSequence,
      limit: 500,
      payloadMode: "full",
    });
    const eventOrigin = Date.parse(events[0]?.occurredAt ?? "");
    turns.push({
      label,
      wallMs: performance.now() - startedAt,
      status: result.status,
      secretReads: secretReads - readsBefore,
      phasesMs: metricDelta(metricsBefore, metricsAfter),
      eventTimeline: events
        .filter((event) =>
          /^(?:rig\.setup|sandbox\.operation|agent\.toolCall|model\.request|turn\.)/u.test(
            event.type,
          ),
        )
        .map((event) => ({
          sequence: event.sequence,
          type: event.type,
          elapsedMs:
            Number.isFinite(eventOrigin) && Number.isFinite(Date.parse(event.occurredAt))
              ? Date.parse(event.occurredAt) - eventOrigin
              : null,
          name:
            event.payload && typeof event.payload === "object" && "name" in event.payload
              ? String((event.payload as { name: unknown }).name)
              : null,
        })),
    });
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        modelCalls: 0,
        provider: "scripted",
        image,
        setupChars: setupScript.length,
        setupBytes: Buffer.byteLength(setupScript),
        variableSetCount,
        providerDelayMs,
        peakSecretReads,
        exactEnvironmentProof: "ORDER=24 and the setup marker are asserted inside both tool calls",
        turns,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await Promise.allSettled([bus?.close(), dbClient?.close()]);
  await services.down();
  const containersAfter = await dockerContainerIds(image);
  const created = [...containersAfter].filter((id) => !containersBefore.has(id));
  for (const id of created) await removeDockerContainer(id);
  await rm(workspaceBaseDir, { recursive: true, force: true });
}

// The direct activity harness intentionally owns background handles whose
// aggregate public test surface has no close method. External services, DB,
// NATS, exact benchmark containers, and files are drained above.
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

function phaseSumsMs(metrics: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const line of metrics.split("\n")) {
    if (!line.startsWith("opengeni_turn_startup_phase_duration_seconds_sum{")) continue;
    const phase = /(?:^|,)phase="([^"]+)"/u.exec(line)?.[1];
    const value = Number(line.slice(line.lastIndexOf(" ") + 1));
    if (phase && Number.isFinite(value)) result[phase] = (result[phase] ?? 0) + value * 1_000;
  }
  return result;
}

function metricDelta(
  before: Record<string, number>,
  after: Record<string, number>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(after)
      .map(([phase, value]) => [phase, value - (before[phase] ?? 0)] as const)
      .filter(([, value]) => value > 0.001)
      .sort((left, right) => right[1] - left[1]),
  );
}

async function dockerContainerIds(imageName: string): Promise<Set<string>> {
  const process = Bun.spawn(["docker", "ps", "-aq", "--filter", `ancestor=${imageName}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`docker ps failed: ${stderr.trim()}`);
  return new Set(stdout.split("\n").filter(Boolean));
}

async function removeDockerContainer(id: string): Promise<void> {
  const process = Bun.spawn(["docker", "rm", "-f", id], { stdout: "ignore", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`docker rm ${id} failed: ${stderr.trim()}`);
}
