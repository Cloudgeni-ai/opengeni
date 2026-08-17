import { performance } from "node:perf_hooks";
import type { MCPServer } from "@openai/agents";
import {
  prepareAgentTools,
  type ToolPreparationPhase,
  type ToolPreparationPhaseMeasurement,
} from "@opengeni/runtime";
import { testSettings } from "@opengeni/testing";

function integerArgument(name: string, fallback: number, minimum = 0): number {
  const index = process.argv.indexOf(name);
  const parsed = Number.parseInt(index < 0 ? "" : (process.argv[index + 1] ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

const serverCount = integerArgument("--servers", 5);
const totalToolCount = integerArgument("--tools", 80);
const connectDelayMs = integerArgument("--connect-delay-ms", 0);
const listDelayMs = integerArgument("--list-delay-ms", 0);
const persistDelayMs = integerArgument("--persist-delay-ms", 0);
const allowedPercent = integerArgument("--allowed-percent", 100);
const alternateAllowedPercent = integerArgument("--alternate-allowed-percent", allowedPercent);
const failServerCount = Math.min(integerArgument("--fail-servers", 0), serverCount);
const optional = flag("--optional");
const samples = integerArgument("--samples", 5, 1);

if (serverCount === 0 && totalToolCount !== 0) {
  throw new Error("a zero-server benchmark requires zero tools");
}
if (allowedPercent > 100 || alternateAllowedPercent > 100) {
  throw new Error("allowed percent must be at most 100");
}

function toolsForServer(serverIndex: number): number {
  if (serverCount === 0) return 0;
  const base = Math.floor(totalToolCount / serverCount);
  return base + (serverIndex < totalToolCount % serverCount ? 1 : 0);
}

function toolName(serverIndex: number, toolIndex: number): string {
  return `tool_${serverIndex}_${toolIndex}`;
}

function makeServer(serverIndex: number, fail: boolean): MCPServer {
  const count = toolsForServer(serverIndex);
  return {
    name: `bench-server-${serverIndex}`,
    cacheToolsList: true,
    async connect() {
      if (connectDelayMs > 0) await Bun.sleep(connectDelayMs);
      if (fail) throw new Error(`synthetic MCP connect failure ${serverIndex}`);
    },
    async close() {},
    async listTools() {
      if (listDelayMs > 0) await Bun.sleep(listDelayMs);
      return Array.from({ length: count }, (_, toolIndex) => ({
        name: toolName(serverIndex, toolIndex),
        description: `Synthetic benchmark tool ${serverIndex}/${toolIndex}`,
        inputSchema: {
          type: "object",
          properties: {
            value: { type: "string" },
            marker: { type: "integer", const: serverIndex * 10_000 + toolIndex },
          },
          required: ["marker"],
          additionalProperties: false,
        },
      }));
    },
    async callTool() {
      return { content: [{ type: "text", text: "ok" }] };
    },
    async invalidateToolsCache() {},
  };
}

function buildInput(effectiveAllowedPercent: number) {
  const mcpServers = Array.from({ length: serverCount }, (_, serverIndex) => {
    const count = toolsForServer(serverIndex);
    const allowedCount = Math.floor((count * effectiveAllowedPercent) / 100);
    return {
      id: `bench_${serverIndex}`,
      name: `Benchmark ${serverIndex}`,
      url: `https://bench-${serverIndex}.example.test/mcp`,
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
  return {
    settings: testSettings({ mcpServers }),
    refs: mcpServers.map((server) => ({
      kind: "mcp" as const,
      id: server.id,
      ...(optional ? { optional: true } : {}),
    })),
    localMcpServers: mcpServers.map((server, serverIndex) => ({
      id: server.id,
      server: makeServer(serverIndex, serverIndex < failServerCount),
    })),
  };
}

type Sample = {
  durationMs: number;
  entries: number;
  allowedPercent: number;
  phases: Record<ToolPreparationPhase, number>;
};

async function runSample(effectiveAllowedPercent: number): Promise<Sample> {
  const input = buildInput(effectiveAllowedPercent);
  const observed = new Map<ToolPreparationPhase, ToolPreparationPhaseMeasurement>();
  const startedAt = performance.now();
  const prepared = await prepareAgentTools(input.settings, input.refs, {
    accountId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    sessionId: "33333333-3333-4333-8333-333333333333",
    turnId: "44444444-4444-4444-8444-444444444444",
    attemptId: crypto.randomUUID(),
    executionGeneration: 1,
    localMcpServers: input.localMcpServers,
    onPreparationPhase(measurement) {
      observed.set(measurement.phase, measurement);
    },
    async onAttemptToolCatalog() {
      if (persistDelayMs > 0) await Bun.sleep(persistDelayMs);
    },
  });
  const durationMs = performance.now() - startedAt;
  try {
    const entries = prepared.attemptToolCatalog?.entries.length ?? 0;
    const expectedActiveServers = optional ? serverCount - failServerCount : serverCount;
    const expectedEntries = Array.from({ length: expectedActiveServers }, (_, index) => {
      const serverIndex = optional ? index + failServerCount : index;
      const count = toolsForServer(serverIndex);
      return effectiveAllowedPercent === 100
        ? count
        : Math.floor((count * effectiveAllowedPercent) / 100);
    }).reduce((sum, count) => sum + count, 0);
    if (entries !== expectedEntries) {
      throw new Error(`expected ${expectedEntries} catalog entries, received ${entries}`);
    }
    const phases = Object.fromEntries(
      [...observed].map(([phase, measurement]) => [phase, measurement.durationSeconds * 1_000]),
    ) as Record<ToolPreparationPhase, number>;
    return { durationMs, entries, allowedPercent: effectiveAllowedPercent, phases };
  } finally {
    await prepared.close();
  }
}

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * quantile) - 1]!;
}

const collected: Sample[] = [];
let failure: { name: string; message: string; durationMs: number } | null = null;
for (let sample = 0; sample < samples; sample += 1) {
  const startedAt = performance.now();
  try {
    collected.push(await runSample(sample % 2 === 0 ? allowedPercent : alternateAllowedPercent));
  } catch (error) {
    failure = {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startedAt,
    };
    break;
  }
}

if (!optional && failServerCount > 0) {
  if (!failure) throw new Error("required failing MCP server did not fail preparation");
  console.log(
    JSON.stringify({
      serverCount,
      totalToolCount,
      connectDelayMs,
      listDelayMs,
      optional,
      failServerCount,
      requiredFailure: failure,
    }),
  );
} else {
  if (failure) throw new Error(`${failure.name}: ${failure.message}`);
  const phaseNames: ToolPreparationPhase[] = [
    "server_construction",
    "required_connect",
    "optional_connect",
    "attempt_catalog_build",
    "attempt_catalog_persist",
  ];
  console.log(
    JSON.stringify({
      serverCount,
      totalToolCount,
      connectDelayMs,
      listDelayMs,
      persistDelayMs,
      allowedPercents: [...new Set(collected.map((sample) => sample.allowedPercent))],
      optional,
      failServerCount,
      samples,
      entries: [...new Set(collected.map((sample) => sample.entries))],
      totalMs: {
        p50: percentile(
          collected.map((sample) => sample.durationMs),
          0.5,
        ),
        p95: percentile(
          collected.map((sample) => sample.durationMs),
          0.95,
        ),
      },
      phasesMs: Object.fromEntries(
        phaseNames.map((phase) => [
          phase,
          {
            p50: percentile(
              collected.map((sample) => sample.phases[phase] ?? 0),
              0.5,
            ),
            p95: percentile(
              collected.map((sample) => sample.phases[phase] ?? 0),
              0.95,
            ),
          },
        ]),
      ),
      catalogParity: "pass",
    }),
  );
}
