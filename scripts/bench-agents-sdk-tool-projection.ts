import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import {
  RunContext,
  Runner,
  Usage,
  OpenAIResponsesModel,
  type MCPServer,
  type Model,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
} from "@openai/agents";
import {
  buildOpenGeniAgent,
  prepareAgentTools,
  serializedToolsForRemoteCompaction,
} from "@opengeni/runtime";
import { testSettings } from "@opengeni/testing";

function integerArgument(name: string, fallback: number, minimum = 0): number {
  const index = process.argv.indexOf(name);
  const parsed = Number.parseInt(index < 0 ? "" : (process.argv[index + 1] ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function stringArgument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback);
}

const serverCount = integerArgument("--servers", 5);
const totalToolCount = integerArgument("--tools", 80);
const propertyCount = integerArgument("--properties", 8, 1);
const descriptionBytes = integerArgument("--description-bytes", 160);
const projections = integerArgument("--projections", 12, 2);
const samples = integerArgument("--samples", 5, 1);
const allowedPercent = integerArgument("--allowed-percent", 100);
const alternateAllowedPercent = integerArgument("--alternate-allowed-percent", allowedPercent);
const lazyMode = stringArgument("--lazy", "none");

if (serverCount === 0 && totalToolCount !== 0) {
  throw new Error("a zero-server benchmark requires zero tools");
}
if (allowedPercent > 100 || alternateAllowedPercent > 100) {
  throw new Error("allowed percent must be at most 100");
}
if (lazyMode !== "none" && lazyMode !== "codex_native") {
  throw new Error("--lazy must be none or codex_native");
}

function toolsForServer(serverIndex: number): number {
  if (serverCount === 0) return 0;
  const base = Math.floor(totalToolCount / serverCount);
  return base + (serverIndex < totalToolCount % serverCount ? 1 : 0);
}

function toolName(serverIndex: number, toolIndex: number): string {
  return `tool_${serverIndex}_${toolIndex}`;
}

function makeInputSchema(serverIndex: number, toolIndex: number): Record<string, unknown> {
  const properties = Object.fromEntries(
    Array.from({ length: propertyCount }, (_unused, propertyIndex) => [
      `field_${propertyIndex}`,
      propertyIndex % 3 === 0
        ? { type: "string", maxLength: 2048 }
        : propertyIndex % 3 === 1
          ? { type: "integer", minimum: 0, maximum: 1_000_000 }
          : {
              type: "array",
              maxItems: 32,
              items: { type: "string", maxLength: 256 },
            },
    ]),
  );
  return {
    type: "object",
    properties: {
      ...properties,
      marker: { type: "integer", const: serverIndex * 100_000 + toolIndex },
    },
    required: ["marker"],
    additionalProperties: false,
  };
}

type ServerCounters = { connect: number; listTools: number };

class ProjectionProbeModel implements Model {
  runStartedAt = 0;
  readonly entryMs: number[] = [];
  readonly stringifyMs: number[] = [];
  readonly toolCounts: number[] = [];
  readonly toolBytes: number[] = [];
  readonly requests: ModelRequest[] = [];

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    this.entryMs.push(performance.now() - this.runStartedAt);
    const stringifyStartedAt = performance.now();
    const toolJson = JSON.stringify(request.tools);
    this.stringifyMs.push(performance.now() - stringifyStartedAt);
    this.toolCounts.push(request.tools.length);
    this.toolBytes.push(Buffer.byteLength(toolJson, "utf8"));
    return {
      usage: new Usage(),
      output: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "done" }],
        },
      ],
    } as ModelResponse;
  }

  getStreamedResponse(): AsyncIterable<StreamEvent> {
    throw new Error("projection benchmark uses the non-streaming path");
  }
}

function providerFor(model: Model): ModelProvider {
  return { getModel: () => model };
}

type OpenAIClientConstructor = new (options: {
  apiKey: string;
  baseURL: string;
  maxRetries: number;
  fetch: typeof fetch;
}) => unknown;

function openAIClientConstructor(): OpenAIClientConstructor {
  const requireFromAgents = createRequire(import.meta.resolve("@openai/agents"));
  const loaded = requireFromAgents("openai") as unknown;
  const candidate =
    loaded && typeof loaded === "object" && "default" in loaded
      ? (loaded as { default: unknown }).default
      : loaded;
  if (typeof candidate !== "function") throw new Error("OpenAI client constructor is unavailable");
  return candidate as OpenAIClientConstructor;
}

