#!/usr/bin/env bun
/**
 * Whole-turn discovery measurement: how many model requests an agent spends only
 * on finding tools (tool_search / tool_list) before it acts, and what they cost
 * in wall time.
 *
 * Each scenario is one fresh chat with one person message. The turn runs through
 * the real Agents SDK runner and the runtime's own progressive tool disclosure
 * (LazyToolRuntime on the native or generic route), with the real composed
 * system prompt, against a real Responses model. Tool calls other than discovery
 * are answered with a fixed simulated success, so the measurement is the agent's
 * path to the right tools, not the tools themselves.
 *
 * Usage:
 *   TOOL_EVAL_AGENT_BASE_URL=https://<resource>.openai.azure.com/openai/v1 \
 *   TOOL_EVAL_AGENT_API_KEY_FILE=/path/to/key TOOL_EVAL_AGENT_MODEL=<deployment> \
 *   bun scripts/tool-discovery-eval/turns.ts --catalog catalog.json --out results.json \
 *     [--scenarios scenarios.json] [--repeat 3] [--transport openai_native] \
 *     [--reasoning medium] [--only a,b] [--concurrency 4] [--max-turns 16] [--label name]
 *
 * The catalog is `ogtool list --full` output (or `{ tools: [{ name, description,
 * inputSchema, identity: { serverId, toolName } }] }`). Keep real catalogs, which
 * can hold private tool names, outside the repository.
 */
import {
  Agent,
  Runner,
  tool,
  type Model,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
  type Tool,
} from "@openai/agents";
import OpenAI from "openai";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { testSettings } from "../../packages/testing/src/settings";
import { AppendOnlyOpenAIResponsesModel } from "../../packages/runtime/src/append-only-responses-model";
import {
  LazyToolModelProvider,
  createResolveMissingFunctionTool,
  installLazyToolRuntime,
  type LazyToolTransport,
} from "../../packages/runtime/src/lazy-tool-transport";
import { inspectPersistentAgentInstructions } from "../../packages/runtime/src/index";
import { baseModelInputFilterForSettings } from "../../packages/runtime/src/model-input";
import { projectHistoryForProvider } from "../../packages/runtime/src/provider-history-adapter";
import {
  MODULAR_PARITY_CASES,
  PARITY_SETTINGS,
} from "../../packages/runtime/test/agent-instructions/modular-parity-cases";
import { DEFAULT_TURN_SCENARIOS, type TurnScenario } from "./fixtures/turn-scenarios";

type CatalogEntry = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  identity?: { serverId?: string; toolName?: string };
};

type RequestRecord = {
  /** What the request added after the previous response: results, disclosures, notices. */
  newInput: string[];
  /** The calls it made, with their arguments. */
  callDetails: string[];
  startedMs: number;
  durationMs: number;
  calls: string[];
  discoveryOnly: boolean;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
};

type RunRecord = {
  scenario: string;
  repeat: number;
  requests: RequestRecord[];
  modelRequests: number;
  discoveryOnlyRequests: number;
  discoveryCalls: number;
  actionCalls: string[];
  needsMet: number;
  needs: number;
  firstActionMs: number | null;
  modelMs: number;
  wallMs: number;
  inputTokens: number;
  cachedTokens: number;
  error?: string;
  finalOutput?: string;
};

const { values } = parseArgs({
  options: {
    catalog: { type: "string" },
    scenarios: { type: "string" },
    out: { type: "string" },
    repeat: { type: "string", default: "1" },
    transport: { type: "string", default: "openai_native" },
    reasoning: { type: "string", default: "medium" },
    only: { type: "string" },
    concurrency: { type: "string", default: "4" },
    "max-turns": { type: "string", default: "16" },
    label: { type: "string", default: "" },
  },
});

if (!values.catalog) throw new Error("--catalog is required");
const baseURL = process.env.TOOL_EVAL_AGENT_BASE_URL;
const apiKey =
  process.env.TOOL_EVAL_AGENT_API_KEY ??
  (process.env.TOOL_EVAL_AGENT_API_KEY_FILE
    ? readFileSync(process.env.TOOL_EVAL_AGENT_API_KEY_FILE, "utf8").trim()
    : undefined);
