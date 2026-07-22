import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { dbSearchPath, getSettings, type Settings } from "@opengeni/config";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  countActiveSessionHistoryItems,
  countSessionHistoryItems,
  createDb,
  createSession,
  deleteWorkspace,
  enqueueSessionTurn,
  isSessionCompactionRequested,
  requestSessionCompaction,
  ACTIVE_SESSION_HISTORY_MAX_JSON_BYTES,
  ACTIVE_SESSION_HISTORY_MAX_JSON_NODES,
  ACTIVE_SESSION_HISTORY_MAX_JSON_PROPERTIES,
  ACTIVE_SESSION_HISTORY_MAX_ROWS,
  withWorkspaceRls,
} from "@opengeni/db";
import * as schema from "@opengeni/db/schema";
import { createProductionAgentRuntime } from "@opengeni/runtime";
import { MemoryEventBus, ScriptedModel, type ScriptedModelStep } from "@opengeni/testing";
import { createTurnActivities } from "../../apps/worker/src/activities";

const MIB = 1024 * 1024;
const MAX_HISTORY_BYTES_PER_TURN = ACTIVE_SESSION_HISTORY_MAX_JSON_BYTES;
const MAX_HISTORY_ROW_PAYLOAD_BYTES = 16 * 1024;
const MIN_HISTORY_ROW_PAYLOAD_BYTES = 512;
const MAX_HISTORY_ROWS_PER_TURN = 131_072;
const HISTORY_ROW_OVERHEAD_BYTES = 200;
const MAX_SYNTHETIC_WORK_BYTES_PER_TURN = 2 * MIB;
const MAX_WAVES = 10;
const MAX_PLATEAU_SECONDS = 300;
const MAX_SAMPLE_COUNT = 100;
const MAX_SETTLE_DELAY_MS = 60_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
const MAX_SYNTHETIC_ITEMS = 1_024;
const MAX_SYNTHETIC_WAIT_MS = 60_000;
const MAX_SEED_MANIFEST_BYTES = 64 * 1024;
const DENSITY_SEED_MANIFEST_ENV = "OPENGENI_DENSITY_SEED_MANIFEST";
const DENSITY_SEED_REAP_TIMEOUT_MS = 5_000;

export const DEFAULT_DENSITIES = [1, 2, 4, 8, 12, 16, 24, 32] as const;
export const DEFAULT_HISTORY_ROW_PAYLOAD_BYTES = 4 * 1024;
export const DEFAULT_ACTIVE_HISTORY_BYTES = 1 * MIB;
export const DEFAULT_INACTIVE_HISTORY_BYTES = 8 * MIB;
export const DEFAULT_COMPACTION_TAIL_BYTES = 200_000;
export const DEFAULT_DENSITY_WAVES = 3;
export const PRODUCTION_ACTIVE_HISTORY_LIMITS = {
  jsonBytes: ACTIVE_SESSION_HISTORY_MAX_JSON_BYTES,
  rows: ACTIVE_SESSION_HISTORY_MAX_ROWS,
  jsonNodes: ACTIVE_SESSION_HISTORY_MAX_JSON_NODES,
  jsonProperties: ACTIVE_SESSION_HISTORY_MAX_JSON_PROPERTIES,
} as const;
export const SYNTHETIC_SCENARIOS = [
  "streaming",
  "tool-burst",
  "sandbox",
  "fan-out",
  "wait",
  "drain",
] as const;

export const FORCED_COMPACTION_RULE = {
  trigger: "operator",
  scenario: "streaming",
  selectionRule: "turnIndex % 6 === 0",
  expectedCallsPerWave: "ceil(density / 6)",
} as const;

export const MEASUREMENT_ISOLATION = {
  historySetup: "per-wave seed subprocess",
  seedProcessExitedBeforeBaseline: true,
  measuredProcess: "production activity path",
} as const;

export type SyntheticScenario = (typeof SYNTHETIC_SCENARIOS)[number];

export type DensityProfileConfig = {
  densities: number[];
  waves: number;
  activeHistoryBytes: number;
  inactiveHistoryBytes: number;
  compactionTailBytes: number;
  historyRowPayloadBytes: number;
  plateauSeconds: number;
  plateauSampleIntervalMs: number;
  baselineSamples: number;
  settledSamples: number;
  settleDelayMs: number;
  timeoutMs: number;
  targetMiBPerTurn: number;
  hardLimitMiBPerTurn: number;
  syntheticWorkBytes: number;
  syntheticToolBurst: number;
  syntheticFanOut: number;
  syntheticWaitMs: number;
  syntheticDrainSteps: number;
  artifactPath?: string;
  /** Test-only fault injection: one post-gate model activity never settles. */
  testNeverSettleAfterGate?: boolean;
};

export type NumericSummary = {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  worst: number;
};

export type MemorySummary = {
  sampleCount: number;
  rssMiBMedian: number;
  rssMiBP95: number;
  rssMiBP99: number;
  rssMiBMax: number;
  heapUsedMiBMedian: number;
  externalMiBMedian: number;
};

export type DensityMemorySample = ReturnType<typeof process.memoryUsage>;

export type DensityHistoryShape = {
  shape: "high-cardinality-tiny-object";
  rowPayloadTargetBytes: number;
  activeRowCount: number;
  inactiveRowCount: number;
  totalRowCount: number;
  compactionTailRowCount: number;
  persistentActiveInactiveMix: boolean;
  maxActiveRows: number;
  maxRowsPerTurn: number;
};

export type WaveMeasurement = {
  wave: number;
  compactionCalls: number;
  verifiedCompactionHistoryShrinks: number;
  baseline: MemorySummary;
  plateau: MemorySummary;
  settled: MemorySummary;
  incrementalValues: number[];
  retainedValues: number[];
  plateauToSettledValues: number[];
  rawMemory: {
    baseline: DensityMemorySample[];
    plateau: DensityMemorySample[];
    settled: DensityMemorySample[];
  };
};

export type DensityMeasurement = {
  density: number;
  waves: WaveMeasurement[];
};

type SyntheticWork = {
  release: () => Promise<void>;
  waitBeforeGateMs: number;
};

export type DensitySeedManifest = {
  schemaVersion: 1;
  accountId: string;
  workspaceId: string;
  activeHistoryBytes: number;
  inactiveHistoryBytes: number;
  compactionTailBytes: number;
  historyRowPayloadBytes: number;
  sessions: Array<{
    sessionId: string;
    sessionIndex: number;
  }>;
};

export type DensitySeedChild = {
  readonly exitCode: number | null;
  readonly exited: Promise<number>;
  kill(signal?: number): void;
};

/**
 * Parse the allowed density candidates. The default is intentionally the exact
 * capacity sweep; custom profiles may select/reorder those candidates but may not
 * silently introduce a density that the release gate does not understand.
 */
export function parseDensitySweep(raw?: string): number[] {
  if (raw === undefined || raw.trim() === "") return [...DEFAULT_DENSITIES];

  const allowed = new Set<number>(DEFAULT_DENSITIES);
  const values = raw.split(",").map((part) => {
    const value = Number(part.trim());
    if (!Number.isSafeInteger(value) || !allowed.has(value)) {
      throw new Error(
        `OPENGENI_DENSITY_SWEEP must contain only ${DEFAULT_DENSITIES.join("/")}; got ${part}`,
      );
    }
    return value;
  });
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new Error("OPENGENI_DENSITY_SWEEP must contain each selected density at most once");
  }
  return values;
}

/** Selects a stable mix rather than running every turn through one path. */
export function scenarioForTurn(turnIndex: number): SyntheticScenario {
  if (!Number.isSafeInteger(turnIndex) || turnIndex < 0) {
    throw new Error(`turnIndex must be a nonnegative safe integer; got ${turnIndex}`);
  }
  return SYNTHETIC_SCENARIOS[turnIndex % SYNTHETIC_SCENARIOS.length]!;
}

/** Force the real pre-turn compaction path on one stable scenario per cycle. */
export function shouldForceCompactionForTurn(turnIndex: number): boolean {
  return scenarioForTurn(turnIndex) === FORCED_COMPACTION_RULE.scenario;
}

export function expectedCompactionCallsForDensity(density: number): number {
  if (!Number.isSafeInteger(density) || density < 1) {
    throw new Error(`density must be a positive safe integer; got ${density}`);
  }
  return Math.ceil(density / SYNTHETIC_SCENARIOS.length);
}

/**
 * Return the deterministic row shape used for bounded long-history inputs.
 * The target is the text payload per row; JSONB envelope bytes are deliberately
 * kept separate so the shape remains stable across database encoders.
 */
export function historyRowShape(
  activeBytes: number,
  inactiveBytes: number,
  rowPayloadTargetBytes: number,
  compactionTailBytes: number,
): DensityHistoryShape {
  if (
    !Number.isSafeInteger(activeBytes) ||
    activeBytes <= 0 ||
    activeBytes > MAX_HISTORY_BYTES_PER_TURN
  ) {
    throw new Error(`active history bytes must be between 1 and ${MAX_HISTORY_BYTES_PER_TURN}`);
  }
  if (
    !Number.isSafeInteger(inactiveBytes) ||
    inactiveBytes < 0 ||
    inactiveBytes > MAX_HISTORY_BYTES_PER_TURN
  ) {
    throw new Error(`inactive history bytes must be between 0 and ${MAX_HISTORY_BYTES_PER_TURN}`);
  }
  if (
    !Number.isSafeInteger(rowPayloadTargetBytes) ||
    rowPayloadTargetBytes < MIN_HISTORY_ROW_PAYLOAD_BYTES ||
    rowPayloadTargetBytes > MAX_HISTORY_ROW_PAYLOAD_BYTES
  ) {
    throw new Error(
      `history row payload bytes must be between ${MIN_HISTORY_ROW_PAYLOAD_BYTES} and ${MAX_HISTORY_ROW_PAYLOAD_BYTES}`,
    );
  }
  if (
    !Number.isSafeInteger(compactionTailBytes) ||
    compactionTailBytes <= 0 ||
    compactionTailBytes > activeBytes
  ) {
    throw new Error("compaction tail bytes must be positive and no larger than active history");
  }
  const activeRowCount = historyRowCount(activeBytes, rowPayloadTargetBytes);
  const inactiveRowCount = historyRowCount(inactiveBytes, rowPayloadTargetBytes);
  const totalRowCount = activeRowCount + inactiveRowCount;
  if (activeRowCount > ACTIVE_SESSION_HISTORY_MAX_ROWS) {
    throw new Error(
      `active history row count must be at most ${ACTIVE_SESSION_HISTORY_MAX_ROWS}; got ${activeRowCount}`,
    );
  }
  if (totalRowCount > MAX_HISTORY_ROWS_PER_TURN) {
    throw new Error(
      `history row count must be at most ${MAX_HISTORY_ROWS_PER_TURN} per turn; got ${totalRowCount}`,
    );
  }
  return {
    shape: "high-cardinality-tiny-object",
    rowPayloadTargetBytes,
    activeRowCount,
    inactiveRowCount,
    totalRowCount,
    compactionTailRowCount: historyRowCount(compactionTailBytes, rowPayloadTargetBytes),
    persistentActiveInactiveMix: inactiveRowCount > 0,
    maxActiveRows: ACTIVE_SESSION_HISTORY_MAX_ROWS,
    maxRowsPerTurn: MAX_HISTORY_ROWS_PER_TURN,
  };
}

