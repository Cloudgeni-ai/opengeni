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
import { MemoryEventBus, ScriptedModel } from "@opengeni/testing";
import { createTurnActivities } from "../../apps/worker/src/activities";

const MIB = 1024 * 1024;
const concurrency = positiveInteger("OPENGENI_DENSITY_CONCURRENCY", 16);
const activeHistoryBytes = positiveInteger("OPENGENI_DENSITY_ACTIVE_HISTORY_BYTES", 750_000);
const inactiveHistoryBytes = nonnegativeInteger("OPENGENI_DENSITY_INACTIVE_HISTORY_BYTES", 8 * MIB);
const plateauSeconds = positiveInteger("OPENGENI_DENSITY_PLATEAU_SECONDS", 15);
const hardLimitMiB = positiveNumber("OPENGENI_DENSITY_HARD_LIMIT_MIB_PER_TURN", 100);
const targetMiB = positiveNumber("OPENGENI_DENSITY_TARGET_MIB_PER_TURN", 50);
const runId = crypto.randomUUID();

const productionSettings = getSettings();
const settings: Settings = {
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

const searchPath = dbSearchPath(settings);
const dbClient = createDb(settings.databaseUrl, {
  ...(searchPath ? { searchPath } : {}),
  rlsStrategy: settings.rlsStrategy,
});
const bus = new MemoryEventBus();
const model = createGatedDensityModel(concurrency);
const activities = createTurnActivities({
  settings,
  db: dbClient.db,
  bus,
  runtime: createProductionAgentRuntime({ model }),
  objectStorage: null,
});

let workspaceId: string | null = null;
let accountId: string | null = null;
let runs: Array<Promise<unknown>> = [];

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
  if (!grant?.workspaceId) throw new Error("Density profile workspace bootstrap returned no grant");
  workspaceId = grant.workspaceId;
  accountId = grant.accountId;

  const turnInputs = [];
  for (let index = 0; index < concurrency; index += 1) {
    const session = await createSession(dbClient.db, {
      accountId,
      workspaceId,
      initialMessage: `density profile prompt ${index}`,
      resources: [],
      tools: [],
      metadata: {},
      model: "scripted-density-model",
      sandboxBackend: "none",
    });
    await seedHistory({
      accountId,
      workspaceId,
      sessionId: session.id,
      sessionIndex: index,
      activeBytes: activeHistoryBytes,
      inactiveBytes: inactiveHistoryBytes,
    });
    const [trigger] = await appendSessionEvents(dbClient.db, workspaceId, session.id, [
      { type: "user.message", payload: { text: session.initialMessage } },
    ]);
    if (!trigger) throw new Error(`Failed to append trigger for density session ${session.id}`);
    const workflowId = `density-profile-${runId}-${index}`;
    await enqueueSessionTurn(dbClient.db, {
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
      metadata: { densityProfileRunId: runId },
      placement: "tail",
    });
    turnInputs.push({
      accountId,
      workspaceId,
      sessionId: session.id,
      workflowId,
      attemptId: crypto.randomUUID(),
      trigger: { kind: "next" } as const,
    });
  }

  await settleAndCollect();
  const baseline = summarizeMemory(await sampleMemory(5, 250));
  runs = turnInputs.map((input) => activities.runAgentTurn(input));
  const allRuns = Promise.allSettled(runs);
  await Promise.race([
    model.allStarted,
    allRuns.then((results) => {
      const rejected = results.find((result) => result.status === "rejected");
      throw rejected?.reason ?? new Error("Density turns settled before reaching the model gate");
    }),
    timeout(120_000, "Timed out waiting for every density turn to reach the model gate"),
  ]);

  const plateau = summarizeMemory(await sampleMemory(plateauSeconds * 2, 500));
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
  await settleAndCollect();
  const settled = summarizeMemory(await sampleMemory(5, 250));
  const incrementalMiBPerTurn = (plateau.rssMiBMax - baseline.rssMiBMedian) / concurrency;
  const result = {
    schemaVersion: 1,
    runId,
    productionRevision: productionSettings.deploymentRevision,
    runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
    workload: {
      concurrency,
      activeHistoryBytesPerTurn: activeHistoryBytes,
      inactiveHistoryBytesPerTurn: inactiveHistoryBytes,
      plateauSeconds,
    },
    memory: {
      baseline,
      plateau,
      settled,
      incrementalMiBPerTurn: rounded(incrementalMiBPerTurn),
      retainedMiBAfterSettlement: rounded(settled.rssMiBMedian - baseline.rssMiBMedian),
    },
    thresholds: {
      targetMiBPerTurn: targetMiB,
      hardLimitMiBPerTurn: hardLimitMiB,
      targetMet: incrementalMiBPerTurn <= targetMiB,
      hardLimitMet: incrementalMiBPerTurn <= hardLimitMiB,
    },
  };
  console.log(`OPENGENI_DENSITY_RESULT=${JSON.stringify(result)}`);
  if (!result.thresholds.hardLimitMet) process.exitCode = 2;
} finally {
  model.release();
  await Promise.allSettled(runs);
  if (workspaceId) {
    await deleteWorkspace(dbClient.db, workspaceId).catch((error) => {
      console.error(`Density workspace cleanup failed: ${errorMessage(error)}`);
      process.exitCode = 1;
    });
  }
  await dbClient.close();
}