const modelName = process.env.TOOL_EVAL_AGENT_MODEL;
if (!baseURL || !apiKey || !modelName)
  throw new Error(
    "Set TOOL_EVAL_AGENT_BASE_URL, TOOL_EVAL_AGENT_API_KEY(_FILE) and TOOL_EVAL_AGENT_MODEL",
  );
const transport = values.transport as LazyToolTransport;
const client = new OpenAI({ baseURL, apiKey, maxRetries: 10 });

const rawCatalog = JSON.parse(readFileSync(values.catalog, "utf8")) as { tools: CatalogEntry[] };
const catalog = rawCatalog.tools.filter((entry) => typeof entry.name === "string");
const scenarios: TurnScenario[] = values.scenarios
  ? (JSON.parse(readFileSync(values.scenarios, "utf8")) as TurnScenario[])
  : DEFAULT_TURN_SCENARIOS;
const only = values.only ? new Set(values.only.split(",")) : undefined;

/** Base runtime tools every request carries; they are not in a Codemode catalog. */
const BASE_TOOLS: CatalogEntry[] = [
  {
    name: "exec_command",
    description: "Runs a shell command, returning output or a session ID for ongoing interaction.",
    inputSchema: {
      type: "object",
      properties: { cmd: { type: "string" }, max_output_tokens: { type: "integer" } },
      required: ["cmd", "max_output_tokens"],
      additionalProperties: false,
    },
  },
  {
    name: "view_image",
    description: "Returns an image from a local path in the sandbox workspace.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "request_human_input",
    description: "Pause the turn to ask a person for a decision or information only they can give.",
    inputSchema: {
      type: "object",
      properties: { questions: { type: "array", items: { type: "object" } } },
      required: ["questions"],
      additionalProperties: true,
    },
  },
];

const DISCOVERY = new Set(["tool_search", "tool_list"]);

function serverOf(entry: CatalogEntry): string | undefined {
  const separator = entry.name.indexOf("__");
  return separator > 0 ? entry.identity?.serverId : undefined;
}

function shortName(name: string): string {
  const separator = name.indexOf("__");
  return separator >= 0 ? name.slice(separator + 2) : name;
}

function buildTools(entries: CatalogEntry[], calls: string[]): Tool[] {
  return entries.map((entry) =>
    tool({
      name: entry.name,
      description: entry.description ?? "",
      parameters: (entry.inputSchema ?? {
        type: "object",
        properties: {},
        additionalProperties: true,
      }) as never,
      strict: false,
      execute: async () => {
        calls.push(entry.name);
        // The sandbox and Skills are not part of the measurement. Saying so
        // plainly keeps a model from retrying a shell whose output never comes.
        if (entry.name === "exec_command")
          return "Process exited with code 1\nOutput:\nNo shell is available in this evaluation.";
        if (entry.name === "skill_read") return "No Skills are installed in this evaluation.";
        // Identifiers a follow-up step may need, so a task never stalls on a
        // result that lacks the id it just created.
        const id = crypto.randomUUID();
        return JSON.stringify({
          ok: true,
          id,
          sessionId: id,
          updateId: crypto.randomUUID(),
          items: [],
          result: "Done (simulated result for this measurement).",
        });
      },
    }),
  );
}

function outputCalls(output: ModelResponse["output"]): string[] {
  const calls: string[] = [];
  for (const item of output as unknown as Record<string, unknown>[]) {
    if (item.type === "function_call") calls.push(String(item.name));
    else if (item.type === "tool_search_call") calls.push("tool_search");
    else if (typeof item.type === "string" && item.type.endsWith("_call")) calls.push(item.type);
  }
  return calls;
}

/** Records every request that reaches the provider (the local opening load never does). */
class MeasuredModel implements Model {
  constructor(
    private readonly inner: Model,
    private readonly records: RequestRecord[],
    private readonly origin: number,
  ) {}

  /** Shared by every model object the runner resolves in one turn. */
  private get seen(): number {
    return (this.records as unknown as { seen?: number }).seen ?? 0;
  }
  private set seen(value: number) {
    (this.records as unknown as { seen?: number }).seen = value;
  }

