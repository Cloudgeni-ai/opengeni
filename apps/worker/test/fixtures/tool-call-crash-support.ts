// Shared by the tool-call durability crash matrix and its killed child worker:
// the same offline runtime, scripted provider and tool in both processes.
import { appendFileSync } from "node:fs";
import { tool, type Model, type ModelRequest, type StreamEvent } from "@openai/agents";
import postgres from "postgres";
import { ScriptedModel, assistantMessage, functionCall } from "@opengeni/testing/scripted-model";
import { createProductionAgentRuntime, type OpenGeniRuntime } from "@opengeni/runtime";
import {
  recordModelTransportDispatched,
  recordModelTransportStarted,
} from "../../../../packages/runtime/src/model-preparation-diagnostics";

export type CrashLogEntry =
  | { kind: "response"; pid: number; step: ModelStep; responseId: string }
  | { kind: "billed"; pid: number; responseId: string }
  | {
      kind: "tool_entry";
      pid: number;
      callId: string;
      pendingRows: number;
      createdEvents: number;
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
      onResponse?: (step: ModelStep, responseId: string) => void;
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
    this.hooks.onResponse?.(step, responseId);
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

/** Superuser connection to the restricted test schema, for durable-state reads. */
export function adminSql(appUrl: string, schema: string): postgres.Sql {
  const url = new URL(appUrl);
  const base = new URL(process.env.OPENGENI_TEST_PG_URL ?? "postgres://postgres@127.0.0.1:5432/postgres");
  url.username = base.username;
  url.password = base.password;
  return postgres(url.toString(), {
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
  return { pendingRows: pending!.count, createdEvents: created!.count };
}