function agentsGetOrCreateTrace(): <T>(run: () => Promise<T>) => Promise<T> {
  const requireFromAgents = createRequire(import.meta.resolve("@openai/agents"));
  const loaded = requireFromAgents("@openai/agents-core") as {
    getOrCreateTrace?: unknown;
  };
  if (typeof loaded.getOrCreateTrace !== "function") {
    throw new Error("Agents tracing helper is unavailable");
  }
  return loaded.getOrCreateTrace as <T>(run: () => Promise<T>) => Promise<T>;
}

function makeServer(serverIndex: number, counters: ServerCounters): MCPServer {
  const count = toolsForServer(serverIndex);
  return {
    name: `projection-server-${serverIndex}`,
    cacheToolsList: true,
    async connect() {
      counters.connect += 1;
    },
    async close() {},
    async listTools() {
      counters.listTools += 1;
      return Array.from({ length: count }, (_, toolIndex) => ({
        name: toolName(serverIndex, toolIndex),
        description: `${serverIndex}/${toolIndex} ${"d".repeat(descriptionBytes)}`,
        inputSchema: makeInputSchema(serverIndex, toolIndex),
      }));
    },
    async callTool() {
      return { content: [{ type: "text", text: "ok" }] };
    },
    async invalidateToolsCache() {},
  };
}

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * quantile) - 1]!;
}

function distribution(values: number[]) {
  return {
    min: Math.min(...values),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
  };
}

type Sample = {
  allowedPercent: number;
  catalogEntries: number;
  modelEntries: number;
  serializedBytes: number;
  connectCalls: number;
  listCallsBeforeProjection: number;
  listCallsAfterProjection: number;
  agentBuildMs: number;
  firstGetAllToolsMs: number;
  warmGetAllToolsMs: number[];
  firstSerializeMs: number;
  warmSerializeMs: number[];
  stringifyMs: number[];
  firstRunnerPreparationMs: number;
  warmRunnerPreparationMs: number[];
  firstRunnerTotalMs: number;
  warmRunnerTotalMs: number[];
  runnerToolStringifyMs: number[];
  runnerToolBytes: number;
  firstWireFetchEntryMs: number;
  warmWireFetchEntryMs: number[];
  wireBodyReadMs: number[];
  wireBodyBytes: number;
};

