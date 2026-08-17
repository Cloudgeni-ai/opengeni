#!/usr/bin/env bun
import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import {
  bootstrapWorkspace,
  buildCodexTokenResolver,
  createDb,
  createSession,
  encryptEnvironmentValue,
  ensureCodexRotationSettings,
  setActiveCodexCredential,
  upsertCodexSubscriptionCredential,
} from "@opengeni/db";
import { createNatsEventBus } from "@opengeni/events";
import { createObservability } from "@opengeni/observability";
import { createProductionAgentRuntime } from "@opengeni/runtime";
import { ScriptedModel, startTestServices, testSettings } from "@opengeni/testing";
import { createActivityTestHarness } from "../apps/worker/src/activities";
import { runtimeMetricsHooksForObservability } from "../apps/worker/src/observability-metrics";
import { submitTestHumanPrompt } from "../test/integration/helpers/session-control";

const TURN_SAMPLES = 7;
const TOKEN_SAMPLES = 50;
const ACCOUNT_COUNTS = [1, 32] as const;
const LEASING_MODES = [false, true] as const;
const ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 91).toString("base64");

type Distribution = {
  samples: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
};

type TurnSample = {
  wallMs: number;
  workerPreparationMs: number;
  credentialSelectionMs: number;
  claimAndPolicyMs: number;
  runtimePreparationMs: number;
  historyPreparationMs: number;
  toolPreparationMs: number;
};

const services = await startTestServices({ temporal: true });
let dbClient: ReturnType<typeof createDb> | undefined;
let bus: Awaited<ReturnType<typeof createNatsEventBus>> | undefined;