function historyRowCount(totalBytes: number, rowPayloadTargetBytes: number): number {
  return totalBytes === 0 ? 0 : Math.ceil(totalBytes / rowPayloadTargetBytes);
}

/**
 * Linear-interpolation quantile. Keeping this exported makes the release-gate
 * math independently testable without importing the DB-backed runner.
 */
export function quantile(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  if (!Number.isFinite(percentile) || percentile < 0 || percentile > 1) {
    throw new Error(`percentile must be between 0 and 1; got ${percentile}`);
  }
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * percentile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  const fraction = position - lower;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * fraction;
}

export function summarizeNumbers(values: number[]): NumericSummary {
  if (values.length === 0) {
    return { count: 0, p50: 0, p95: 0, p99: 0, worst: 0 };
  }
  return {
    count: values.length,
    p50: rounded(quantile(values, 0.5)),
    p95: rounded(quantile(values, 0.95)),
    p99: rounded(quantile(values, 0.99)),
    worst: rounded(Math.max(...values)),
  };
}

export function profileConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): DensityProfileConfig {
  const activeHistoryBytes = boundedPositiveInteger(
    env,
    "OPENGENI_DENSITY_ACTIVE_HISTORY_BYTES",
    DEFAULT_ACTIVE_HISTORY_BYTES,
    MAX_HISTORY_BYTES_PER_TURN,
  );
  const inactiveHistoryBytes = boundedNonnegativeInteger(
    env,
    "OPENGENI_DENSITY_INACTIVE_HISTORY_BYTES",
    DEFAULT_INACTIVE_HISTORY_BYTES,
    MAX_HISTORY_BYTES_PER_TURN,
  );
  const compactionTailBytes = boundedPositiveInteger(
    env,
    "OPENGENI_DENSITY_COMPACTION_TAIL_BYTES",
    Math.min(DEFAULT_COMPACTION_TAIL_BYTES, activeHistoryBytes),
    activeHistoryBytes,
  );
  const historyRowPayloadBytes = boundedIntegerRange(
    env,
    "OPENGENI_DENSITY_HISTORY_ROW_PAYLOAD_BYTES",
    DEFAULT_HISTORY_ROW_PAYLOAD_BYTES,
    MIN_HISTORY_ROW_PAYLOAD_BYTES,
    MAX_HISTORY_ROW_PAYLOAD_BYTES,
  );
  historyRowShape(
    activeHistoryBytes,
    inactiveHistoryBytes,
    historyRowPayloadBytes,
    compactionTailBytes,
  );

  const targetMiBPerTurn = positiveNumberFromEnv(env, "OPENGENI_DENSITY_TARGET_MIB_PER_TURN", 50);
  const hardLimitMiBPerTurn = positiveNumberFromEnv(
    env,
    "OPENGENI_DENSITY_HARD_LIMIT_MIB_PER_TURN",
    100,
  );
  if (targetMiBPerTurn > hardLimitMiBPerTurn) {
    throw new Error(
      "OPENGENI_DENSITY_TARGET_MIB_PER_TURN must not exceed OPENGENI_DENSITY_HARD_LIMIT_MIB_PER_TURN",
    );
  }

  return {
    densities: parseDensitySweep(env.OPENGENI_DENSITY_SWEEP),
    waves: boundedPositiveInteger(env, "OPENGENI_DENSITY_WAVES", DEFAULT_DENSITY_WAVES, MAX_WAVES),
    activeHistoryBytes,
    inactiveHistoryBytes,
    compactionTailBytes,
    historyRowPayloadBytes,
    plateauSeconds: boundedPositiveInteger(
      env,
      "OPENGENI_DENSITY_PLATEAU_SECONDS",
      15,
      MAX_PLATEAU_SECONDS,
    ),
    plateauSampleIntervalMs: boundedIntegerRange(
      env,
      "OPENGENI_DENSITY_PLATEAU_SAMPLE_INTERVAL_MS",
      500,
      100,
      60_000,
    ),
    baselineSamples: boundedPositiveInteger(
      env,
      "OPENGENI_DENSITY_BASELINE_SAMPLES",
      5,
      MAX_SAMPLE_COUNT,
    ),
    settledSamples: boundedPositiveInteger(
      env,
      "OPENGENI_DENSITY_SETTLED_SAMPLES",
      5,
      MAX_SAMPLE_COUNT,
    ),
    settleDelayMs: boundedPositiveInteger(
      env,
      "OPENGENI_DENSITY_SETTLE_DELAY_MS",
      1_000,
      MAX_SETTLE_DELAY_MS,
    ),
    timeoutMs: boundedPositiveInteger(env, "OPENGENI_DENSITY_TIMEOUT_MS", 300_000, MAX_TIMEOUT_MS),
    targetMiBPerTurn,
    hardLimitMiBPerTurn,
    syntheticWorkBytes: boundedPositiveInteger(
      env,
      "OPENGENI_DENSITY_SYNTHETIC_WORK_BYTES",
      256 * 1024,
      MAX_SYNTHETIC_WORK_BYTES_PER_TURN,
    ),
    syntheticToolBurst: boundedPositiveInteger(
      env,
      "OPENGENI_DENSITY_SYNTHETIC_TOOL_BURST",
      6,
      MAX_SYNTHETIC_ITEMS,
    ),
    syntheticFanOut: boundedPositiveInteger(
      env,
      "OPENGENI_DENSITY_SYNTHETIC_FAN_OUT",
      4,
      MAX_SYNTHETIC_ITEMS,
    ),
    syntheticWaitMs: boundedIntegerRange(
      env,
      "OPENGENI_DENSITY_SYNTHETIC_WAIT_MS",
      10,
      0,
      MAX_SYNTHETIC_WAIT_MS,
    ),
    syntheticDrainSteps: boundedPositiveInteger(
      env,
      "OPENGENI_DENSITY_SYNTHETIC_DRAIN_STEPS",
      4,
      MAX_SYNTHETIC_ITEMS,
    ),
    ...(env.OPENGENI_DENSITY_ARTIFACT_PATH
      ? { artifactPath: env.OPENGENI_DENSITY_ARTIFACT_PATH }
      : {}),
  };
}

async function main(): Promise<void> {
  const seedManifestPath = process.env[DENSITY_SEED_MANIFEST_ENV];
  if (seedManifestPath) {
    await runDensitySeedChild(seedManifestPath);
    return;
  }

  const config = profileConfigFromEnv();
  const runId = crypto.randomUUID();
  const productionSettings = getSettings();
  const settings = densityProfileSettings(productionSettings);
  const searchPath = dbSearchPath(settings);
  const dbClient = createDb(settings.databaseUrl, {
    ...(searchPath ? { searchPath } : {}),
    rlsStrategy: settings.rlsStrategy,
  });
  const bus = new MemoryEventBus();
  let workspaceId: string | null = null;
  let sessionsCreated = 0;

  try {
    const access = await bootstrapWorkspace(dbClient.db, {
      accountExternalSource: "operator:turn-density-profile",
      accountExternalId: runId,
      accountName: `Turn density profile ${runId}`,
      workspaceExternalSource: "operator:turn-density-profile",
      workspaceExternalId: runId,
      workspaceName: `Turn density profile ${runId}`,
      subjectId: `operator:turn-density-profile:${runId}`,
      subjectLabel: "Turn density profile",
    });
    const grant = access.workspaceGrants[0];
    if (!grant?.workspaceId)
      throw new Error("Density profile workspace bootstrap returned no grant");
    workspaceId = grant.workspaceId;

    const densityMeasurements: DensityMeasurement[] = [];
    for (const density of config.densities) {
      const waves: WaveMeasurement[] = [];
      for (let wave = 0; wave < config.waves; wave += 1) {
        waves.push(
          await runWave({
            config,
            density,
            wave,
            runId,
            accountId: grant.accountId,
            workspaceId,
            db: dbClient.db,
            bus,
            settings,
          }),
        );
        sessionsCreated += density;
      }
      densityMeasurements.push({ density, waves });
    }

    await cleanupDensityWorkspace(
      () => deleteWorkspace(dbClient.db, workspaceId!),
      config.timeoutMs,
    );
    workspaceId = null;
    const result = buildProfileResult({
      config,
      runId,
      productionRevision: productionSettings.deploymentRevision,
      densityMeasurements,
      cleanup: {
        workspacesCreated: 1,
        workspacesDeleted: 1,
        sessionsCreated,
      },
    });
    await writeArtifact(config.artifactPath, result);
    console.log(`OPENGENI_DENSITY_RESULT=${JSON.stringify(result)}`);
    if (!result.thresholds.hardLimitMet) process.exitCode = 2;
  } finally {
    if (workspaceId) {
      await cleanupDensityWorkspace(
        () => deleteWorkspace(dbClient.db, workspaceId!),
        config.timeoutMs,
      ).catch((error) => {
        console.error(`Density workspace cleanup failed: ${errorMessage(error)}`);
        process.exitCode = 1;
      });
    }
    await dbClient.close();
  }
}