  private newInput(request: ModelRequest): string[] {
    const input =
      typeof request.input === "string"
        ? []
        : (request.input as unknown as Record<string, unknown>[]);
    const added = input.slice(this.seen);
    this.seen = input.length;
    return added.map((item) => {
      if (item.type === "tool_search_output")
        return `tool_search_output: ${((item.tools as { name?: string }[]) ?? []).map((t) => t.name).join(", ")}`;
      if (item.type === "function_call_result")
        return `result ${String(item.name)}: ${JSON.stringify(item.output).slice(0, 600)}`;
      if (item.role === "developer" || item.role === "system")
        return `${String(item.role)}: ${JSON.stringify(item.content).slice(0, 600)}`;
      if (item.type === "message") return `${String(item.role)} message`;
      return String(item.type);
    });
  }

  private record(
    startedAt: number,
    request: ModelRequest,
    response: { output: ModelResponse["output"]; usage?: unknown },
  ) {
    const calls = outputCalls(response.output);
    const callDetails = (response.output as unknown as Record<string, unknown>[]).flatMap((item) =>
      item.type === "function_call" || item.type === "tool_search_call"
        ? [`${String(item.name ?? "tool_search")} ${JSON.stringify(item.arguments).slice(0, 300)}`]
        : [],
    );
    const usage = (response.usage ?? {}) as {
      inputTokens?: number;
      outputTokens?: number;
      inputTokensDetails?: { cached_tokens?: number }[] | { cached_tokens?: number };
    };
    const details = Array.isArray(usage.inputTokensDetails)
      ? usage.inputTokensDetails[0]
      : usage.inputTokensDetails;
    this.records.push({
      newInput: this.newInput(request),
      callDetails,
      startedMs: startedAt - this.origin,
      durationMs: performance.now() - startedAt,
      calls,
      discoveryOnly: calls.length > 0 && calls.every((name) => DISCOVERY.has(name)),
      inputTokens: usage.inputTokens ?? 0,
      cachedTokens: details?.cached_tokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
    });
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const startedAt = performance.now();
    const response = await this.inner.getResponse(request);
    this.record(startedAt, request, response);
    return response;
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    const startedAt = performance.now();
    for await (const event of this.inner.getStreamedResponse(request)) {
      if (event.type === "response_done")
        this.record(startedAt, request, event.response as unknown as ModelResponse);
      yield event;
    }
  }
}

/**
 * The Responses wire projection the runtime's routed model applies (search
 * notices and tool disclosures in their Responses form).
 */
class ProjectedResponsesModel extends AppendOnlyOpenAIResponsesModel {
  protected override _buildResponsesCreateRequest(request: ModelRequest, stream: boolean) {
    const input =
      typeof request.input === "string"
        ? request.input
        : (projectHistoryForProvider(request.input as never, "responses") as ModelRequest["input"]);
    return super._buildResponsesCreateRequest(
      input === request.input ? request : { ...request, input },
      stream,
    );
  }
}

const settings = testSettings(PARITY_SETTINGS);
const instructions = inspectPersistentAgentInstructions(settings, {
  ...MODULAR_PARITY_CASES["all/docker"]!,
  lazyToolTransport: transport,
}).composed;