async function runSample(effectiveAllowedPercent: number): Promise<Sample> {
  const counters: ServerCounters = { connect: 0, listTools: 0 };
  const mcpServers = Array.from({ length: serverCount }, (_, serverIndex) => {
    const count = toolsForServer(serverIndex);
    const allowedCount = Math.floor((count * effectiveAllowedPercent) / 100);
    return {
      id: `projection_${serverIndex}`,
      name: `Projection ${serverIndex}`,
      url: `https://projection-${serverIndex}.example.test/mcp`,
      cacheToolsList: true,
      ...(effectiveAllowedPercent === 100
        ? {}
        : {
            allowedTools: Array.from({ length: allowedCount }, (_unused, toolIndex) =>
              toolName(serverIndex, toolIndex),
            ),
          }),
    };
  });
  const settings = testSettings({
    sandboxBackend: "none",
    webSearchEnabled: false,
    codexToolSearchEnabled: true,
    mcpServers,
  });
  const prepared = await prepareAgentTools(
    settings,
    mcpServers.map((server) => ({ kind: "mcp" as const, id: server.id })),
    {
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      sessionId: "33333333-3333-4333-8333-333333333333",
      turnId: "44444444-4444-4444-8444-444444444444",
      attemptId: crypto.randomUUID(),
      executionGeneration: 1,
      localMcpServers: mcpServers.map((server, serverIndex) => ({
        id: server.id,
        server: makeServer(serverIndex, counters),
      })),
    },
  );
  try {
    const listCallsBeforeProjection = counters.listTools;
    const agentBuildStartedAt = performance.now();
    const agent = buildOpenGeniAgent(settings, [], {
      mcpServers: prepared.mcpServers,
      attemptToolCatalog: prepared.attemptToolCatalog,
      humanInputEnabled: false,
      ...(lazyMode === "codex_native"
        ? {
            lazyToolTransport: "codex_native" as const,
            codexConnectorNamespaces: prepared.codexConnectorNamespaces,
          }
        : {}),
    });
    const agentBuildMs = performance.now() - agentBuildStartedAt;

    const runContext = new RunContext();
    const firstGetStartedAt = performance.now();
    const firstTools = await agent.getAllTools(runContext);
    const firstGetAllToolsMs = performance.now() - firstGetStartedAt;
    const expectedCatalogEntries = prepared.attemptToolCatalog?.entries.length ?? 0;
    const expectedModelEntries = expectedCatalogEntries + (lazyMode === "codex_native" ? 1 : 0);
    if (firstTools.length !== expectedModelEntries) {
      throw new Error(
        `expected ${expectedModelEntries} model tools, received ${firstTools.length}`,
      );
    }

    const warmGetAllToolsMs: number[] = [];
    for (let index = 1; index < projections; index += 1) {
      const startedAt = performance.now();
      const tools = await agent.getAllTools(runContext);
      warmGetAllToolsMs.push(performance.now() - startedAt);
      if (tools.length !== expectedModelEntries) {
        throw new Error("warm projection changed tool count");
      }
    }

    const firstSerializeStartedAt = performance.now();
    const firstSerialized = await serializedToolsForRemoteCompaction(agent);
    const firstSerializeMs = performance.now() - firstSerializeStartedAt;
    if (firstSerialized.length !== expectedModelEntries) {
      throw new Error("serialized projection changed tool count");
    }
    const serializedJson = JSON.stringify(firstSerialized);
    const serializedBytes = Buffer.byteLength(serializedJson, "utf8");

    const warmSerializeMs: number[] = [];
    const stringifyMs: number[] = [];
    for (let index = 1; index < projections; index += 1) {
      const serializeStartedAt = performance.now();
      const serialized = await serializedToolsForRemoteCompaction(agent);
      warmSerializeMs.push(performance.now() - serializeStartedAt);
      const stringifyStartedAt = performance.now();
      const json = JSON.stringify(serialized);
      stringifyMs.push(performance.now() - stringifyStartedAt);
      if (Buffer.byteLength(json, "utf8") !== serializedBytes) {
        throw new Error("serialized projection changed byte size");
      }
    }

    const probeModel = new ProjectionProbeModel();
    const runner = new Runner({ modelProvider: providerFor(probeModel) });
    const runnerTotalMs: number[] = [];
    for (let index = 0; index < projections; index += 1) {
      probeModel.runStartedAt = performance.now();
      const result = await runner.run(agent, "Projection benchmark", {
        historyOwnership: "external",
        maxTurns: 1,
      });
      runnerTotalMs.push(performance.now() - probeModel.runStartedAt);
      if (result.finalOutput !== "done") throw new Error("probe model did not settle");
    }
    if (probeModel.toolCounts.some((count) => count !== expectedModelEntries)) {
      throw new Error("Runner model request changed tool count");
    }
    if (new Set(probeModel.toolBytes).size !== 1) {
      throw new Error("Runner model request changed tool byte size");
    }

    let wireStartedAt = 0;
    const wireFetchEntryMs: number[] = [];
    const wireBodyReadMs: number[] = [];
    const wireBodyBytes: number[] = [];
    const OpenAIClient = openAIClientConstructor();
    const client = new OpenAIClient({
      apiKey: "projection-benchmark-key",
      baseURL: "https://projection-benchmark.example.test/v1",
      maxRetries: 0,
      fetch: async (input, init) => {
        wireFetchEntryMs.push(performance.now() - wireStartedAt);
        const bodyReadStartedAt = performance.now();
        const body =
          init?.body !== undefined
            ? String(init.body)
            : input instanceof Request
              ? await input.clone().text()
              : "";
        wireBodyReadMs.push(performance.now() - bodyReadStartedAt);
        wireBodyBytes.push(Buffer.byteLength(body, "utf8"));
        return Response.json({
          id: `projection-response-${wireFetchEntryMs.length}`,
          status: "completed",
          output: [],
          usage: null,
        });
      },
    });
    const wireModel = new OpenAIResponsesModel(client as never, "gpt-5.6-sol");
    const { signal: _signal, ...wireRequest } = probeModel.requests[0]!;
    const getOrCreateTrace = agentsGetOrCreateTrace();
    for (let index = 0; index < projections; index += 1) {
      wireStartedAt = performance.now();
      await getOrCreateTrace(async () => await wireModel.getResponse(wireRequest as ModelRequest));
    }
    if (new Set(wireBodyBytes).size !== 1) {
      throw new Error("Responses wire body changed byte size");
    }

    return {
      allowedPercent: effectiveAllowedPercent,
      catalogEntries: expectedCatalogEntries,
      modelEntries: expectedModelEntries,
      serializedBytes,
      connectCalls: counters.connect,
      listCallsBeforeProjection,
      listCallsAfterProjection: counters.listTools,
      agentBuildMs,
      firstGetAllToolsMs,
      warmGetAllToolsMs,
      firstSerializeMs,
      warmSerializeMs,
      stringifyMs,
      firstRunnerPreparationMs: probeModel.entryMs[0]!,
      warmRunnerPreparationMs: probeModel.entryMs.slice(1),
      firstRunnerTotalMs: runnerTotalMs[0]!,
      warmRunnerTotalMs: runnerTotalMs.slice(1),
      runnerToolStringifyMs: probeModel.stringifyMs,
      runnerToolBytes: probeModel.toolBytes[0]!,
      firstWireFetchEntryMs: wireFetchEntryMs[0]!,
      warmWireFetchEntryMs: wireFetchEntryMs.slice(1),
      wireBodyReadMs,
      wireBodyBytes: wireBodyBytes[0]!,
    };
  } finally {
    await prepared.close();
  }
}

