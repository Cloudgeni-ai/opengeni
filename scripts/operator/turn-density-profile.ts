import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { dbSearchPath, getSettings, type Settings } from "@opengeni/config";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  createDb,
  createSession,
  deleteWorkspace,
  enqueueSessionTurn,
  ACTIVE_SESSION_HISTORY_MAX_JSON_BYTES,
  withWorkspaceRls,
} from "@opengeni/db";
import * as schema from "@opengeni/db/schema";
import { createProductionAgentRuntime } from "@opengeni/runtime";
import { MemoryEventBus, ScriptedModel, type ScriptedModelStep } from "@opengeni/testing";
import { createTurnActivities } from "../../apps/worker/src/activities";

const MIB = 1024 * 1024;
const MAX_HISTORY_BYTES_PER_TURN = ACTIVE_SESSION_HISTORY_MAX_JSON_BYTES;
const MAX_SYNTHETIC_WORK_BYTES_PER_TURN = 2 * MIB;
const MAX_WAVES = 10;
const MAX_PLATEAU_SECONDS = 300;
const MAX_SAMPLE_COUNT = 100;
const MAX_SETTLE_DELAY_MS = 60_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
const MAX_SYNTHETIC_ITEMS = 1_024;
const MAX_SYNTHETIC_WAIT_MS = 60_000;

export const DEFAULT_DENSITIES = [1, 2, 4, 8, 12, 16, 24, 32] as const;
export const SYNTHETIC_SCENARIOS = [
  "streaming",
  "tool-burst",
  "sandbox",
  "fan-out",
  "wait",
  "drain",
] as const;

export type SyntheticScenario = (typeof SYNTHETIC_SCENARIOS)[number];