try {
  await migrateQuietly();
  dbClient = createDb(services.databaseUrl);
  bus = await createNatsEventBus(services.natsUrl);

  const receipts = [];
  for (const accountCount of ACCOUNT_COUNTS) {
    for (const leasingEnabled of LEASING_MODES) {
      const suffix = crypto.randomUUID();
      const subjectId = `user:${suffix}`;
      const context = await bootstrapWorkspace(dbClient.db, {
        accountExternalSource: "bench:codex-credential-path",
        accountExternalId: `account:${suffix}`,
        accountName: "Codex credential path benchmark",
        workspaceExternalSource: "bench:codex-credential-path",
        workspaceExternalId: `workspace:${suffix}`,
        workspaceName: "Codex credential path benchmark",
        subjectId,
        subjectLabel: "Codex credential path benchmark",
      });
      const grant = context.workspaceGrants[0];
      if (!grant) throw new Error("benchmark workspace grant was not created");

      const settings = testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        temporalHost: services.temporalHost,
        sandboxBackend: "none",
        sandboxOwnershipEnabled: true,
        observabilityMetricsEnabled: true,
        codexSubscriptionEnabled: true,
        codexCredentialLeasingEnabled: leasingEnabled,
        environmentsEncryptionKey: ENCRYPTION_KEY_BASE64,
      });
      const encryptionKey = environmentsEncryptionKeyBytes(settings);
      if (!encryptionKey) throw new Error("benchmark encryption key was not parsed");

      const credentialIds: string[] = [];
      for (let index = 0; index < accountCount; index += 1) {
        const result = await upsertCodexSubscriptionCredential(dbClient.db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          credentialEncrypted: encryptEnvironmentValue(
            encryptionKey,
            JSON.stringify({
              access_token: `synthetic-access-${suffix}-${index}`,
              refresh_token: `synthetic-refresh-${suffix}-${index}`,
              id_token: `synthetic-id-${suffix}-${index}`,
            }),
          ),
          chatgptAccountId: `synthetic:${suffix}:${index}`,
          scopes: null,
          planType: "pro",
          isFedramp: false,
          expiresAt: new Date(Date.now() + 60 * 60_000),
          lastRefreshAt: new Date(),
          connectedBySubjectId: grant.subjectId,
        });
        if (result.kind !== "upserted") {
          throw new Error("synthetic Codex credential unexpectedly remained unresolved");
        }
        credentialIds.push(result.id);
      }
      await ensureCodexRotationSettings(dbClient.db, grant.accountId, grant.workspaceId);
      if (!(await setActiveCodexCredential(dbClient.db, grant.workspaceId, credentialIds[0]!))) {
        throw new Error("synthetic Codex credential was not activated");
      }

      const tokenMs: number[] = [];
      for (let index = 0; index <= TOKEN_SAMPLES; index += 1) {
        const resolver = buildCodexTokenResolver(
          dbClient.db,
          settings,
          grant.workspaceId,
          credentialIds[0]!,
        );
        const startedAt = performance.now();
        const token = await resolver.getToken();
        const elapsedMs = performance.now() - startedAt;
        if (!token.accessToken.startsWith("synthetic-access-")) {
          throw new Error("credential resolver returned the wrong synthetic token");
        }
        if (index > 0) tokenMs.push(elapsedMs);
      }

      const turnSamples: TurnSample[] = [];
      for (let index = 0; index <= TURN_SAMPLES; index += 1) {
        const session = await createSession(dbClient.db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          initialMessage: `measure Codex credential selection ${index}`,
          resources: [],
          tools: [],
          metadata: {},
          model: "codex/gpt-5.6-sol",
          sandboxBackend: "none",
        });
        await submitTestHumanPrompt(dbClient.db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          sessionId: session.id,
          subjectId: grant.subjectId,
          text: `measure Codex credential selection ${index}`,
          resources: [],
          tools: [],
          delivery: "send",
          reasoningEffortFallback: "medium",
        });

        const observability = createObservability(settings, {
          component: `codex-credential-path-${accountCount}-${leasingEnabled}-${index}`,
        });
        const runtime = createProductionAgentRuntime({
          model: new ScriptedModel([{ outputText: "ready" }]),
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
        const wallMs = performance.now() - startedAt;
        // A successful one-shot session settles back to the externally visible
        // idle state; some harness paths use the internal completed sentinel.
        if (result.status !== "idle" && result.status !== "completed") {
          throw new Error(`synthetic Codex turn did not settle successfully: ${result.status}`);
        }
        const metrics = await observability.prometheusMetrics();
        const phases = phaseSumsMs(metrics);
        const sample: TurnSample = {
          wallMs,
          workerPreparationMs: metricSumMs(
            metrics,
            "opengeni_turn_worker_preparation_duration_seconds",
          ),
          credentialSelectionMs: phases.credential_selection ?? 0,
          claimAndPolicyMs: phases.claim_and_policy ?? 0,
          runtimePreparationMs: phases.runtime_preparation ?? 0,
          historyPreparationMs: phases.history_preparation ?? 0,
          toolPreparationMs: phases.tool_preparation ?? 0,
        };
        if (index > 0) turnSamples.push(sample);
      }

      receipts.push({
        accountCount,
        leasingEnabled,
        tokenLookupAndDecryptMs: distribution(tokenMs),
        turnWallMs: distribution(turnSamples.map((sample) => sample.wallMs)),
        workerPreparationMs: distribution(turnSamples.map((sample) => sample.workerPreparationMs)),
        credentialSelectionMs: distribution(
          turnSamples.map((sample) => sample.credentialSelectionMs),
        ),
        claimAndPolicyMs: distribution(turnSamples.map((sample) => sample.claimAndPolicyMs)),
        runtimePreparationMs: distribution(
          turnSamples.map((sample) => sample.runtimePreparationMs),
        ),
        historyPreparationMs: distribution(
          turnSamples.map((sample) => sample.historyPreparationMs),
        ),
        toolPreparationMs: distribution(turnSamples.map((sample) => sample.toolPreparationMs)),
      });
    }
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        configuration: {
          accountCounts: ACCOUNT_COUNTS,
          leasingModes: LEASING_MODES,
          turnSamples: TURN_SAMPLES,
          tokenSamples: TOKEN_SAMPLES,
          modelTransport: "ScriptedModel (no provider network request)",
        },
        receipts,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await Promise.allSettled([bus?.close(), dbClient?.close()]);
  await services.down();
}

// The direct activity harness owns production-style background handles whose
// public test surface has no aggregate close method. External clients/services
// are drained above; this prevents an unrelated unref'd handle from hanging the
// benchmark after its receipt is complete.
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

function metricSumMs(metrics: string, name: string): number {
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