async function runScenario(scenario: TurnScenario, repeat: number): Promise<RunRecord> {
  const records: RequestRecord[] = [];
  const actionCalls: string[] = [];
  const origin = performance.now();
  const entries = [...BASE_TOOLS, ...catalog];
  const serverIds = new Set(entries.flatMap((entry) => serverOf(entry) ?? []));
  const modelServerIds = new Map(
    entries.flatMap((entry) => {
      const server = serverOf(entry);
      return server ? [[entry.name, server] as const] : [];
    }),
  );
  const agent = new Agent({
    name: "discovery-eval",
    instructions,
    model: modelName,
    modelSettings: {
      reasoning: { effort: values.reasoning as "low" | "medium" | "high" },
      parallelToolCalls: true,
      providerData: { prompt_cache_key: `discovery-eval-${values.label}-${scenario.id}` },
    },
    tools: buildTools(entries, actionCalls),
  });
  const runtime = installLazyToolRuntime(
    agent as never,
    transport,
    serverIds,
    undefined,
    serverIds,
    new Set(),
    () => modelServerIds,
  );
  const provider: ModelProvider = {
    getModel: async () =>
      new MeasuredModel(new ProjectedResponsesModel(client as never, modelName!), records, origin),
  };
  const runner = new Runner({ modelProvider: new LazyToolModelProvider(provider, runtime) });
  let error: string | undefined;
  let finalOutput: string | undefined;
  try {
    const result = await runner.run(agent, scenario.task, {
      stream: true,
      maxTurns: Number(values["max-turns"]),
      toolNotFoundBehavior: "return_error_to_model",
      // The runtime's own history rules: search notices and family disclosures.
      callModelInputFilter: baseModelInputFilterForSettings(settings),
      resolveMissingFunctionTool: createResolveMissingFunctionTool(runtime),
    } as never);
    for await (const _event of (result as { toStream(): AsyncIterable<unknown> }).toStream())
      void _event;
    await (result as { completed: Promise<void> }).completed;
    finalOutput = String((result as { finalOutput?: unknown }).finalOutput ?? "").slice(0, 400);
  } catch (caught) {
    error =
      caught instanceof Error ? `${caught.name}: ${caught.message}`.slice(0, 500) : String(caught);
  }
  const wallMs = performance.now() - origin;
  const called = new Set(actionCalls.map(shortName));
  const needsMet = scenario.needs.filter((need) => need.some((name) => called.has(name))).length;
  const firstAction = records.find((record) => record.calls.some((name) => !DISCOVERY.has(name)));
  return {
    scenario: scenario.id,
    repeat,
    requests: records,
    modelRequests: records.length,
    discoveryOnlyRequests: records.filter((record) => record.discoveryOnly).length,
    discoveryCalls: records.reduce(
      (sum, record) => sum + record.calls.filter((name) => DISCOVERY.has(name)).length,
      0,
    ),
    actionCalls,
    needsMet,
    needs: scenario.needs.length,
    firstActionMs: firstAction ? firstAction.startedMs + firstAction.durationMs : null,
    modelMs: records.reduce((sum, record) => sum + record.durationMs, 0),
    wallMs,
    inputTokens: records.reduce((sum, record) => sum + record.inputTokens, 0),
    cachedTokens: records.reduce((sum, record) => sum + record.cachedTokens, 0),
    ...(error ? { error } : {}),
    ...(finalOutput ? { finalOutput } : {}),
  };
}

const jobs = scenarios
  .filter((scenario) => !only || only.has(scenario.id))
  .flatMap((scenario) =>
    Array.from({ length: Number(values.repeat) }, (_, repeat) => ({ scenario, repeat })),
  );
const results: RunRecord[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: Math.max(1, Number(values.concurrency)) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++]!;
      const record = await runScenario(job.scenario, job.repeat);
      results.push(record);
      console.error(
        `${record.scenario}#${record.repeat}: ${record.modelRequests} requests, ${record.discoveryOnlyRequests} discovery-only, needs ${record.needsMet}/${record.needs}, ${(record.wallMs / 1000).toFixed(1)} s ${record.requests.map((r) => r.calls.join("+") || "answer").join(" > ")}${record.error ? ` ERROR ${record.error}` : ""}`,
      );
    }
  }),
);

results.sort((a, b) =>
  a.scenario === b.scenario ? a.repeat - b.repeat : a.scenario < b.scenario ? -1 : 1,
);
const sum = (pick: (record: RunRecord) => number) =>
  results.reduce((total, record) => total + pick(record), 0);
const summary = {
  label: values.label,
  model: modelName,
  transport,
  reasoning: values.reasoning,
  runs: results.length,
  modelRequests: sum((r) => r.modelRequests),
  discoveryOnlyRequests: sum((r) => r.discoveryOnlyRequests),
  discoveryCalls: sum((r) => r.discoveryCalls),
  needsMet: sum((r) => r.needsMet),
  needs: sum((r) => r.needs),
  meanWallSeconds: sum((r) => r.wallMs) / results.length / 1000,
  meanModelSecondsInDiscoveryOnly:
    sum((r) => r.requests.filter((q) => q.discoveryOnly).reduce((s, q) => s + q.durationMs, 0)) /
    results.length /
    1000,
  meanFirstActionSeconds:
    results.filter((r) => r.firstActionMs !== null).reduce((s, r) => s + r.firstActionMs!, 0) /
    Math.max(1, results.filter((r) => r.firstActionMs !== null).length) /
    1000,
  inputTokens: sum((r) => r.inputTokens),
  cachedTokens: sum((r) => r.cachedTokens),
  errors: results.filter((r) => r.error).length,
};
console.log(JSON.stringify(summary, null, 2));
if (values.out) writeFileSync(values.out, JSON.stringify({ summary, results }, null, 2));