export type DensityProfileConfig = {
  densities: number[];
  waves: number;
  activeHistoryBytes: number;
  inactiveHistoryBytes: number;
  compactionTailBytes: number;
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

export type WaveMeasurement = {
  wave: number;
  compactionCalls: number;
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

/**
 * Parse the allowed density candidates. The default is intentionally the exact
 * OPE-52 sweep; custom profiles may select/reorder those candidates but may not
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
    750_000,
    MAX_HISTORY_BYTES_PER_TURN,
  );
  const inactiveHistoryBytes = boundedNonnegativeInteger(
    env,
    "OPENGENI_DENSITY_INACTIVE_HISTORY_BYTES",
    8 * MIB,
    MAX_HISTORY_BYTES_PER_TURN,
  );
  const compactionTailBytes = boundedPositiveInteger(
    env,
    "OPENGENI_DENSITY_COMPACTION_TAIL_BYTES",
    Math.min(200_000, activeHistoryBytes),
    activeHistoryBytes,
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
    waves: boundedPositiveInteger(env, "OPENGENI_DENSITY_WAVES", 3, MAX_WAVES),
    activeHistoryBytes,
    inactiveHistoryBytes,
    compactionTailBytes,
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
    timeoutMs: boundedPositiveInteger(env, "OPENGENI_DENSITY_TIMEOUT_MS", 120_000, MAX_TIMEOUT_MS),
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
      await phase(
        seedHistory({
          db,
          accountId,
          workspaceId,
          sessionId: session.id,
          sessionIndex: index,
          activeBytes: config.activeHistoryBytes,
          inactiveBytes: config.inactiveHistoryBytes,
          compactionTailBytes: config.compactionTailBytes,
        }),
        "history seeding",
      );
      const [trigger] = await phase(
        appendSessionEvents(db, workspaceId, session.id, [
          { type: "user.message", payload: { text: session.initialMessage } },
        ]),
        "trigger creation",
      );
      if (!trigger) throw new Error(`Failed to append trigger for density session ${session.id}`);
      const workflowId = `density-profile-${runId}-${density}-${wave}-${index}`;
      await phase(
        enqueueSessionTurn(db, {
          accountId,
          workspaceId,
          sessionId: session.id,
          triggerEventId: trigger.id,
          temporalWorkflowId: workflowId,
          source: "user",
          prompt: session.initialMessage,
          resources: [],
          tools: [],
          model: "scripted-density-model",
          reasoningEffort: "low",
          sandboxBackend: "none",
          metadata: { densityProfileRunId: runId, density, wave, turnIndex: index },
          placement: "tail",
        }),
        "turn enqueue",
      );
      turnInputs.push({
        accountId,
        workspaceId,
        sessionId: session.id,
        workflowId,
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
          const rejected = results.find((result) => result.status === "rejected");
          throw (
            rejected?.reason ?? new Error("Density turns settled before reaching the model gate")
          );
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
          ? [{ index, error: `unexpected activity status ${String(result.value.status)}` }]
          : [],
    );
    if (failures.length > 0) {
      throw new Error(`Density activity failures: ${JSON.stringify(failures)}`);
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
      baseline,
      plateau,
      settled,
      incrementalValues,
      retainedValues: [retainedValue / density],
      plateauToSettledValues,
      rawMemory: { baseline: baselineSamples, plateau: plateauSamples, settled: settledSamples },
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

async function seedHistory(input: {
  db: Parameters<typeof withWorkspaceRls>[0];
  accountId: string;
  workspaceId: string;
  sessionId: string;
  sessionIndex: number;
  activeBytes: number;
  inactiveBytes: number;
  compactionTailBytes: number;
}): Promise<void> {
  const activeRows = historyRows(input, input.activeBytes, true, 0, input.compactionTailBytes);
  const inactiveRows = historyRows(input, input.inactiveBytes, false, activeRows.length, 0);
  for (const rows of chunks([...inactiveRows, ...activeRows], 25)) {
    await withWorkspaceRls(input.db, input.workspaceId, async (db) => {
      await db.insert(schema.sessionHistoryItems).values(rows);
    });
  }
}

function historyRows(
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    sessionIndex: number;
  },
  totalBytes: number,
  active: boolean,
  positionOffset: number,
  compactionTailBytes: number,
) {
  if (totalBytes === 0) return [];
  const chunkBytes = 32_000;
  const itemCount = Math.max(1, Math.ceil(totalBytes / chunkBytes));
  const payloadBytes = Math.max(1, Math.floor(totalBytes / itemCount) - 200);
  const tailCount = active ? Math.max(1, Math.ceil(compactionTailBytes / chunkBytes)) : 0;
  return Array.from({ length: itemCount }, (_, itemIndex) => {
    const isCompactionTail = active && itemIndex >= itemCount - tailCount;
    const isCheckpoint = active && itemIndex === 0;
    const role = isCompactionTail ? "user" : itemIndex % 2 === 0 ? "user" : "assistant";
    return {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      position: positionOffset + itemIndex,
      active,
      item: {
        type: "message",
        role,
        status: "completed",
        content: [
          {
            type: role === "user" ? "input_text" : "output_text",
            text: deterministicText(input.sessionIndex, itemIndex, payloadBytes),
          },
        ],
        ...(isCheckpoint
          ? {
              providerData: {
                densityProfile: {
                  shape: "compaction-checkpoint",
                  bounded: true,
                  tailBytes: compactionTailBytes,
                },
              },
            }
          : {}),
      },
    };
  });
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

    constructor() {
      this.allStarted = new Promise((resolve) => {
        this.resolveAllStarted = resolve;
      });
      this.gate = new Promise((resolve) => {
        this.resolveGate = resolve;
      });
      this.delegate = new ScriptedModel([syntheticModelStep()]);
    }

    async getResponse(request: Parameters<ScriptedModel["getResponse"]>[0]) {
      await this.arrive(request);
      return await this.delegate.getResponse(request);
    }

    async *getStreamedResponse(request: Parameters<ScriptedModel["getStreamedResponse"]>[0]) {
      await this.arrive(request);
      yield* this.delegate.getStreamedResponse(request);
    }

    readonly summarizeForCompaction = async (
      _settings: Settings,
      input: Array<Record<string, unknown>>,
    ): Promise<string> => {
      this.compactionCalls += 1;
      await this.arrive({ input });
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

    private async arrive(request: { input?: unknown }) {
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
      const turnIndex = this.started;
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
      retained.push({ streamChunks: ["delta-1", "delta-2", "delta-3"], buffers });
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
    runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
    workload: {
      densities: config.densities,
      waves: config.waves,
      history: {
        activeBytesPerTurn: config.activeHistoryBytes,
        inactiveBytesPerTurn: config.inactiveHistoryBytes,
        compactionTailBytesPerTurn: config.compactionTailBytes,
        maxHistoryBytesPerTurn: MAX_HISTORY_BYTES_PER_TURN,
      },
      plateauSeconds: config.plateauSeconds,
      plateauSampleIntervalMs: config.plateauSampleIntervalMs,
      sampling: {
        baselineSamples: config.baselineSamples,
        settledSamples: config.settledSamples,
        settleDelayMs: config.settleDelayMs,
        timeoutMs: config.timeoutMs,
      },
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
  targetMet: boolean;
  hardLimitMet: boolean;
};

/** Recompute a schema-v3 artifact from its exact UTF-8 file contents. */
export function verifyDensityProfileArtifactText(
  text: string,
  expectedSha256?: string,
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
  const wavesPerDensity = artifactInteger(workload.waves, "artifact.workload.waves");
  if (wavesPerDensity < 1) throw new Error("Density artifact workload.waves must be positive");
  const plateauSeconds = artifactNumber(
    workload.plateauSeconds,
    "artifact.workload.plateauSeconds",
  );
  const plateauSampleIntervalMs = artifactNumber(
    workload.plateauSampleIntervalMs,
    "artifact.workload.plateauSampleIntervalMs",
  );
  const sampling = artifactRecord(workload.sampling, "artifact.workload.sampling");
  const baselineSampleCount = artifactInteger(
    sampling.baselineSamples,
    "artifact.workload.sampling.baselineSamples",
  );
  const settledSampleCount = artifactInteger(
    sampling.settledSamples,
    "artifact.workload.sampling.settledSamples",
  );
  const plateauSampleCount = Math.max(
    2,
    Math.ceil((plateauSeconds * 1_000) / plateauSampleIntervalMs) + 1,
  );
  if (baselineSampleCount < 1 || settledSampleCount < 1 || plateauSampleIntervalMs <= 0) {
    throw new Error("Density artifact declares invalid sampling controls");
  }

  const syntheticMix = artifactRecord(workload.syntheticMix, "artifact.workload.syntheticMix");
  assertArtifactEqual(
    syntheticMix.scenarios,
    SYNTHETIC_SCENARIOS,
    "artifact.workload.syntheticMix.scenarios",
  );
  const configuredWorkBytes = artifactInteger(
    syntheticMix.configuredWorkBytesPerTurn,
    "artifact.workload.syntheticMix.configuredWorkBytesPerTurn",
  );
  assertArtifactEqual(
    syntheticMix.allocatedWorkBytesByScenario,
    syntheticAllocatedWorkBytesByScenario(configuredWorkBytes),
    "artifact.workload.syntheticMix.allocatedWorkBytesByScenario",
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
  assertArtifactEqual(
    cleanup,
    { workspacesCreated: 1, workspacesDeleted: 1, sessionsCreated: expectedSessions },
    "artifact.cleanup",
  );

  return {
    sha256,
    schemaVersion: 3,
    densities: configuredDensities,
    wavesPerDensity,
    rawMemorySamples,
    sessionsCreated: expectedSessions,
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

function artifactInteger(value: unknown, path: string): number {
  const number = artifactNumber(value, path);
  if (!Number.isSafeInteger(number)) throw new Error(`${path} must be a safe integer`);
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

function chunks<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    out.push(values.slice(index, index + size));
  }
  return out;
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