export async function runWave(input: {
  config: DensityProfileConfig;
  density: number;
  wave: number;
  runId: string;
  accountId: string;
  workspaceId: string;
  db: Parameters<typeof withWorkspaceRls>[0];
  bus: MemoryEventBus;
  settings: Settings;
}): Promise<WaveMeasurement> {
  const { config, density, wave, runId, accountId, workspaceId, db, bus, settings } = input;
  const model = createDensityModel(density, config);
  const activities = createTurnActivities({
    settings,
    db,
    bus,
    runtime: createProductionAgentRuntime({ model }),
    summarizeContextForCompaction: model.summarizeForCompaction,
    objectStorage: null,
  });
  const turnInputs = [];
  const createdSessions: Array<{
    id: string;
    initialMessage: string;
    index: number;
    workflowId: string;
  }> = [];
  const forcedCompactionSessions: Array<{
    sessionId: string;
    activeHistoryItemsBefore: number;
  }> = [];
  let allRuns: Promise<PromiseSettledResult<unknown>[]> | null = null;
  let allRunsSettled = false;
  const deadlineAt = Date.now() + config.timeoutMs;
  const phase = <T>(work: Promise<T>, label: string) =>
    withDeadline(work, deadlineAt, `Timed out during ${label} for density ${density} wave ${wave}`);

  try {
    for (let index = 0; index < density; index += 1) {
      const session = await phase(
        createSession(db, {
          accountId,
          workspaceId,
          initialMessage: `density profile ${density}/${wave}/${index}`,
          resources: [],
          tools: [],
          metadata: {
            densityProfileRunId: runId,
            density,
            wave,
            turnIndex: index,
            syntheticScenarios: SYNTHETIC_SCENARIOS,
          },
          model: "scripted-density-model",
          sandboxBackend: "none",
        }),
        "session creation",
      );
      createdSessions.push({
        id: session.id,
        initialMessage: session.initialMessage,
        index,
        workflowId: `density-profile-${runId}-${density}-${wave}-${index}`,
      });
    }

    await runHistorySeedSubprocess(
      {
        schemaVersion: 1,
        accountId,
        workspaceId,
        activeHistoryBytes: config.activeHistoryBytes,
        inactiveHistoryBytes: config.inactiveHistoryBytes,
        compactionTailBytes: config.compactionTailBytes,
        historyRowPayloadBytes: config.historyRowPayloadBytes,
        sessions: createdSessions.map((session) => ({
          sessionId: session.id,
          sessionIndex: session.index,
        })),
      },
      deadlineAt,
      density,
      wave,
    );

    for (const session of createdSessions) {
      const [trigger] = await phase(
        appendSessionEvents(db, workspaceId, session.id, [
          { type: "user.message", payload: { text: session.initialMessage } },
        ]),
        "trigger creation",
      );
      if (!trigger) throw new Error(`Failed to append trigger for density session ${session.id}`);
      await phase(
        enqueueSessionTurn(db, {
          accountId,
          workspaceId,
          sessionId: session.id,
          triggerEventId: trigger.id,
          temporalWorkflowId: session.workflowId,
          source: "user",
          prompt: session.initialMessage,
          resources: [],
          tools: [],
          model: "scripted-density-model",
          reasoningEffort: "low",
          sandboxBackend: "none",
          metadata: {
            densityProfileRunId: runId,
            density,
            wave,
            turnIndex: session.index,
          },
          placement: "tail",
        }),
        "turn enqueue",
      );
      if (shouldForceCompactionForTurn(session.index)) {
        const activeHistoryItemsBefore = await phase(
          countActiveSessionHistoryItems(db, workspaceId, session.id),
          "seeded active-history count",
        );
        await phase(
          requestSessionCompaction(db, workspaceId, session.id),
          "forced compaction request",
        );
        forcedCompactionSessions.push({
          sessionId: session.id,
          activeHistoryItemsBefore,
        });
      }
      turnInputs.push({
        accountId,
        workspaceId,
        sessionId: session.id,
        workflowId: session.workflowId,
        workflowRunId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        trigger: { kind: "next" } as const,
      });
    }

    await settleAndCollect(config.settleDelayMs, deadlineAt);
    const baselineSamples = await sampleMemory(
      config.baselineSamples,
      250,
      deadlineAt,
      "baseline sampling",
    );
    const baseline = summarizeMemory(baselineSamples);
    const runs = turnInputs.map((turnInput) => activities.runAgentTurn(turnInput));
    allRuns = Promise.allSettled(runs).then((results) => {
      allRunsSettled = true;
      return results;
    });
    await phase(
      Promise.race([
        model.allStarted,
        allRuns.then((results) => {
          const failure = densityActivityFailureBeforeGate(results);
          if (failure) throw failure;
          throw new Error("Density turns settled before reaching the model gate");
        }),
      ]),
      "model gate arrival",
    );

    const plateauSampleCount = Math.max(
      2,
      Math.ceil((config.plateauSeconds * 1_000) / config.plateauSampleIntervalMs) + 1,
    );
    const plateauSamples = await sampleMemory(
      plateauSampleCount,
      config.plateauSampleIntervalMs,
      deadlineAt,
      "plateau sampling",
    );
    model.release();
    const results = await phase(allRuns, "activity settlement");
    const failures = results.flatMap((result, index) =>
      result.status === "rejected"
        ? [{ index, error: errorMessage(result.reason) }]
        : result.value &&
            typeof result.value === "object" &&
            "status" in result.value &&
            result.value.status !== "idle"
          ? [
              {
                index,
                error: `unexpected activity status ${String(result.value.status)}`,
              },
            ]
          : [],
    );
    if (failures.length > 0) {
      throw new Error(`Density activity failures: ${JSON.stringify(failures)}`);
    }

    const compactionChecks = await phase(
      Promise.all(
        forcedCompactionSessions.map(async ({ sessionId, activeHistoryItemsBefore }) => {
          const [activeHistoryItemsAfter, requestStillPending] = await Promise.all([
            countActiveSessionHistoryItems(db, workspaceId, sessionId),
            isSessionCompactionRequested(db, workspaceId, sessionId),
          ]);
          if (requestStillPending) {
            throw new Error(`Forced compaction request was not consumed for session ${sessionId}`);
          }
          if (activeHistoryItemsAfter >= activeHistoryItemsBefore) {
            throw new Error(
              `Forced compaction did not shrink active history for session ${sessionId}: ` +
                `${activeHistoryItemsBefore} -> ${activeHistoryItemsAfter}`,
            );
          }
          return {
            sessionId,
            activeHistoryItemsBefore,
            activeHistoryItemsAfter,
          };
        }),
      ),
      "forced compaction verification",
    );
    const expectedCompactionCalls = expectedCompactionCallsForDensity(density);
    if (
      model.compactionCalls !== expectedCompactionCalls ||
      compactionChecks.length !== expectedCompactionCalls
    ) {
      throw new Error(
        `Density ${density} wave ${wave} expected ${expectedCompactionCalls} verified ` +
          `compactions, got ${model.compactionCalls} calls and ${compactionChecks.length} shrinks`,
      );
    }

    model.clearRequests();
    bus.published.length = 0;
    await settleAndCollect(config.settleDelayMs, deadlineAt);
    const settledSamples = await sampleMemory(
      config.settledSamples,
      250,
      deadlineAt,
      "settled sampling",
    );
    const plateau = summarizeMemory(plateauSamples);
    const settled = summarizeMemory(settledSamples);
    const incrementalValues = plateauSamples.map(
      (sample) => Math.max(0, sample.rss / MIB - baseline.rssMiBMedian) / density,
    );
    const retainedValue = settled.rssMiBMedian - baseline.rssMiBMedian;
    const plateauToSettledValues = plateauSamples.map(
      (sample) => sample.rss / MIB - settled.rssMiBMedian,
    );
    return {
      wave,
      compactionCalls: model.compactionCalls,
      verifiedCompactionHistoryShrinks: compactionChecks.length,
      baseline,
      plateau,
      settled,
      incrementalValues,
      retainedValues: [retainedValue / density],
      plateauToSettledValues,
      rawMemory: {
        baseline: baselineSamples,
        plateau: plateauSamples,
        settled: settledSamples,
      },
    };
  } finally {
    model.release();
    if (allRuns && !allRunsSettled) {
      // Never extend the wave timeout while draining a post-gate activity. The
      // allSettled promise is intentionally left observed if a fault-injected
      // activity never resolves; workspace cleanup runs independently in main.
      await phase(allRuns, "fault cleanup settlement").catch(() => undefined);
    }
  }
}

