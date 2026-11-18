// Shared by the tool-call durability crash matrix and its killed child worker:
// the same offline runtime, scripted provider and tool in both processes.
import { appendFileSync } from "node:fs";
import { tool, type Model, type ModelRequest, type StreamEvent } from "@openai/agents";
import postgres from "postgres";
import { ScriptedModel, assistantMessage, functionCall } from "@opengeni/testing/scripted-model";
import { testSettings } from "@opengeni/testing/settings";
import { createProductionAgentRuntime, type OpenGeniRuntime } from "@opengeni/runtime";
import {
  recordModelTransportDispatched,
  recordModelTransportStarted,
} from "../../../../packages/runtime/src/model-preparation-diagnostics";

export type CrashLogEntry =
  | { kind: "response"; pid: number; step: ModelStep; responseId: string }
  | { kind: "billed"; pid: number; responseId: string }
  | { kind: "in_combined_write"; pid: number }
  | { kind: "fenced"; pid: number; action: string }
  | {
      kind: "tool_entry";
      pid: number;
      callId: string;
      pendingRows: number;
      createdEvents: number;
      usageInSameCommit: number;
    }
  | { kind: "tool"; pid: number; callId: string };

export type ModelStep = "call-0" | "call-1" | "final";

export function appendCrashLog(file: string, entry: CrashLogEntry): void {
  // Synchronous: written before the process can be killed after it.
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

export async function readCrashLog(file: string): Promise<CrashLogEntry[]> {
  const text = await Bun.file(file)
    .text()
    .catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CrashLogEntry);
}

function resultCallIds(input: ModelRequest["input"]): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(input)) return ids;
  for (const item of input as Array<Record<string, unknown>>) {
    if (item.type !== "function_call_result" && item.type !== "function_call_output") continue;
    const id = item.callId ?? item.call_id;
    if (typeof id === "string") ids.add(id);
  }
  return ids;
}

/** The step a model would take from the history it is shown. */
export function nextModelStep(input: ModelRequest["input"]): ModelStep {
  const done = resultCallIds(input);
  if (done.has("call-1")) return "final";
  if (done.has("call-0")) return "call-1";
  return "call-0";
}

/**
 * Answers from the history it is shown, like a real model: a call whose
 * result (even an interrupted one) is in history is not asked for again.
 * Every response has a fresh provider id, as a re-requested response would.
 */
export class HistoryScriptedModel implements Model {
  calls = 0;
  constructor(
    private readonly hooks: {
      beforeResponse?: (step: ModelStep) => void;
      onResponse?: (step: ModelStep, responseId: string) => void | Promise<void>;
      afterResponse?: (step: ModelStep) => void;
    } = {},
  ) {}

  async getResponse(): Promise<never> {
    throw new Error("HistoryScriptedModel only streams");
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    const step = nextModelStep(request.input);
    this.calls += 1;
    this.hooks.beforeResponse?.(step);
    // The same transport admission and dispatch boundaries a real HTTP provider passes.
    await recordModelTransportStarted();
    recordModelTransportDispatched(performance.now());
    const responseId = `resp-${step}-${crypto.randomUUID()}`;
    await this.hooks.onResponse?.(step, responseId);
    const output =
      step === "final"
        ? [assistantMessage("All steps done.")]
        : [functionCall("local_fixture", { step }, step)];
    yield* new ScriptedModel([{ id: responseId, output }]).getStreamedResponse(request);
    this.hooks.afterResponse?.(step);
  }
}

export function scriptedRuntime(
  scripted: Model,
  execute: (callId: string) => Promise<string>,
): OpenGeniRuntime {
  const production = createProductionAgentRuntime({ model: scripted });
  return {
    ...production,
    configure: () => {},
    resolveTurnModel: () => ({
      provider: {
        id: "test-chat",
        label: "Offline",
        kind: "api-key",
        api: "chat",
        builtin: false,
      } as never,
      client: {} as NonNullable<ReturnType<OpenGeniRuntime["resolveTurnModel"]>>["client"],
      model: scripted,
      configured: {
        id: "scripted-model",
        label: "Offline",
        providerId: "test-chat",
        providerLabel: "Offline",
        api: "chat",
        contextWindowTokens: 250_000,
        effectiveContextWindowTokens: 250_000,
        autoCompactTokenLimit: 225_000,
        reasoningEffort: false,
        hostedWebSearch: false,
      } as never,
    }),
    buildAgent: (...args) => {
      const agent = production.buildAgent(...args);
      agent.tools.push(
        tool({
          name: "local_fixture",
          description: "Offline step",
          parameters: {
            type: "object" as const,
            properties: {},
            required: [],
            additionalProperties: false as const,
          },
          strict: false,
          execute: async (_input: unknown, _context: unknown, details: unknown) => {
            const callId = (details as { toolCall?: { callId?: string } } | undefined)?.toolCall
              ?.callId;
            if (!callId) throw new Error("local_fixture ran without a call id");
            return await execute(callId);
          },
        }),
      );
      return agent;
    },
  };
}

/**
 * Superuser connection to the restricted test schema, for durable-state reads.
 * `adminUrl` is the shared harness's superuser URL for the test database.
 */
export function adminSql(adminUrl: string, schema: string): postgres.Sql {
  return postgres(adminUrl, {
    max: 2,
    onnotice: () => undefined,
    connection: { search_path: schema },
  });
}

/** What crash recovery can see of a call at this instant. */
export async function durableCallState(sql: postgres.Sql, sessionId: string, callId: string) {
  const [pending] = await sql<{ count: number }[]>`
    select count(*)::int as count from session_pending_tool_calls
    where session_id = ${sessionId} and call_id = ${callId}`;
  const [created] = await sql<{ count: number }[]>`
    select count(*)::int as count from session_events
    where session_id = ${sessionId} and type = 'agent.toolCall.created'
      and payload->>'id' = ${callId}`;
  // The response's usage committed in the same transaction as the call
  // (one transaction shares one `now()`).
  const [usage] = await sql<{ count: number }[]>`
    select count(*)::int as count from session_events usage_event
    join session_events created_event
      on created_event.session_id = usage_event.session_id
     and created_event.type = 'agent.toolCall.created'
     and created_event.payload->>'id' = ${callId}
     and created_event.created_at = usage_event.created_at
    where usage_event.session_id = ${sessionId} and usage_event.type = 'agent.model.usage'`;
  return {
    pendingRows: pending!.count,
    createdEvents: created!.count,
    usageInSameCommit: usage!.count,
  };
}

/** Credit billing on, so each response's ledger includes a credit debit. */
export function crashTestSettings(databaseUrl: string) {
  return testSettings({
    databaseUrl,
    openaiModel: "scripted-model",
    sandboxBackend: "none",
    billingMode: "stripe",
    modelPricingJson: JSON.stringify({
      "scripted-model": {
        inputMicrosPerMillionTokens: 1_000_000,
        outputMicrosPerMillionTokens: 1_000_000,
      },
    }),
  });
}