const collected: Sample[] = [];
for (let sample = 0; sample < samples; sample += 1) {
  collected.push(await runSample(sample % 2 === 0 ? allowedPercent : alternateAllowedPercent));
}

console.log(
  JSON.stringify({
    serverCount,
    totalToolCount,
    propertyCount,
    descriptionBytes,
    lazyMode,
    projections,
    samples,
    allowedPercents: [...new Set(collected.map((sample) => sample.allowedPercent))],
    catalogEntries: [...new Set(collected.map((sample) => sample.catalogEntries))],
    modelEntries: [...new Set(collected.map((sample) => sample.modelEntries))],
    serializedBytes: [...new Set(collected.map((sample) => sample.serializedBytes))],
    agentBuildMs: distribution(collected.map((sample) => sample.agentBuildMs)),
    firstGetAllToolsMs: distribution(collected.map((sample) => sample.firstGetAllToolsMs)),
    warmGetAllToolsMs: distribution(collected.flatMap((sample) => sample.warmGetAllToolsMs)),
    firstGetAndSerializeMs: distribution(collected.map((sample) => sample.firstSerializeMs)),
    warmGetAndSerializeMs: distribution(collected.flatMap((sample) => sample.warmSerializeMs)),
    stringifyMs: distribution(collected.flatMap((sample) => sample.stringifyMs)),
    firstRunnerPreparationMs: distribution(
      collected.map((sample) => sample.firstRunnerPreparationMs),
    ),
    warmRunnerPreparationMs: distribution(
      collected.flatMap((sample) => sample.warmRunnerPreparationMs),
    ),
    firstRunnerTotalMs: distribution(collected.map((sample) => sample.firstRunnerTotalMs)),
    warmRunnerTotalMs: distribution(collected.flatMap((sample) => sample.warmRunnerTotalMs)),
    runnerToolStringifyMs: distribution(
      collected.flatMap((sample) => sample.runnerToolStringifyMs),
    ),
    runnerToolBytes: [...new Set(collected.map((sample) => sample.runnerToolBytes))],
    firstResponsesWireFetchEntryMs: distribution(
      collected.map((sample) => sample.firstWireFetchEntryMs),
    ),
    warmResponsesWireFetchEntryMs: distribution(
      collected.flatMap((sample) => sample.warmWireFetchEntryMs),
    ),
    responsesWireBodyReadMs: distribution(collected.flatMap((sample) => sample.wireBodyReadMs)),
    responsesWireBodyBytes: [...new Set(collected.map((sample) => sample.wireBodyBytes))],
    serverCalls: collected.map((sample) => ({
      allowedPercent: sample.allowedPercent,
      connect: sample.connectCalls,
      listBeforeProjection: sample.listCallsBeforeProjection,
      listAfterProjection: sample.listCallsAfterProjection,
    })),
    countAndByteParity: "pass",
  }),
);