export function parseDensitySeedManifest(text: string): DensitySeedManifest {
  if (Buffer.byteLength(text, "utf8") > MAX_SEED_MANIFEST_BYTES) {
    throw new Error(`Density seed manifest must not exceed ${MAX_SEED_MANIFEST_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Density seed manifest is not valid JSON: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  const manifest = exactRecord(
    parsed,
    [
      "schemaVersion",
      "accountId",
      "workspaceId",
      "activeHistoryBytes",
      "inactiveHistoryBytes",
      "compactionTailBytes",
      "historyRowPayloadBytes",
      "sessions",
    ],
    "density seed manifest",
  );
  if (manifest.schemaVersion !== 1) {
    throw new Error("Density seed manifest schemaVersion must be 1");
  }
  const accountId = uuidString(manifest.accountId, "density seed manifest.accountId");
  const workspaceId = uuidString(manifest.workspaceId, "density seed manifest.workspaceId");
  const activeHistoryBytes = safeInteger(
    manifest.activeHistoryBytes,
    "density seed manifest.activeHistoryBytes",
  );
  const inactiveHistoryBytes = safeInteger(
    manifest.inactiveHistoryBytes,
    "density seed manifest.inactiveHistoryBytes",
  );
  const compactionTailBytes = safeInteger(
    manifest.compactionTailBytes,
    "density seed manifest.compactionTailBytes",
  );
  const historyRowPayloadBytes = safeInteger(
    manifest.historyRowPayloadBytes,
    "density seed manifest.historyRowPayloadBytes",
  );
  historyRowShape(
    activeHistoryBytes,
    inactiveHistoryBytes,
    historyRowPayloadBytes,
    compactionTailBytes,
  );
  if (!Array.isArray(manifest.sessions) || manifest.sessions.length < 1) {
    throw new Error("Density seed manifest.sessions must be a non-empty array");
  }
  if (manifest.sessions.length > Math.max(...DEFAULT_DENSITIES)) {
    throw new Error(
      `Density seed manifest.sessions must contain at most ${Math.max(...DEFAULT_DENSITIES)} entries`,
    );
  }
  const seenSessionIds = new Set<string>();
  const sessions = manifest.sessions.map((value, index) => {
    const session = exactRecord(value, ["sessionId", "sessionIndex"], `sessions[${index}]`);
    const sessionId = uuidString(session.sessionId, `sessions[${index}].sessionId`);
    const sessionIndex = safeInteger(session.sessionIndex, `sessions[${index}].sessionIndex`);
    if (sessionIndex !== index) {
      throw new Error(`sessions[${index}].sessionIndex must equal its zero-based array position`);
    }
    if (seenSessionIds.has(sessionId)) {
      throw new Error(`sessions[${index}].sessionId must be unique`);
    }
    seenSessionIds.add(sessionId);
    return { sessionId, sessionIndex };
  });
  return {
    schemaVersion: 1,
    accountId,
    workspaceId,
    activeHistoryBytes,
    inactiveHistoryBytes,
    compactionTailBytes,
    historyRowPayloadBytes,
    sessions,
  };
}

async function runDensitySeedChild(manifestPath: string): Promise<void> {
  const manifestStat = await stat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.size > MAX_SEED_MANIFEST_BYTES) {
    throw new Error(
      `Density seed manifest must be a file of at most ${MAX_SEED_MANIFEST_BYTES} bytes`,
    );
  }
  const manifest = parseDensitySeedManifest(await readFile(manifestPath, "utf8"));
  const settings = densityProfileSettings(getSettings());
  const searchPath = dbSearchPath(settings);
  const dbClient = createDb(settings.databaseUrl, {
    ...(searchPath ? { searchPath } : {}),
    rlsStrategy: settings.rlsStrategy,
  });
  try {
    for (const session of manifest.sessions) {
      await seedHistory({
        db: dbClient.db,
        accountId: manifest.accountId,
        workspaceId: manifest.workspaceId,
        sessionId: session.sessionId,
        sessionIndex: session.sessionIndex,
        activeBytes: manifest.activeHistoryBytes,
        inactiveBytes: manifest.inactiveHistoryBytes,
        compactionTailBytes: manifest.compactionTailBytes,
        rowPayloadTargetBytes: manifest.historyRowPayloadBytes,
      });
    }
  } finally {
    await dbClient.close();
  }
}

async function runHistorySeedSubprocess(
  manifest: DensitySeedManifest,
  deadlineAt: number,
  density: number,
  wave: number,
): Promise<void> {
  const validated = parseDensitySeedManifest(JSON.stringify(manifest));
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "opengeni-turn-density-seed-"));
  const manifestPath = join(temporaryDirectory, "manifest.json");
  let child: ReturnType<typeof Bun.spawn> | null = null;
  await withDensitySeedChildCleanup(
    async () => {
      await writeFile(manifestPath, `${JSON.stringify(validated)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      child = Bun.spawn([process.execPath, import.meta.path], {
        env: { ...process.env, [DENSITY_SEED_MANIFEST_ENV]: manifestPath },
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      });
      const exitCode = await withDeadline(
        child.exited,
        deadlineAt,
        `Timed out during isolated history seeding for density ${density} wave ${wave}`,
      );
      if (exitCode !== 0) {
        throw new Error(
          `Isolated history seed process exited ${exitCode} for density ${density} wave ${wave}`,
        );
      }
    },
    () => child,
    () => rm(temporaryDirectory, { recursive: true, force: true }),
  );
}

/**
 * Own a seed subprocess and its manifest directory as one ordered lifecycle.
 * The reap timeout is deliberately independent from the wave deadline: the
 * latter is normally already expired when this failure path runs.
 */
export async function withDensitySeedChildCleanup<T>(
  work: () => Promise<T>,
  currentChild: () => DensitySeedChild | null,
  cleanup: () => Promise<void>,
  reapTimeoutMs = DENSITY_SEED_REAP_TIMEOUT_MS,
): Promise<T> {
  let result: T;
  try {
    result = await work();
  } catch (error) {
    const child = currentChild();
    if (child && child.exitCode === null) {
      try {
        child.kill(9);
        await withTimeout(
          child.exited,
          reapTimeoutMs,
          `Timed out after ${reapTimeoutMs}ms waiting for killed density seed process to exit`,
        );
      } catch (reapError) {
        attachDensitySeedSecondaryFailure(error, reapError);
      }
    }
    try {
      await cleanup();
    } catch (cleanupError) {
      attachDensitySeedSecondaryFailure(error, cleanupError);
    }
    throw error;
  }
  await cleanup();
  return result;
}

function attachDensitySeedSecondaryFailure(primary: unknown, secondary: unknown): void {
  if (!(primary instanceof Error)) return;
  try {
    primary.cause =
      primary.cause === undefined
        ? secondary
        : new AggregateError(
            primary.cause instanceof AggregateError
              ? [...primary.cause.errors, secondary]
              : [primary.cause, secondary],
            "Density seed lifecycle secondary failures",
          );
  } catch {
    // A frozen or exotic thrown Error must still remain the primary failure.
  }
}

function exactRecord(value: unknown, keys: string[], path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record).sort();
  const expectedKeys = [...keys].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`${path} must contain exactly ${expectedKeys.join(", ")}`);
  }
  return record;
}

function uuidString(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new Error(`${path} must be a UUID`);
  }
  return value;
}

function safeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${path} must be a safe integer`);
  }
  return value;
}

export function densityActivityFailureBeforeGate(
  results: PromiseSettledResult<unknown>[],
): Error | null {
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejected) {
    return rejected.reason instanceof Error
      ? rejected.reason
      : new Error(`Density activity rejected before model gate: ${errorMessage(rejected.reason)}`);
  }
  const failed = results.find(
    (result) =>
      result.status === "fulfilled" &&
      typeof result.value === "object" &&
      result.value !== null &&
      "status" in result.value &&
      result.value.status !== "idle",
  );
  if (failed?.status === "fulfilled") {
    return new Error(`Density activity settled before model gate: ${JSON.stringify(failed.value)}`);
  }
  return null;
}

async function seedHistory(input: {
  db: Parameters<typeof withWorkspaceRls>[0];
  accountId: string;
  workspaceId: string;
  sessionId: string;
  sessionIndex: number;
  activeBytes: number;
  inactiveBytes: number;
  compactionTailBytes: number;
  rowPayloadTargetBytes: number;
}): Promise<void> {
  const shape = historyRowShape(
    input.activeBytes,
    input.inactiveBytes,
    input.rowPayloadTargetBytes,
    input.compactionTailBytes,
  );
  await seedHistoryRows(
    input,
    input.inactiveBytes,
    false,
    shape.activeRowCount,
    input.rowPayloadTargetBytes,
    0,
  );
  await seedHistoryRows(
    input,
    input.activeBytes,
    true,
    0,
    input.rowPayloadTargetBytes,
    input.compactionTailBytes,
  );

  const [activeRows, totalRows] = await Promise.all([
    countActiveSessionHistoryItems(input.db, input.workspaceId, input.sessionId),
    countSessionHistoryItems(input.db, input.workspaceId, input.sessionId),
  ]);
  const inactiveRows = totalRows - activeRows;
  if (
    Number(activeRows) !== shape.activeRowCount ||
    Number(inactiveRows) !== shape.inactiveRowCount
  ) {
    throw new Error("Deterministic density history row shape drifted while seeding");
  }
}

async function seedHistoryRows(
  input: {
    db: Parameters<typeof withWorkspaceRls>[0];
    accountId: string;
    workspaceId: string;
    sessionId: string;
    sessionIndex: number;
  },
  totalBytes: number,
  active: boolean,
  positionOffset: number,
  rowPayloadTargetBytes: number,
  compactionTailBytes: number,
): Promise<void> {
  const itemCount = historyRowCount(totalBytes, rowPayloadTargetBytes);
  if (itemCount === 0) return;
  const payloadBytes = Math.max(1, Math.floor(totalBytes / itemCount) - HISTORY_ROW_OVERHEAD_BYTES);
  const tailCount = active ? historyRowCount(compactionTailBytes, rowPayloadTargetBytes) : 0;
  let rows: ReturnType<typeof historyRows> = [];
  for (let itemIndex = 0; itemIndex < itemCount; itemIndex += 1) {
    rows.push(
      historyRowAt({
        input,
        active,
        positionOffset,
        itemIndex,
        itemCount,
        payloadBytes,
        tailCount,
        compactionTailBytes,
      }),
    );
    if (rows.length < 25 && itemIndex + 1 < itemCount) continue;
    const batch = rows;
    rows = [];
    await withWorkspaceRls(input.db, input.workspaceId, async (db) => {
      await db.insert(schema.sessionHistoryItems).values(batch);
    });
  }
}

export function historyRows(
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    sessionIndex: number;
  },
  totalBytes: number,
  active: boolean,
  positionOffset: number,
  rowPayloadTargetBytes: number,
  compactionTailBytes: number,
) {
  if (totalBytes === 0) return [];
  const itemCount = historyRowCount(totalBytes, rowPayloadTargetBytes);
  const payloadBytes = Math.max(1, Math.floor(totalBytes / itemCount) - HISTORY_ROW_OVERHEAD_BYTES);
  const tailCount = active ? historyRowCount(compactionTailBytes, rowPayloadTargetBytes) : 0;
  return Array.from({ length: itemCount }, (_, itemIndex) =>
    historyRowAt({
      input,
      active,
      positionOffset,
      itemIndex,
      itemCount,
      payloadBytes,
      tailCount,
      compactionTailBytes,
    }),
  );
}

function historyRowAt(input: {
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    sessionIndex: number;
  };
  active: boolean;
  positionOffset: number;
  itemIndex: number;
  itemCount: number;
  payloadBytes: number;
  tailCount: number;
  compactionTailBytes: number;
}) {
  const isCompactionTail = input.active && input.itemIndex >= input.itemCount - input.tailCount;
  const isCheckpoint = input.active && input.itemIndex === 0;
  const role = isCompactionTail ? "user" : input.itemIndex % 2 === 0 ? "user" : "assistant";
  return {
    accountId: input.input.accountId,
    workspaceId: input.input.workspaceId,
    sessionId: input.input.sessionId,
    position: input.positionOffset + input.itemIndex,
    active: input.active,
    item: {
      type: "message",
      role,
      status: "completed",
      content: [
        {
          type: role === "user" ? "input_text" : "output_text",
          text: deterministicText(input.input.sessionIndex, input.itemIndex, input.payloadBytes),
        },
      ],
      ...(isCheckpoint
        ? {
            providerData: {
              densityProfile: {
                shape: "compaction-checkpoint",
                bounded: true,
                tailBytes: input.compactionTailBytes,
              },
            },
          }
        : {}),
    },
  };
}

function deterministicText(sessionIndex: number, itemIndex: number, bytes: number): string {
  const prefix = `density:${sessionIndex}:${itemIndex}:`;
  const block = `${prefix}abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ\n`;
  return block.repeat(Math.ceil(bytes / block.length)).slice(0, bytes);
}

function createDensityModel(expected: number, config: DensityProfileConfig) {
  return new (class {
    readonly allStarted: Promise<void>;
    compactionCalls = 0;
    private started = 0;
    private resolveAllStarted!: () => void;
    private readonly gate: Promise<void>;
    private resolveGate!: () => void;
    private released = false;
    private readonly activeWork = new Set<SyntheticWork>();
    private readonly delegate: ScriptedModel;
    private readonly forcedTurnIndexes: number[];
    private readonly ordinaryTurnIndexes: number[];
    private forcedArrivals = 0;
    private ordinaryArrivals = 0;

    constructor() {
      this.allStarted = new Promise((resolve) => {
        this.resolveAllStarted = resolve;
      });
      this.gate = new Promise((resolve) => {
        this.resolveGate = resolve;
      });
      this.delegate = new ScriptedModel([syntheticModelStep()]);
      const turnIndexes = Array.from({ length: expected }, (_, index) => index);
      this.forcedTurnIndexes = turnIndexes.filter(shouldForceCompactionForTurn);
      this.ordinaryTurnIndexes = turnIndexes.filter(
        (turnIndex) => !shouldForceCompactionForTurn(turnIndex),
      );
    }

    async getResponse(request: Parameters<ScriptedModel["getResponse"]>[0]) {
      await this.arrive(request, "ordinary");
      return await this.delegate.getResponse(request);
    }

    async *getStreamedResponse(request: Parameters<ScriptedModel["getStreamedResponse"]>[0]) {
      await this.arrive(request, "ordinary");
      yield* this.delegate.getStreamedResponse(request);
    }

    readonly summarizeForCompaction = async (
      _settings: Settings,
      input: Array<Record<string, unknown>>,
    ): Promise<string> => {
      this.compactionCalls += 1;
      await this.arrive({ input }, "forced-compaction");
      return "Deterministic bounded density-profile context summary.";
    };

    release(): void {
      if (this.released) return;
      this.released = true;
      this.resolveGate();
    }

    clearRequests(): void {
      this.delegate.requests.length = 0;
    }

    private async arrive(request: { input?: unknown }, path: "ordinary" | "forced-compaction") {
      // A proactive compaction call is the first memory boundary for a
      // pathological history. After that boundary is released, the same turn's
      // main model call must pass through instead of counting as a second turn.
      if (this.released) {
        void request.input;
        return;
      }
      if (this.started >= expected) {
        throw new Error(`Density model received more than ${expected} model calls`);
      }
      const turnIndex =
        path === "forced-compaction"
          ? this.forcedTurnIndexes[this.forcedArrivals++]
          : this.ordinaryTurnIndexes[this.ordinaryArrivals++];
      if (turnIndex === undefined) {
        throw new Error(`Density model received an unexpected ${path} arrival`);
      }
      this.started += 1;
      const work = syntheticWorkForTurn(turnIndex, config);
      this.activeWork.add(work);
      if (work.waitBeforeGateMs > 0) await Bun.sleep(work.waitBeforeGateMs);
      if (this.started === expected) this.resolveAllStarted();
      await this.gate;
      if (config.testNeverSettleAfterGate && turnIndex === 0) {
        await new Promise<void>(() => undefined);
      }
      await work.release();
      this.activeWork.delete(work);
      // Keep the request live until the gate and synthetic drain have both
      // completed. This mirrors the real worker's in-flight model input lease.
      void request.input;
    }
  })();
}

function syntheticModelStep(): ScriptedModelStep {
  return {
    chunks: ["density ", "profile ", "synthetic ", "stream"],
    outputText: "density profile synthetic stream",
    inputTokens: 200_000,
  };
}

function syntheticWorkForTurn(turnIndex: number, config: DensityProfileConfig): SyntheticWork {
  const scenario = scenarioForTurn(turnIndex);
  const buffers: Uint8Array[] = [];
  const retained: unknown[] = [];
  const pending: Array<Promise<void>> = [];
  const resolvePending: Array<() => void> = [];
  const bytesPerBuffer = Math.max(1, Math.floor(config.syntheticWorkBytes / 2));

  const allocate = (count: number): void => {
    for (let index = 0; index < count; index += 1) {
      const buffer = new Uint8Array(bytesPerBuffer);
      buffer.fill((turnIndex + index) % 251);
      buffers.push(buffer);
    }
  };

  switch (scenario) {
    case "streaming":
      allocate(1);
      retained.push({
        streamChunks: ["delta-1", "delta-2", "delta-3"],
        buffers,
      });
      break;
    case "tool-burst":
      allocate(2);
      retained.push({
        toolCalls: Array.from({ length: config.syntheticToolBurst }, (_, index) => ({
          callId: `density-tool-${turnIndex}-${index}`,
          name: "synthetic_tool",
          arguments: { index, bounded: true },
        })),
        toolOutputs: Array.from({ length: config.syntheticToolBurst }, (_, index) => ({
          callId: `density-tool-${turnIndex}-${index}`,
          outputBytes: bytesPerBuffer,
        })),
        buffers,
      });
      break;
    case "sandbox":
      allocate(2);
      retained.push({
        sandboxManifest: { backend: "none", root: "/workspace", bounded: true },
        sandboxOps: ["exec", "read", "write", "drain"],
        buffers,
      });
      break;
    case "fan-out":
      allocate(1);
      for (let index = 0; index < config.syntheticFanOut; index += 1) {
        pending.push(Promise.resolve().then(() => undefined));
      }
      retained.push({ fanOut: Promise.all(pending), buffers });
      break;
    case "wait":
      allocate(1);
      retained.push({ waitMs: config.syntheticWaitMs, buffers });
      break;
    case "drain":
      allocate(1);
      for (let index = 0; index < config.syntheticDrainSteps; index += 1) {
        pending.push(
          new Promise<void>((resolve) => {
            resolvePending.push(resolve);
          }),
        );
      }
      retained.push({ drainSteps: config.syntheticDrainSteps, buffers });
      break;
  }

  return {
    waitBeforeGateMs: scenario === "wait" ? config.syntheticWaitMs : 0,
    release: async () => {
      for (const resolve of resolvePending) resolve();
      await Promise.all(pending);
      retained.length = 0;
      buffers.length = 0;
    },
  };
}

export function syntheticAllocatedWorkBytesByScenario(
  configuredBytes: number,
): Record<SyntheticScenario, number> {
  const bytesPerBuffer = Math.max(1, Math.floor(configuredBytes / 2));
  return {
    streaming: bytesPerBuffer,
    "tool-burst": bytesPerBuffer * 2,
    sandbox: bytesPerBuffer * 2,
    "fan-out": bytesPerBuffer,
    wait: bytesPerBuffer,
    drain: bytesPerBuffer,
  };
}

export function buildProfileResult(input: {
  config: DensityProfileConfig;
  runId: string;
  productionRevision: string;
  densityMeasurements: DensityMeasurement[];
  cleanup: {
    workspacesCreated: number;
    workspacesDeleted: number;
    sessionsCreated: number;
  };
}) {
  const { config, runId, productionRevision, densityMeasurements, cleanup } = input;
  const densityResults = densityMeasurements.map(({ density, waves }) => {
    const incrementalValues = waves.flatMap((wave) => wave.incrementalValues);
    const retainedValues = waves.flatMap((wave) => wave.retainedValues);
    const plateauToSettledValues = waves.flatMap((wave) => wave.plateauToSettledValues);
    const settledMedians = waves.map((wave) => wave.settled.rssMiBMedian);
    return {
      density,
      waves: waves.map((wave) => ({
        wave: wave.wave,
        compactionCalls: wave.compactionCalls,
        verifiedCompactionHistoryShrinks: wave.verifiedCompactionHistoryShrinks,
        memory: {
          baseline: wave.baseline,
          plateau: wave.plateau,
          settled: wave.settled,
        },
        incrementalRssMiBPerTurn: summarizeNumbers(wave.incrementalValues),
        leak: {
          retainedAfterSettlementMiBPerTurn: summarizeNumbers(wave.retainedValues),
          plateauToSettledMiB: summarizeNumbers(wave.plateauToSettledValues),
        },
        rawSamples: {
          memory: wave.rawMemory,
          incrementalRssMiBPerTurn: wave.incrementalValues,
          retainedAfterSettlementMiBPerTurn: wave.retainedValues,
          plateauToSettledMiB: wave.plateauToSettledValues,
        },
      })),
      statistics: {
        incrementalRssMiBPerTurn: summarizeNumbers(incrementalValues),
        leak: {
          retainedAfterSettlementMiBPerTurn: summarizeNumbers(retainedValues),
          plateauToSettledMiB: summarizeNumbers(plateauToSettledValues),
          settledGrowthMiB: settledGrowth(settledMedians),
        },
      },
      thresholds: thresholdResult(
        summarizeNumbers(incrementalValues).worst,
        config.targetMiBPerTurn,
        config.hardLimitMiBPerTurn,
      ),
    };
  });
  const aggregateIncremental = densityMeasurements.flatMap((measurement) =>
    measurement.waves.flatMap((wave) => wave.incrementalValues),
  );
  const aggregateIncrementalSummary = summarizeNumbers(aggregateIncremental);

  return {
    schemaVersion: 3,
    runId,
    generatedAt: new Date().toISOString(),
    productionRevision,
    runtime: {
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
    },
    workload: {
      densities: config.densities,
      waves: config.waves,
      history: {
        activeBytesPerTurn: config.activeHistoryBytes,
        inactiveBytesPerTurn: config.inactiveHistoryBytes,
        compactionTailBytesPerTurn: config.compactionTailBytes,
        maxHistoryBytesPerTurn: MAX_HISTORY_BYTES_PER_TURN,
        productionActiveMaterializationLimits: PRODUCTION_ACTIVE_HISTORY_LIMITS,
        shape: historyRowShape(
          config.activeHistoryBytes,
          config.inactiveHistoryBytes,
          config.historyRowPayloadBytes,
          config.compactionTailBytes,
        ),
      },
      plateauSeconds: config.plateauSeconds,
      plateauSampleIntervalMs: config.plateauSampleIntervalMs,
      sampling: {
        baselineSamples: config.baselineSamples,
        settledSamples: config.settledSamples,
        settleDelayMs: config.settleDelayMs,
        timeoutMs: config.timeoutMs,
      },
      measurementIsolation: MEASUREMENT_ISOLATION,
      syntheticMix: {
        scenarios: SYNTHETIC_SCENARIOS,
        configuredWorkBytesPerTurn: config.syntheticWorkBytes,
        allocatedWorkBytesByScenario: syntheticAllocatedWorkBytesByScenario(
          config.syntheticWorkBytes,
        ),
        toolBurst: config.syntheticToolBurst,
        fanOut: config.syntheticFanOut,
        waitMs: config.syntheticWaitMs,
        drainSteps: config.syntheticDrainSteps,
        modelProvider: "ScriptedModel",
        compactionSummarizer: "injected deterministic density gate",
        forcedCompaction: FORCED_COMPACTION_RULE,
        activeHistoryShrinkVerified: true,
        externalModelProviderCalled: false,
        azureInferenceCalled: false,
        realSandboxProviderCalled: false,
        note: "Tool and sandbox envelopes are bounded in-process shapes, not provider evidence.",
      },
    },
    statistics: {
      incrementalRssMiBPerTurn: aggregateIncrementalSummary,
    },
    thresholds: {
      targetMiBPerTurn: config.targetMiBPerTurn,
      hardLimitMiBPerTurn: config.hardLimitMiBPerTurn,
      targetMet: densityResults.every((result) => result.thresholds.targetMet),
      hardLimitMet: densityResults.every((result) => result.thresholds.hardLimitMet),
    },
    cleanup,
    densities: densityResults,
  };
}

function thresholdResult(worst: number, target: number, hardLimit: number) {
  return {
    targetMiBPerTurn: target,
    hardLimitMiBPerTurn: hardLimit,
    targetMet: worst <= target,
    hardLimitMet: worst <= hardLimit,
  };
}

function canonicalWorkload() {
  return {
    densities: [...DEFAULT_DENSITIES],
    waves: DEFAULT_DENSITY_WAVES,
    history: {
      activeBytesPerTurn: DEFAULT_ACTIVE_HISTORY_BYTES,
      inactiveBytesPerTurn: DEFAULT_INACTIVE_HISTORY_BYTES,
      compactionTailBytesPerTurn: DEFAULT_COMPACTION_TAIL_BYTES,
      maxHistoryBytesPerTurn: MAX_HISTORY_BYTES_PER_TURN,
      productionActiveMaterializationLimits: PRODUCTION_ACTIVE_HISTORY_LIMITS,
      shape: historyRowShape(
        DEFAULT_ACTIVE_HISTORY_BYTES,
        DEFAULT_INACTIVE_HISTORY_BYTES,
        DEFAULT_HISTORY_ROW_PAYLOAD_BYTES,
        DEFAULT_COMPACTION_TAIL_BYTES,
      ),
    },
    plateauSeconds: 15,
    plateauSampleIntervalMs: 500,
    sampling: {
      baselineSamples: 5,
      settledSamples: 5,
      settleDelayMs: 1_000,
      timeoutMs: 300_000,
    },
    measurementIsolation: MEASUREMENT_ISOLATION,
    syntheticMix: {
      scenarios: SYNTHETIC_SCENARIOS,
      configuredWorkBytesPerTurn: 256 * 1024,
      allocatedWorkBytesByScenario: syntheticAllocatedWorkBytesByScenario(256 * 1024),
      toolBurst: 6,
      fanOut: 4,
      waitMs: 10,
      drainSteps: 4,
      modelProvider: "ScriptedModel",
      compactionSummarizer: "injected deterministic density gate",
      forcedCompaction: FORCED_COMPACTION_RULE,
      activeHistoryShrinkVerified: true,
      externalModelProviderCalled: false,
      azureInferenceCalled: false,
      realSandboxProviderCalled: false,
      note: "Tool and sandbox envelopes are bounded in-process shapes, not provider evidence.",
    },
  };
}

function settledGrowth(values: number[]) {
  const first = values[0] ?? 0;
  const last = values.at(-1) ?? first;
  return {
    waveCount: values.length,
    firstSettledRssMiB: rounded(first),
    lastSettledRssMiB: rounded(last),
    deltaMiB: rounded(last - first),
    slopeMiBPerWave: rounded(linearSlope(values)),
  };
}

function linearSlope(values: number[]): number {
  if (values.length < 2) return 0;
  const xMean = (values.length - 1) / 2;
  const yMean = values.reduce((sum, value) => sum + value, 0) / values.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < values.length; index += 1) {
    const xDelta = index - xMean;
    numerator += xDelta * (values[index]! - yMean);
    denominator += xDelta * xDelta;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

function summarizeMemory(samples: DensityMemorySample[]): MemorySummary {
  const rss = samples.map((sample) => sample.rss / MIB);
  const heap = samples.map((sample) => sample.heapUsed / MIB);
  const external = samples.map((sample) => sample.external / MIB);
  return {
    sampleCount: samples.length,
    rssMiBMedian: rounded(quantile(rss, 0.5)),
    rssMiBP95: rounded(quantile(rss, 0.95)),
    rssMiBP99: rounded(quantile(rss, 0.99)),
    rssMiBMax: rounded(Math.max(...rss)),
    heapUsedMiBMedian: rounded(quantile(heap, 0.5)),
    externalMiBMedian: rounded(quantile(external, 0.5)),
  };
}

async function sampleMemory(
  count: number,
  intervalMs: number,
  deadlineAt: number,
  label: string,
): Promise<DensityMemorySample[]> {
  const samples: DensityMemorySample[] = [];
  for (let index = 0; index < count; index += 1) {
    samples.push(process.memoryUsage());
    if (index + 1 < count) {
      await withDeadline(Bun.sleep(intervalMs), deadlineAt, `Timed out during ${label}`);
    }
  }
  return samples;
}

async function settleAndCollect(delayMs: number, deadlineAt: number): Promise<void> {
  Bun.gc(true);
  await withDeadline(Bun.sleep(delayMs), deadlineAt, "Timed out waiting for memory settlement");
  Bun.gc(true);
}

export async function cleanupDensityWorkspace(
  remove: () => Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("density workspace cleanup timeout must be a positive safe integer");
  }
  await withTimeout(
    Promise.resolve().then(remove),
    timeoutMs,
    `Timed out deleting density profile workspace after ${timeoutMs} ms`,
  );
}

export type DensityProfileVerification = {
  sha256: string;
  schemaVersion: 3;
  densities: number[];
  wavesPerDensity: number;
  rawMemorySamples: number;
  sessionsCreated: number;
  compactionCalls: number;
  verifiedCompactionHistoryShrinks: number;
  targetMet: boolean;
  hardLimitMet: boolean;
};

export type DensityProfileVerificationOptions = {
  /** The exact current deployment revision expected by the operator. */
  expectedProductionRevision?: string;
  /** Permit bounded smoke/pathological controls instead of the release profile. */
  allowNoncanonical?: boolean;
};

/** Recompute a schema-v3 artifact from its exact UTF-8 file contents. */
export function verifyDensityProfileArtifactText(
  text: string,
  expectedSha256?: string,
  options: DensityProfileVerificationOptions = {},
): DensityProfileVerification {
  const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
  if (expectedSha256 !== undefined) {
    const normalized = expectedSha256.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(normalized)) {
      throw new Error("Expected density artifact SHA-256 must be 64 hexadecimal characters");
    }
    if (sha256 !== normalized) {
      throw new Error(`Density artifact SHA-256 mismatch: expected ${normalized}, got ${sha256}`);
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Density artifact is not valid JSON: ${errorMessage(error)}`, { cause: error });
  }
  const root = artifactRecord(parsed, "artifact");
  if (artifactInteger(root.schemaVersion, "artifact.schemaVersion") !== 3) {
    throw new Error("Density artifact schemaVersion must be 3");
  }
  const allowNoncanonical = options.allowNoncanonical === true;
  const productionRevision = artifactString(root.productionRevision, "artifact.productionRevision");
  if (productionRevision.length === 0) {
    throw new Error("artifact.productionRevision must be a non-empty string");
  }
  const expectedProductionRevision = options.expectedProductionRevision?.trim();
  if (expectedProductionRevision !== undefined && expectedProductionRevision.length === 0) {
    throw new Error("Expected current production revision must be non-empty");
  }
  if (
    expectedProductionRevision !== undefined &&
    productionRevision !== expectedProductionRevision
  ) {
    throw new Error(
      `Density artifact productionRevision mismatch: expected ${expectedProductionRevision}, got ${productionRevision}`,
    );
  }
  if (!allowNoncanonical && expectedProductionRevision === undefined) {
    throw new Error(
      "Strict density verification requires the exact current production revision; pass --production-revision or opt into --allow-noncanonical",
    );
  }

  const workload = artifactRecord(root.workload, "artifact.workload");
  const configuredDensities = artifactNumberArray(
    workload.densities,
    "artifact.workload.densities",
  );
  const allowedDensities = new Set<number>(DEFAULT_DENSITIES);
  if (
    configuredDensities.length === 0 ||
    configuredDensities.some(
      (density) => !Number.isSafeInteger(density) || !allowedDensities.has(density),
    ) ||
    new Set(configuredDensities).size !== configuredDensities.length
  ) {
    throw new Error("Density artifact workload contains unsupported or duplicate densities");
  }
  const wavesPerDensity = boundedArtifactInteger(
    workload.waves,
    "artifact.workload.waves",
    1,
    MAX_WAVES,
  );
  const plateauSeconds = boundedArtifactInteger(
    workload.plateauSeconds,
    "artifact.workload.plateauSeconds",
    1,
    MAX_PLATEAU_SECONDS,
  );
  const plateauSampleIntervalMs = boundedArtifactInteger(
    workload.plateauSampleIntervalMs,
    "artifact.workload.plateauSampleIntervalMs",
    100,
    60_000,
  );
  const sampling = artifactRecord(workload.sampling, "artifact.workload.sampling");
  const baselineSampleCount = boundedArtifactInteger(
    sampling.baselineSamples,
    "artifact.workload.sampling.baselineSamples",
    1,
    MAX_SAMPLE_COUNT,
  );
  const settledSampleCount = boundedArtifactInteger(
    sampling.settledSamples,
    "artifact.workload.sampling.settledSamples",
    1,
    MAX_SAMPLE_COUNT,
  );
  boundedArtifactInteger(
    sampling.settleDelayMs,
    "artifact.workload.sampling.settleDelayMs",
    1,
    MAX_SETTLE_DELAY_MS,
  );
  boundedArtifactInteger(
    sampling.timeoutMs,
    "artifact.workload.sampling.timeoutMs",
    1,
    MAX_TIMEOUT_MS,
  );
  const plateauSampleCount = Math.max(
    2,
    Math.ceil((plateauSeconds * 1_000) / plateauSampleIntervalMs) + 1,
  );
  if (baselineSampleCount < 1 || settledSampleCount < 1 || plateauSampleIntervalMs <= 0) {
    throw new Error("Density artifact declares invalid sampling controls");
  }

  const history = artifactRecord(workload.history, "artifact.workload.history");
  const activeHistoryBytes = artifactInteger(
    history.activeBytesPerTurn,
    "artifact.workload.history.activeBytesPerTurn",
  );
  const inactiveHistoryBytes = artifactInteger(
    history.inactiveBytesPerTurn,
    "artifact.workload.history.inactiveBytesPerTurn",
  );
  const compactionTailBytes = artifactInteger(
    history.compactionTailBytesPerTurn,
    "artifact.workload.history.compactionTailBytesPerTurn",
  );
  if (
    artifactInteger(
      history.maxHistoryBytesPerTurn,
      "artifact.workload.history.maxHistoryBytesPerTurn",
    ) !== MAX_HISTORY_BYTES_PER_TURN
  ) {
    throw new Error(
      `artifact.workload.history.maxHistoryBytesPerTurn must equal ${MAX_HISTORY_BYTES_PER_TURN}`,
    );
  }
  assertArtifactEqual(
    history.productionActiveMaterializationLimits,
    PRODUCTION_ACTIVE_HISTORY_LIMITS,
    "artifact.workload.history.productionActiveMaterializationLimits",
  );
  const historyShape = artifactRecord(history.shape, "artifact.workload.history.shape");
  const rowPayloadTargetBytes = artifactInteger(
    historyShape.rowPayloadTargetBytes,
    "artifact.workload.history.shape.rowPayloadTargetBytes",
  );
  assertArtifactEqual(
    historyShape,
    historyRowShape(
      activeHistoryBytes,
      inactiveHistoryBytes,
      rowPayloadTargetBytes,
      compactionTailBytes,
    ),
    "artifact.workload.history.shape",
  );
  assertArtifactEqual(
    workload.measurementIsolation,
    MEASUREMENT_ISOLATION,
    "artifact.workload.measurementIsolation",
  );

  const syntheticMix = artifactRecord(workload.syntheticMix, "artifact.workload.syntheticMix");
  assertArtifactEqual(
    syntheticMix.scenarios,
    SYNTHETIC_SCENARIOS,
    "artifact.workload.syntheticMix.scenarios",
  );
  const configuredWorkBytes = boundedArtifactInteger(
    syntheticMix.configuredWorkBytesPerTurn,
    "artifact.workload.syntheticMix.configuredWorkBytesPerTurn",
    1,
    MAX_SYNTHETIC_WORK_BYTES_PER_TURN,
  );
  boundedArtifactInteger(
    syntheticMix.toolBurst,
    "artifact.workload.syntheticMix.toolBurst",
    1,
    MAX_SYNTHETIC_ITEMS,
  );
  boundedArtifactInteger(
    syntheticMix.fanOut,
    "artifact.workload.syntheticMix.fanOut",
    1,
    MAX_SYNTHETIC_ITEMS,
  );
  boundedArtifactInteger(
    syntheticMix.waitMs,
    "artifact.workload.syntheticMix.waitMs",
    0,
    MAX_SYNTHETIC_WAIT_MS,
  );
  boundedArtifactInteger(
    syntheticMix.drainSteps,
    "artifact.workload.syntheticMix.drainSteps",
    1,
    MAX_SYNTHETIC_ITEMS,
  );
  assertArtifactEqual(
    syntheticMix.allocatedWorkBytesByScenario,
    syntheticAllocatedWorkBytesByScenario(configuredWorkBytes),
    "artifact.workload.syntheticMix.allocatedWorkBytesByScenario",
  );
  assertArtifactEqual(
    syntheticMix.forcedCompaction,
    FORCED_COMPACTION_RULE,
    "artifact.workload.syntheticMix.forcedCompaction",
  );
  if (syntheticMix.activeHistoryShrinkVerified !== true) {
    throw new Error("Density artifact must verify active-history shrink after forced compaction");
  }
  assertArtifactEqual(
    {
      modelProvider: syntheticMix.modelProvider,
      compactionSummarizer: syntheticMix.compactionSummarizer,
      externalModelProviderCalled: syntheticMix.externalModelProviderCalled,
      azureInferenceCalled: syntheticMix.azureInferenceCalled,
      realSandboxProviderCalled: syntheticMix.realSandboxProviderCalled,
      note: syntheticMix.note,
    },
    {
      modelProvider: "ScriptedModel",
      compactionSummarizer: "injected deterministic density gate",
      externalModelProviderCalled: false,
      azureInferenceCalled: false,
      realSandboxProviderCalled: false,
      note: "Tool and sandbox envelopes are bounded in-process shapes, not provider evidence.",
    },
    "artifact.workload.syntheticMix.providerIsolation",
  );

  const rootThresholds = artifactRecord(root.thresholds, "artifact.thresholds");
  const targetMiBPerTurn = artifactNumber(
    rootThresholds.targetMiBPerTurn,
    "artifact.thresholds.targetMiBPerTurn",
  );
  const hardLimitMiBPerTurn = artifactNumber(
    rootThresholds.hardLimitMiBPerTurn,
    "artifact.thresholds.hardLimitMiBPerTurn",
  );
  if (targetMiBPerTurn <= 0 || hardLimitMiBPerTurn < targetMiBPerTurn) {
    throw new Error("Density artifact declares invalid memory thresholds");
  }
  if (!allowNoncanonical) {
    assertArtifactEqual(workload, canonicalWorkload(), "artifact.workload");
    assertArtifactEqual(
      { targetMiBPerTurn, hardLimitMiBPerTurn },
      { targetMiBPerTurn: 50, hardLimitMiBPerTurn: 100 },
      "artifact.thresholds.controls",
    );
  }

  const densityRows = artifactArray(root.densities, "artifact.densities");
  if (densityRows.length !== configuredDensities.length) {
    throw new Error("Density artifact result count does not match workload.densities");
  }
  const aggregateIncremental: number[] = [];
  let rawMemorySamples = 0;
  const verifiedDensityThresholds: Array<ReturnType<typeof thresholdResult>> = [];

  densityRows.forEach((densityValue, densityIndex) => {
    const path = `artifact.densities[${densityIndex}]`;
    const densityRow = artifactRecord(densityValue, path);
    const density = artifactInteger(densityRow.density, `${path}.density`);
    if (density !== configuredDensities[densityIndex]) {
      throw new Error(`${path}.density does not match workload density order`);
    }
    const waveRows = artifactArray(densityRow.waves, `${path}.waves`);
    if (waveRows.length !== wavesPerDensity) {
      throw new Error(`${path}.waves does not contain ${wavesPerDensity} waves`);
    }

    const densityIncremental: number[] = [];
    const densityRetained: number[] = [];
    const densityPlateauToSettled: number[] = [];
    const settledMedians: number[] = [];

    waveRows.forEach((waveValue, waveIndex) => {
      const wavePath = `${path}.waves[${waveIndex}]`;
      const wave = artifactRecord(waveValue, wavePath);
      if (artifactInteger(wave.wave, `${wavePath}.wave`) !== waveIndex) {
        throw new Error(`${wavePath}.wave is not the expected zero-based wave index`);
      }
      const expectedCompactionCalls = expectedCompactionCallsForDensity(density);
      if (
        artifactInteger(wave.compactionCalls, `${wavePath}.compactionCalls`) !==
        expectedCompactionCalls
      ) {
        throw new Error(
          `${wavePath}.compactionCalls must equal ${expectedCompactionCalls} for density ${density}`,
        );
      }
      if (
        artifactInteger(
          wave.verifiedCompactionHistoryShrinks,
          `${wavePath}.verifiedCompactionHistoryShrinks`,
        ) !== expectedCompactionCalls
      ) {
        throw new Error(
          `${wavePath}.verifiedCompactionHistoryShrinks must equal ${expectedCompactionCalls} ` +
            `for density ${density}`,
        );
      }
      const rawSamples = artifactRecord(wave.rawSamples, `${wavePath}.rawSamples`);
      const rawMemory = artifactRecord(rawSamples.memory, `${wavePath}.rawSamples.memory`);
      const baselineSamples = artifactMemorySamples(
        rawMemory.baseline,
        `${wavePath}.rawSamples.memory.baseline`,
      );
      const plateauSamples = artifactMemorySamples(
        rawMemory.plateau,
        `${wavePath}.rawSamples.memory.plateau`,
      );
      const settledSamples = artifactMemorySamples(
        rawMemory.settled,
        `${wavePath}.rawSamples.memory.settled`,
      );
      if (
        baselineSamples.length !== baselineSampleCount ||
        plateauSamples.length !== plateauSampleCount ||
        settledSamples.length !== settledSampleCount
      ) {
        throw new Error(`${wavePath} raw memory sample counts do not match workload sampling`);
      }
      rawMemorySamples += baselineSamples.length + plateauSamples.length + settledSamples.length;

      const baseline = summarizeMemory(baselineSamples);
      const plateau = summarizeMemory(plateauSamples);
      const settled = summarizeMemory(settledSamples);
      const memory = artifactRecord(wave.memory, `${wavePath}.memory`);
      assertArtifactEqual(memory.baseline, baseline, `${wavePath}.memory.baseline`);
      assertArtifactEqual(memory.plateau, plateau, `${wavePath}.memory.plateau`);
      assertArtifactEqual(memory.settled, settled, `${wavePath}.memory.settled`);

      const incrementalValues = plateauSamples.map(
        (sample) => Math.max(0, sample.rss / MIB - baseline.rssMiBMedian) / density,
      );
      const retainedValues = [(settled.rssMiBMedian - baseline.rssMiBMedian) / density];
      const plateauToSettledValues = plateauSamples.map(
        (sample) => sample.rss / MIB - settled.rssMiBMedian,
      );
      assertArtifactEqual(
        rawSamples.incrementalRssMiBPerTurn,
        incrementalValues,
        `${wavePath}.rawSamples.incrementalRssMiBPerTurn`,
      );
      assertArtifactEqual(
        rawSamples.retainedAfterSettlementMiBPerTurn,
        retainedValues,
        `${wavePath}.rawSamples.retainedAfterSettlementMiBPerTurn`,
      );
      assertArtifactEqual(
        rawSamples.plateauToSettledMiB,
        plateauToSettledValues,
        `${wavePath}.rawSamples.plateauToSettledMiB`,
      );
      assertArtifactEqual(
        wave.incrementalRssMiBPerTurn,
        summarizeNumbers(incrementalValues),
        `${wavePath}.incrementalRssMiBPerTurn`,
      );
      const waveLeak = artifactRecord(wave.leak, `${wavePath}.leak`);
      assertArtifactEqual(
        waveLeak.retainedAfterSettlementMiBPerTurn,
        summarizeNumbers(retainedValues),
        `${wavePath}.leak.retainedAfterSettlementMiBPerTurn`,
      );
      assertArtifactEqual(
        waveLeak.plateauToSettledMiB,
        summarizeNumbers(plateauToSettledValues),
        `${wavePath}.leak.plateauToSettledMiB`,
      );

      densityIncremental.push(...incrementalValues);
      densityRetained.push(...retainedValues);
      densityPlateauToSettled.push(...plateauToSettledValues);
      settledMedians.push(settled.rssMiBMedian);
    });

    const expectedStatistics = {
      incrementalRssMiBPerTurn: summarizeNumbers(densityIncremental),
      leak: {
        retainedAfterSettlementMiBPerTurn: summarizeNumbers(densityRetained),
        plateauToSettledMiB: summarizeNumbers(densityPlateauToSettled),
        settledGrowthMiB: settledGrowth(settledMedians),
      },
    };
    assertArtifactEqual(densityRow.statistics, expectedStatistics, `${path}.statistics`);
    const expectedThresholds = thresholdResult(
      expectedStatistics.incrementalRssMiBPerTurn.worst,
      targetMiBPerTurn,
      hardLimitMiBPerTurn,
    );
    assertArtifactEqual(densityRow.thresholds, expectedThresholds, `${path}.thresholds`);
    verifiedDensityThresholds.push(expectedThresholds);
    aggregateIncremental.push(...densityIncremental);
  });

  assertArtifactEqual(
    root.statistics,
    { incrementalRssMiBPerTurn: summarizeNumbers(aggregateIncremental) },
    "artifact.statistics",
  );
  const expectedRootThresholds = {
    targetMiBPerTurn,
    hardLimitMiBPerTurn,
    targetMet: verifiedDensityThresholds.every((result) => result.targetMet),
    hardLimitMet: verifiedDensityThresholds.every((result) => result.hardLimitMet),
  };
  assertArtifactEqual(root.thresholds, expectedRootThresholds, "artifact.thresholds");

  const cleanup = artifactRecord(root.cleanup, "artifact.cleanup");
  const expectedSessions = configuredDensities.reduce(
    (total, density) => total + density * wavesPerDensity,
    0,
  );
  const expectedCompactionCalls = configuredDensities.reduce(
    (total, density) => total + expectedCompactionCallsForDensity(density) * wavesPerDensity,
    0,
  );
  assertArtifactEqual(
    cleanup,
    {
      workspacesCreated: 1,
      workspacesDeleted: 1,
      sessionsCreated: expectedSessions,
    },
    "artifact.cleanup",
  );

  return {
    sha256,
    schemaVersion: 3,
    densities: configuredDensities,
    wavesPerDensity,
    rawMemorySamples,
    sessionsCreated: expectedSessions,
    compactionCalls: expectedCompactionCalls,
    verifiedCompactionHistoryShrinks: expectedCompactionCalls,
    targetMet: expectedRootThresholds.targetMet,
    hardLimitMet: expectedRootThresholds.hardLimitMet,
  };
}

