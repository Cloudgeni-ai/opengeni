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
  withWorkspaceRls,
} from "@opengeni/db";
import * as schema from "@opengeni/db/schema";
import { createProductionAgentRuntime } from "@opengeni/runtime";
import { MemoryEventBus, ScriptedModel, type ScriptedModelStep } from "@opengeni/testing";
import { createTurnActivities } from "../../apps/worker/src/activities";

const MIB = 1024 * 1024;
const MAX_HISTORY_BYTES_PER_TURN = 32 * MIB;
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

type MemorySample = ReturnType<typeof process.memoryUsage>;

type WaveMeasurement = {
  wave: number;
  baseline: MemorySummary;
  plateau: MemorySummary;
  settled: MemorySummary;
  incrementalValues: number[];
  retainedValues: number[];
  plateauToSettledValues: number[];
};

type DensityMeasurement = {
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
      }
      densityMeasurements.push({ density, waves });
    }

    const result = buildProfileResult({
      config,
      runId,
      productionRevision: productionSettings.deploymentRevision,
      densityMeasurements,
    });
    await writeArtifact(config.artifactPath, result);
    console.log(`OPENGENI_DENSITY_RESULT=${JSON.stringify(result)}`);
    if (!result.thresholds.hardLimitMet) process.exitCode = 2;
  } finally {
    if (workspaceId) {
      await deleteWorkspace(dbClient.db, workspaceId).catch((error) => {
        console.error(`Density workspace cleanup failed: ${errorMessage(error)}`);
        process.exitCode = 1;
      });
    }
    await dbClient.close();
  }
}

async function runWave(input: {
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
    objectStorage: null,
  });
  const turnInputs = [];
  let allRuns: Promise<PromiseSettledResult<unknown>[]> | null = null;

  try {
    for (let index = 0; index < density; index += 1) {
      const session = await createSession(db, {
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
      });
      await seedHistory({
        db,
        accountId,
        workspaceId,
        sessionId: session.id,
        sessionIndex: index,
        activeBytes: config.activeHistoryBytes,
        inactiveBytes: config.inactiveHistoryBytes,
        compactionTailBytes: config.compactionTailBytes,
      });
      const [trigger] = await appendSessionEvents(db, workspaceId, session.id, [
        { type: "user.message", payload: { text: session.initialMessage } },
      ]);
      if (!trigger) throw new Error(`Failed to append trigger for density session ${session.id}`);
      const workflowId = `density-profile-${runId}-${density}-${wave}-${index}`;
      await enqueueSessionTurn(db, {
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
      });
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

    await settleAndCollect(config.settleDelayMs);
    const baseline = summarizeMemory(await sampleMemory(config.baselineSamples, 250));
    const runs = turnInputs.map((turnInput) => activities.runAgentTurn(turnInput));
    allRuns = Promise.allSettled(runs);
    await withTimeout(
      Promise.race([
        model.allStarted,
        allRuns.then((results) => {
          const rejected = results.find((result) => result.status === "rejected");
          throw (
            rejected?.reason ?? new Error("Density turns settled before reaching the model gate")
          );
        }),
      ]),
      config.timeoutMs,
      `Timed out waiting for density ${density} wave ${wave}`,
    );

    const plateauSampleCount = Math.max(
      2,
      Math.ceil((config.plateauSeconds * 1_000) / config.plateauSampleIntervalMs) + 1,
    );
    const plateauSamples = await sampleMemory(plateauSampleCount, config.plateauSampleIntervalMs);
    model.release();
    const results = await allRuns;
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
    await settleAndCollect(config.settleDelayMs);
    const settledSamples = await sampleMemory(config.settledSamples, 250);
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
      baseline,
      plateau,
      settled,
      incrementalValues,
      retainedValues: [retainedValue / density],
      plateauToSettledValues,
    };
  } finally {
    model.release();
    if (allRuns) await allRuns;
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

    release(): void {
      if (this.released) return;
      this.released = true;
      this.resolveGate();
    }

    clearRequests(): void {
      this.delegate.requests.length = 0;
    }

    private async arrive(request: Parameters<ScriptedModel["getStreamedResponse"]>[0]) {
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

function buildProfileResult(input: {
  config: DensityProfileConfig;
  runId: string;
  productionRevision: string;
  densityMeasurements: DensityMeasurement[];
}) {
  const { config, runId, productionRevision, densityMeasurements } = input;
  const densityResults = densityMeasurements.map(({ density, waves }) => {
    const incrementalValues = waves.flatMap((wave) => wave.incrementalValues);
    const retainedValues = waves.flatMap((wave) => wave.retainedValues);
    const plateauToSettledValues = waves.flatMap((wave) => wave.plateauToSettledValues);
    const settledMedians = waves.map((wave) => wave.settled.rssMiBMedian);
    return {
      density,
      waves: waves.map((wave) => ({
        wave: wave.wave,
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
    schemaVersion: 2,
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
      syntheticMix: {
        scenarios: SYNTHETIC_SCENARIOS,
        workBytesPerTurn: config.syntheticWorkBytes,
        toolBurst: config.syntheticToolBurst,
        fanOut: config.syntheticFanOut,
        waitMs: config.syntheticWaitMs,
        drainSteps: config.syntheticDrainSteps,
        modelProvider: "ScriptedModel",
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

function summarizeMemory(samples: MemorySample[]): MemorySummary {
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

async function sampleMemory(count: number, intervalMs: number): Promise<MemorySample[]> {
  const samples: MemorySample[] = [];
  for (let index = 0; index < count; index += 1) {
    samples.push(process.memoryUsage());
    if (index + 1 < count) await Bun.sleep(intervalMs);
  }
  return samples;
}

async function settleAndCollect(delayMs: number): Promise<void> {
  Bun.gc(true);
  await Bun.sleep(delayMs);
  Bun.gc(true);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  await main();
}
