import type { AgentEvent } from "./trajectory";
import { zeroUsage, type Task, type Usage } from "./types";

/**
 * Arms (a) and (d) as real Opengeni sessions: the unchanged agent on a Connected Machine whose
 * working directory holds the repository snapshot, driven through the public REST API exactly as
 * the benchmark runner drives it (fresh workspace, unattended session, learning off). Nothing here
 * changes Opengeni's prompt; the task text below is the benchmark's question, the same for every arm.
 */
export function findCodeInstruction(task: Task, root = "/app"): string {
  return [
    `The repository at ${root} is checked out at the commit where the issue below was reported.`,
    "Find the code a developer needs to read or change to resolve it. Do not modify any files.",
    `Finish with a ranked list of the relevant locations, most important first, one per line as \`path:start-end\` (paths relative to ${root}).`,
    "",
    "Issue:",
    task.query,
  ].join("\n");
}

/** Workspace settings for a benchmark attempt (the runner's), with code search off unless asked. */
export const ATTEMPT_SETTINGS = {
  codeSearchEnabled: false,
  allowCreditModels: false,
  maxNestedAgentDepth: 0,
  agentHumanInputEnabled: false,
};

const BUSY = new Set(["running", "queued", "recovering", "waiting_capacity"]);
export type SessionSnapshot = {
  status?: string;
  activeTurnId?: string | null;
  inputWait?: unknown;
  effectiveControl?: { state?: string; settlement?: unknown } | null;
};

/** The runner's busy rule: a running/queued status, or an active turn that is not a settled pause. */
export function sessionBusy(s: SessionSnapshot): boolean {
  if (BUSY.has(String(s.status))) return true;
  const c = s.effectiveControl ?? {};
  const pausedSettled = c.state === "paused" && !c.settlement;
  return Boolean(s.activeTurnId) && !pausedSettled;
}

export const TERMINAL_TURN = new Set([
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
]);

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).join("");
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    return text(v.text ?? v.content ?? v.message ?? "");
  }
  return "";
}

/** The agent's last completed message. */
export function finalAnswer(events: AgentEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--)
    if (events[i]!.type === "agent.message.completed")
      return text(events[i]!.payload);
  return "";
}

/** Token and call totals from per-call usage records; subscription calls are priced API-equivalent. */
export function usageFromEvents(events: AgentEvent[]): Usage & {
  purposes: Record<string, number>;
  models: string[];
} {
  const usage = zeroUsage();
  const purposes: Record<string, number> = {};
  const models = new Set<string>();
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;
  for (const e of events) {
    const p = e.payload ?? {};
    if (e.type === "agent.model.usage") {
      usage.inputTokens += num(p.inputTokens);
      usage.cachedInputTokens += num(p.cachedTokens);
      usage.outputTokens += num(p.outputTokens);
      usage.apiEquivalentUsd += num(p.estimatedProviderCostMicros) / 1e6;
      usage.modelCalls++;
      const purpose = String(p.purpose ?? "unknown");
      purposes[purpose] = (purposes[purpose] ?? 0) + 1;
      if (typeof p.model === "string") models.add(p.model);
    } else if (e.type === "agent.toolCall.created") usage.toolCalls++;
  }
  return { ...usage, purposes, models: [...models] };
}

/** Shell commands that reach outside the snapshot (fetching upstream history would leak the fix). */
export function networkCommands(events: AgentEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.type !== "agent.toolCall.created") continue;
    const raw = e.payload?.arguments;
    const cmd = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
    if (
      /\b(curl|wget|git\s+(fetch|clone|pull|remote)|pip\s+download|gh\s)/.test(
        cmd,
      )
    )
      out.push(cmd.slice(0, 300));
  }
  return out;
}

export class OpengeniApi {
  private contract = "";
  constructor(
    readonly base: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async init(): Promise<{ deploymentRevision?: string }> {
    const config = (await this.call("GET", "/v1/config/client")) as {
      apiContractRevision: string;
      deploymentRevision?: string;
    };
    this.contract = config.apiContractRevision;
    return config;
  }

  async raw(
    method: string,
    path: string,
    body?: unknown,
    attempt = 0,
  ): Promise<{ data: unknown; headers: Headers }> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.contract) headers["x-opengeni-api-contract"] = this.contract;
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetchImpl(this.base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (error) {
      if (method === "GET" && attempt < 5) {
        await Bun.sleep(1500 * 2 ** attempt);
        return this.raw(method, path, body, attempt + 1);
      }
      throw error;
    }
    const textBody = await res.text();
    if (!res.ok) {
      if (
        res.status === 409 &&
        textBody.includes("API_CONTRACT_CHANGED") &&
        attempt < 3
      ) {
        this.contract =
          JSON.parse(textBody).apiContractRevision ?? this.contract;
        return this.raw(method, path, body, attempt + 1);
      }
      if (
        (res.status >= 500 || res.status === 429) &&
        method === "GET" &&
        attempt < 5
      ) {
        await Bun.sleep(1500 * 2 ** attempt);
        return this.raw(method, path, body, attempt + 1);
      }
      throw new Error(
        `${method} ${path.split("?")[0]} -> ${res.status}: ${textBody.slice(0, 500)}`,
      );
    }
    return {
      data: textBody ? JSON.parse(textBody) : null,
      headers: res.headers,
    };
  }

  async call(method: string, path: string, body?: unknown): Promise<unknown> {
    return (await this.raw(method, path, body)).data;
  }

  /** Every non-delta event after a sequence, following the API's paging headers. */
  async events(
    workspace: string,
    session: string,
    after = 0,
  ): Promise<AgentEvent[]> {
    const out: AgentEvent[] = [];
    let cursor = after;
    for (;;) {
      const { data, headers } = await this.raw(
        "GET",
        `/v1/workspaces/${workspace}/sessions/${session}/events?after=${cursor}&limit=1000&mode=forensic&payloadMode=full&excludeTypes=agent.message.delta,agent.reasoning.delta,sandbox.command.output.delta`,
      );
      const batch = (
        Array.isArray(data)
          ? data
          : ((data as { events?: unknown[] })?.events ?? [])
      ) as (AgentEvent & { sequence: number })[];
      for (const e of batch) {
        cursor = Math.max(cursor, Number(e.sequence));
        out.push(e);
      }
      const next = headers.get("x-opengeni-next-after");
      if (next) cursor = Math.max(cursor, Number(next));
      const more = headers.get("x-opengeni-has-more") === "true";
      if ((!more && batch.length < 1000) || (!batch.length && !next))
        return out;
    }
  }
}