type ArtifactRecord = Record<string, unknown>;

function artifactRecord(value: unknown, path: string): ArtifactRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as ArtifactRecord;
}

function artifactArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value;
}

function artifactNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
}

function artifactString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  return value;
}

function artifactInteger(value: unknown, path: string): number {
  const number = artifactNumber(value, path);
  if (!Number.isSafeInteger(number)) throw new Error(`${path} must be a safe integer`);
  return number;
}

function boundedArtifactInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  const number = artifactInteger(value, path);
  if (number < minimum || number > maximum) {
    throw new Error(`${path} must be between ${minimum} and ${maximum}`);
  }
  return number;
}

function artifactNumberArray(value: unknown, path: string): number[] {
  return artifactArray(value, path).map((item, index) => artifactNumber(item, `${path}[${index}]`));
}

function artifactMemorySamples(value: unknown, path: string): DensityMemorySample[] {
  return artifactArray(value, path).map((sampleValue, index) => {
    const samplePath = `${path}[${index}]`;
    const sample = artifactRecord(sampleValue, samplePath);
    return {
      rss: artifactNumber(sample.rss, `${samplePath}.rss`),
      heapTotal: artifactNumber(sample.heapTotal, `${samplePath}.heapTotal`),
      heapUsed: artifactNumber(sample.heapUsed, `${samplePath}.heapUsed`),
      external: artifactNumber(sample.external, `${samplePath}.external`),
      arrayBuffers: artifactNumber(sample.arrayBuffers, `${samplePath}.arrayBuffers`),
    };
  });
}

