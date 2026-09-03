import { run } from "@openai/agents";
import { assistantMessage, ScriptedModel, testSettings } from "@opengeni/testing";
import {
  buildManifest,
  buildOpenGeniAgent,
  runAgentStream,
  runOwnedSandboxSetup,
} from "@opengeni/runtime";

const SAMPLE_COUNT = 7;
const HISTORY_ITEMS = 267;
const APPROXIMATE_HISTORY_TOKENS = 250_000;
const SIMULATED_SANDBOX_READ_MS = 25;

type Sample = {
  durationMs: number;
  setupMs?: number;
  listCalls: number;
};

const repositories = Array.from({ length: 4 }, (_, index) => ({
  kind: "repository" as const,
  uri: `https://github.com/example/repository-${index + 1}.git`,
  ref: "main",
  mountPath: `repos/example/repository-${index + 1}`,
  githubInstallationId: index + 1,
  githubRepositoryId: index + 101,
}));

const historyCharacters = APPROXIMATE_HISTORY_TOKENS * 4;
const charactersPerItem = Math.ceil(historyCharacters / HISTORY_ITEMS);
const history = Array.from({ length: HISTORY_ITEMS }, (_, index) => ({
  type: "message" as const,
  role: "user" as const,
  content: `history-${index}: ${"x".repeat(charactersPerItem)}`,
}));

const settings = testSettings({
  sandboxBackend: "local",
  webSearchEnabled: false,
  contextWindowTokens: 1_000_000,
  contextAutoCompactThresholdTokens: 900_000,
});

function createProvidedSession() {
  let listCalls = 0;
  const session = {
    state: { manifest: buildManifest(settings, repositories, {}) },
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    createEditor: () => ({}),
    execCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    listDir: async () => {
      listCalls += 1;
      await Bun.sleep(SIMULATED_SANDBOX_READ_MS);
      return [];
    },
    readFile: async () => {
      await Bun.sleep(SIMULATED_SANDBOX_READ_MS);
      return "";
    },
    pathExists: async () => false,
    materializeEntry: async () => undefined,
  };
  return { session, listCalls: () => listCalls };
}

const client = {
  backendId: "unix_local",
  serializeSessionState: async () => ({}),
};

async function drain(result: { toStream(): AsyncIterable<unknown>; completed: Promise<unknown> }) {
  for await (const _ of result.toStream()) void _;
  await result.completed;
}

async function sampleSdkProvidedSession(): Promise<Sample> {
  const model = new ScriptedModel([{ output: [assistantMessage("done")] }]);
  const agent = buildOpenGeniAgent(settings, repositories, { model });
  const provided = createProvidedSession();
  const startedAt = performance.now();
  const result = await run(agent, history, {
    stream: true,
    historyOwnership: "external",
    modelResponseRetention: "last",
    sandbox: { client, session: provided.session } as never,
  });
  await drain(result);
  return {
    durationMs: performance.now() - startedAt,
    listCalls: provided.listCalls(),
  };
}

async function sampleOpenGeniEstablishedSession(): Promise<Sample> {
  const model = new ScriptedModel([{ output: [assistantMessage("done")] }]);
  const agent = buildOpenGeniAgent(settings, repositories, { model });
  const provided = createProvidedSession();
  const setupStartedAt = performance.now();
  await runOwnedSandboxSetup(agent, provided.session as never, provided.session as never, {
    settings,
    environment: {},
  });
  const setupMs = performance.now() - setupStartedAt;
  const listCallsAfterSetup = provided.listCalls();
  const startedAt = performance.now();
  const result = await runAgentStream(agent, { input: history }, settings, {
    ownedSandbox: {
      client: client as never,
      session: provided.session as never,
      deferredSetup: true,
    },
  });
  await drain(result);
  return {
    durationMs: performance.now() - startedAt,
    setupMs,
    listCalls: provided.listCalls() - listCallsAfterSetup,
  };
}

function percentile(samples: readonly Sample[], quantile: number): number {
  const sorted = samples.map((sample) => sample.durationMs).sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))]!;
}

async function collect(sample: () => Promise<Sample>): Promise<Sample[]> {
  await sample();
  const samples: Sample[] = [];
  for (let index = 0; index < SAMPLE_COUNT; index += 1) samples.push(await sample());
  return samples;
}

const sdk = await collect(sampleSdkProvidedSession);
const opengeni = await collect(sampleOpenGeniEstablishedSession);
const summarize = (samples: readonly Sample[]) => ({
  p50Ms: Math.round(percentile(samples, 0.5) * 100) / 100,
  p95Ms: Math.round(percentile(samples, 0.95) * 100) / 100,
  setupP50Ms: samples.some((sample) => sample.setupMs !== undefined)
    ? Math.round(
        samples.map((sample) => sample.setupMs ?? 0).sort((left, right) => left - right)[
          Math.floor(samples.length * 0.5)
        ]! * 100,
      ) / 100
    : undefined,
  listCalls: samples.reduce((total, sample) => total + sample.listCalls, 0),
});

console.log(
  JSON.stringify(
    {
      shape: {
        historyItems: HISTORY_ITEMS,
        approximateHistoryTokens: APPROXIMATE_HISTORY_TOKENS,
        repositories: repositories.length,
        repositorySkillSearchPaths: repositories.length * 2 + 2,
        simulatedSandboxReadMs: SIMULATED_SANDBOX_READ_MS,
        samples: SAMPLE_COUNT,
      },
      sdkProvidedSession: summarize(sdk),
      opengeniEstablishedSession: summarize(opengeni),
    },
    null,
    2,
  ),
);
