/**
 * Drive agent turns through the public session API (the same path as the web
 * app) and collect what the gate asserts on: tool calls with their arguments and
 * outputs, the final assistant text, and the terminal turn status.
 *
 * Scripted turns use the `directive` scenario of packages/testing/src/e2e-worker.ts:
 * the user message embeds `E2E-DIRECTIVE {"steps":[...]} E2E-END` and the model-free
 * worker calls each tool in order, then answers `E2E-REPORT {"tools","outputs"}`.
 */
import type { StackApi } from "./stack";

export type ToolCallRecord = {
  callId: string;
  /** Product tool name; native Responses items are normalized (apply_patch_call -> apply_patch). */
  name: string;
  /** Name as recorded on the event (for example `apply_patch_call` on the built-in OpenAI/Azure route). */
  rawName?: string;
  arguments: unknown;
  output?: unknown;
};

/**
 * On the built-in OpenAI/Azure Responses route the patch tool is the native
 * `apply_patch_call` item (event name and toolFamily `apply_patch_call`, the
 * operation in `raw.operation`); Gateway/Chat routes record a function call
 * named `apply_patch`. Normalize so scenarios match either.
 */
export function normalizeToolName(name: string): string {
  return name === "apply_patch_call" ? "apply_patch" : name;
}

export type TurnResult = {
  sessionId: string;
  url: string;
  status: "completed" | "failed" | "cancelled" | "timeout";
  failure?: { code?: string; message?: string };
  toolCalls: ToolCallRecord[];
  assistantText: string;
  events: SessionEvent[];
  durationMs: number;
};

export type SessionEvent = { sequence: number; type: string; data: any };

export type StartTurnOptions = {
  workspaceId: string;
  message: string;
  /** Existing session for a follow-up message. */
  sessionId?: string;
  model?: string;
  reasoningEffort?: string;
  /** Connected machine placement (sandboxId); defaults to the local sandbox backend. */
  machineSandboxId?: string;
  workingDir?: string;
  /** Extra create-session body fields (for example future `agent.capabilities.secrets`). */
  extraBody?: Record<string, unknown>;
  timeoutMs?: number;
};

export async function runTurn(api: StackApi, options: StartTurnOptions): Promise<TurnResult> {
  const started = Date.now();
  const base = `/v1/workspaces/${options.workspaceId}/sessions`;
  let sessionId = options.sessionId;
  let afterSequence = 0;
  if (sessionId) {
    afterSequence = await latestSequence(api, base, sessionId);
    await api.call("POST", `${base}/${sessionId}/messages`, { text: options.message });
  } else {
    const body: Record<string, unknown> = { initialMessage: options.message, ...options.extraBody };
    if (options.machineSandboxId) body.targetSandboxId = options.machineSandboxId;
    else body.sandboxBackend = "local";
    if (options.model) body.model = options.model;
    if (options.reasoningEffort) body.reasoningEffort = options.reasoningEffort;
    if (options.workingDir) body.workingDir = options.workingDir;
    const created = await api.call<any>("POST", base, body);
    sessionId = String(created.session?.id ?? created.id);
  }
  const url = `${api.stack.web}/workspaces/${options.workspaceId}/sessions/${sessionId}`;
  const events: SessionEvent[] = [];
  const calls = new Map<string, ToolCallRecord>();
  let assistantText = "";
  let status: TurnResult["status"] | undefined;
  let failure: TurnResult["failure"];
  const deadline = Date.now() + (options.timeoutMs ?? 300_000);
  while (!status && Date.now() < deadline) {
    const page = await api.call<any>(
      "GET",
      `${base}/${sessionId}/events?after=${afterSequence}&limit=500`,
    );
    const rows: any[] = Array.isArray(page) ? page : (page.events ?? page.items ?? []);
    for (const row of rows) {
      const sequence = Number(row.sequence ?? 0);
      if (sequence <= afterSequence) continue;
      afterSequence = sequence;
      const event: SessionEvent = {
        sequence,
        type: String(row.type ?? row.kind ?? ""),
        data: row.data ?? row.payload ?? {},
      };
      events.push(event);
      collectToolCall(event, calls);
      if (event.type === "agent.message.completed" || event.type === "message.completed") {
        const text = event.data.text ?? event.data.content ?? event.data.outputText;
        if (typeof text === "string") assistantText = text;
      }
      if (event.type === "turn.completed") status = "completed";
      if (event.type === "turn.failed" || event.type === "session.failed") {
        status = "failed";
        failure = {
          code: event.data.code ?? event.data.failureCode ?? event.data.error?.code,
          message: event.data.message ?? event.data.error?.message,
        };
      }
      if (event.type === "turn.cancelled") status = "cancelled";
    }
    if (!status) await Bun.sleep(1_000);
  }
  return {
    sessionId: sessionId!,
    url,
    status: status ?? "timeout",
    ...(failure ? { failure } : {}),
    toolCalls: [...calls.values()],
    assistantText,
    events,
    durationMs: Date.now() - started,
  };
}