async function seedHistory(input: {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  sessionIndex: number;
  activeBytes: number;
  inactiveBytes: number;
}): Promise<void> {
  const activeRows = historyRows(input, input.activeBytes, true, 0);
  const inactiveRows = historyRows(input, input.inactiveBytes, false, activeRows.length);
  for (const rows of chunks([...inactiveRows, ...activeRows], 25)) {
    await withWorkspaceRls(dbClient.db, input.workspaceId, async (db) => {
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
) {
  if (totalBytes === 0) return [];
  const itemCount = Math.max(1, Math.ceil(totalBytes / 32_000));
  const payloadBytes = Math.max(1, Math.floor(totalBytes / itemCount) - 200);
  return Array.from({ length: itemCount }, (_, itemIndex) => ({
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    position: positionOffset + itemIndex,
    active,
    item: {
      type: "message",
      role: itemIndex % 2 === 0 ? "user" : "assistant",
      status: "completed",
      content: [
        {
          type: itemIndex % 2 === 0 ? "input_text" : "output_text",
          text: deterministicText(input.sessionIndex, itemIndex, payloadBytes),
        },
      ],
    },
  }));
}

function deterministicText(sessionIndex: number, itemIndex: number, bytes: number): string {
  const prefix = `density:${sessionIndex}:${itemIndex}:`;
  const block = `${prefix}abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ\n`;
  return block.repeat(Math.ceil(bytes / block.length)).slice(0, bytes);
}

function createGatedDensityModel(expected: number) {
  return new (class {
    readonly allStarted: Promise<void>;
    private started = 0;
    private resolveAllStarted!: () => void;
    private readonly gate: Promise<void>;
    private resolveGate!: () => void;
    private released = false;
    private readonly delegate = new ScriptedModel([
      { outputText: "density profile complete", inputTokens: 200_000 },
    ]);

    constructor() {
      this.allStarted = new Promise((resolve) => {
        this.resolveAllStarted = resolve;
      });
      this.gate = new Promise((resolve) => {
        this.resolveGate = resolve;
      });
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
      const retainedRequest = request;
      this.started += 1;
      if (this.started === expected) this.resolveAllStarted();
      await this.gate;
      void retainedRequest.input;
    }
  })();
}

type MemorySample = ReturnType<typeof process.memoryUsage>;

async function sampleMemory(count: number, intervalMs: number): Promise<MemorySample[]> {
  const samples: MemorySample[] = [];
  for (let index = 0; index < count; index += 1) {
    samples.push(process.memoryUsage());
    if (index + 1 < count) await Bun.sleep(intervalMs);
  }
  return samples;
}

function summarizeMemory(samples: MemorySample[]) {
  const rss = samples.map((sample) => sample.rss / MIB);
  const heap = samples.map((sample) => sample.heapUsed / MIB);
  const external = samples.map((sample) => sample.external / MIB);
  return {
    rssMiBMedian: rounded(quantile(rss, 0.5)),
    rssMiBMax: rounded(Math.max(...rss)),
    heapUsedMiBMedian: rounded(quantile(heap, 0.5)),
    externalMiBMedian: rounded(quantile(external, 0.5)),
  };
}

async function settleAndCollect(): Promise<void> {
  Bun.gc(true);
  await Bun.sleep(1_000);
  Bun.gc(true);
}

function chunks<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    out.push(values.slice(index, index + size));
  }
  return out;
}

function quantile(values: number[], percentile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * percentile)] ?? 0;
}

function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}

function timeout(milliseconds: number, message: string): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), milliseconds));
}

function positiveInteger(name: string, fallback: number): number {
  const value = integer(name, fallback);
  if (value <= 0) throw new Error(`${name} must be greater than zero`);
  return value;
}

function nonnegativeInteger(name: string, fallback: number): number {
  const value = integer(name, fallback);
  if (value < 0) throw new Error(`${name} must not be negative`);
  return value;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer`);
  return value;
}

function positiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