function assertArtifactEqual(actual: unknown, expected: unknown, path: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${path} does not match raw-sample recomputation: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function writeArtifact(path: string | undefined, result: unknown): Promise<void> {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.error(`Wrote density profile artifact to ${path}`);
}

function densityProfileSettings(productionSettings: Settings): Settings {
  return {
    ...productionSettings,
    environment: `${productionSettings.environment}-density-profile`,
    billingMode: "disabled",
    entitlementsMode: "none",
    usageLimitsMode: "none",
    openaiProvider: "openai",
    openaiApiKey: undefined,
    openaiModel: "scripted-density-model",
    openaiAllowedModels: "scripted-density-model",
    modelPricingJson: JSON.stringify({
      "scripted-density-model": {
        inputMicrosPerMillionTokens: 0,
        outputMicrosPerMillionTokens: 0,
      },
    }),
    modelProvidersJson: "[]",
    mcpServers: [],
    codexSubscriptionEnabled: false,
    codexCredentialLeasingEnabled: false,
    webSearchEnabled: false,
    sandboxBackend: "none",
    sandboxOwnershipEnabled: false,
    sandboxLazyProvisionEnabled: false,
    sandboxDesktopEnabled: false,
    computerUseEnabled: false,
    recordingEnabled: false,
    workspaceCaptureEnabled: false,
    integrationsEnabled: false,
    toolspaceEnabled: false,
  };
}

function positiveIntegerFromEnv(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const value = integerFromEnv(env, name, fallback);
  if (value <= 0) throw new Error(`${name} must be greater than zero`);
  return value;
}

function nonnegativeIntegerFromEnv(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const value = integerFromEnv(env, name, fallback);
  if (value < 0) throw new Error(`${name} must not be negative`);
  return value;
}

function boundedPositiveInteger(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const value = positiveIntegerFromEnv(env, name, fallback);
  if (value > maximum) throw new Error(`${name} must be at most ${maximum}`);
  return value;
}

function boundedNonnegativeInteger(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const value = nonnegativeIntegerFromEnv(env, name, fallback);
  if (value > maximum) throw new Error(`${name} must be at most ${maximum}`);
  return value;
}

function boundedIntegerRange(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = integerFromEnv(env, name, fallback);
  if (value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function integerFromEnv(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer`);
  return value;
}

function positiveNumberFromEnv(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}

export async function withTimeout<T>(
  work: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function withDeadline<T>(
  work: Promise<T>,
  deadlineAt: number,
  message: string,
): Promise<T> {
  if (!Number.isFinite(deadlineAt)) throw new Error("deadlineAt must be finite");
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    void work.catch(() => undefined);
    throw new Error(message);
  }
  return await withTimeout(work, remainingMs, message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  await main();
}