async function latestSequence(api: StackApi, base: string, sessionId: string): Promise<number> {
  const page = await api.call<any>("GET", `${base}/${sessionId}/events?latest=1&limit=1`);
  const rows: any[] = Array.isArray(page) ? page : (page.events ?? page.items ?? []);
  return rows.reduce((max, row) => Math.max(max, Number(row.sequence ?? 0)), 0);
}

function collectToolCall(event: SessionEvent, calls: Map<string, ToolCallRecord>): void {
  const data = event.data;
  const callId = String(data.callId ?? data.toolCallId ?? data.id ?? "");
  if (!callId) return;
  if (event.type === "agent.toolCall.created") {
    const rawName = String(data.name ?? data.toolName ?? "");
    calls.set(callId, {
      callId,
      name: normalizeToolName(rawName),
      rawName,
      arguments: parseMaybeJson(data.arguments || data.input || data.raw?.operation),
    });
  } else if (event.type === "agent.toolCall.output") {
    const existing = calls.get(callId) ?? {
      callId,
      name: normalizeToolName(String(data.name ?? "")),
      arguments: null,
    };
    existing.output = data.output ?? data.result ?? data;
    calls.set(callId, existing);
  }
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export type DirectiveStep = { tool: string; args: unknown };

/** Message for the `directive` scripted scenario. */
export function directiveMessage(
  steps: DirectiveStep[],
  note = "secrets gate scripted turn",
): string {
  return `${note}\nE2E-DIRECTIVE ${JSON.stringify({ steps })} E2E-END`;
}

export function execStep(cmd: string, extra: Record<string, unknown> = {}): DirectiveStep {
  return {
    tool: "exec_command",
    args: { cmd, yield_time_ms: 10_000, max_output_tokens: 2_000, ...extra },
  };
}

export type DirectiveReport = { tools: string[]; outputs: string[]; error?: string };

export function parseDirectiveReport(text: string): DirectiveReport | null {
  const match = /E2E-REPORT\s*(\{[\s\S]*\})\s*$/u.exec(text.trim());
  if (!match) return null;
  try {
    return JSON.parse(match[1]!) as DirectiveReport;
  } catch {
    return null;
  }
}

/** Compact, value-free event trail for evidence (types, tool names, statuses). */
export function eventTrail(result: TurnResult): string[] {
  return result.events
    .filter((event) => /^(turn\.|agent\.toolCall|sandbox\.|credential\.|secret)/u.test(event.type))
    .map((event) => {
      const name = event.data?.name ?? event.data?.toolName ?? "";
      const code = event.data?.code ?? event.data?.failureCode ?? "";
      return `#${event.sequence} ${event.type}${name ? ` ${name}` : ""}${code ? ` code=${code}` : ""}`;
    });
}
