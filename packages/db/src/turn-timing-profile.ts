import { agentToolCallOutcome, agentToolMetricFamily } from "@opengeni/observability";

/**
 * Where the wall time of one finished logical turn went, rebuilt from the
 * session event log. Pure: the store loads the turn, its attempts and a
 * content-free projection of its events, and this module turns them into
 * exclusive segments that add up to the turn's wall time, plus an ordered list
 * of steps (model requests, tool calls, sandbox operations, waits) with their
 * own start, end and duration.
 *
 * Bump the version whenever the attribution rules change; stored profiles keep
 * the version that computed them.
 */
export const TURN_TIMING_PROFILE_VERSION = 2;

/**
 * Exclusive wall-time categories. Every millisecond between the turn's
 * creation and its finish lands in exactly one of them.
 *
 * - queue: accepted, not yet started by a worker.
 * - turn_start: the first attempt started, before its first model request,
 *   tool or sandbox operation.
 * - dispatch: Opengeni work right before a model request reaches the provider.
 * - model_inference / model_provider_other / model_network: a model request
 *   split by the provider's own server timing (engine time, the rest of the
 *   provider's handling, and what remains of the request: transport and
 *   network).
 * - model_unsplit: a successful model request whose provider reports no
 *   server timing.
 * - model_stalled: a model request that failed, timed out or never finished.
 * - compaction: compacting the conversation's context inside the turn, from
 *   its start until it was compacted or skipped, including its own model call.
 * - web_search: hosted web search inside a model request, and web tools.
 * - mcp_tool: tools served by a remote MCP server (custom or integration).
 * - sandbox_tool: shell, patch and code-mode tools that run in the sandbox.
 * - own_tool: every other first-party tool.
 * - sandbox_setup: sandbox lifecycle operations (provision, resume, ...).
 * - human_wait: waiting for an approval or an answer from a person.
 * - capacity_wait: waiting for provider capacity.
 * - after_model / after_tool: Opengeni time between steps, named by what came
 *   before.
 * - recovery: between attempts, and before the first step of a later attempt.
 * - turn_end: after the last step until the turn was settled.
 */
export const TURN_TIMING_CATEGORIES = [
  "queue",
  "turn_start",
  "dispatch",
  "model_inference",
  "model_provider_other",
  "model_network",
  "model_unsplit",
  "model_stalled",
  "compaction",
  "web_search",
  "mcp_tool",
  "sandbox_tool",
  "own_tool",
  "sandbox_setup",
  "human_wait",
  "capacity_wait",
  "after_model",
  "after_tool",
  "recovery",
  "turn_end",
] as const;
export type TurnTimingCategory = (typeof TURN_TIMING_CATEGORIES)[number];
export type TurnTimingSegments = Record<TurnTimingCategory, number>;

export type TurnTimingTurn = {
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date;
};

export type TurnTimingAttempt = {
  id: string;
  startedAt: Date;
  closedAt: Date | null;
  outcome: string | null;
};

/** One session event with the content-free payload projection the store reads. */
export type TurnTimingEvent = {
  type: string;
  sequence: number;
  occurredAt: Date;
  attemptId: string | null;
  payload: Record<string, unknown>;
};

export type TurnTimingStepKind =
  | "attempt"
  | "startup"
  | "model"
  | "tool"
  | "web_search"
  | "sandbox"
  | "compaction"
  | "human_wait"
  | "capacity_wait";

/**
 * One step of the turn. `ms` is its own duration; `exclusiveMs` is the part
 * of the turn's wall time attributed to it after overlaps (parallel tools
 * share time, a model request outranks the sandbox and tools, and so on).
 * Timestamps are ISO strings so products can join their own logs.
 */
export type TurnTimingStep = {
  kind: TurnTimingStepKind;
  start: string;
  end: string;
  ms: number;
  exclusiveMs?: number;
  category?: TurnTimingCategory;
  attemptId?: string;
  name?: string;
  callId?: string;
  family?: string;
  outcome?: string;
  requestId?: string;
  provider?: string;
  model?: string;
  purpose?: string;
  dispatchMs?: number;
  preDispatchMs?: number;
  inferenceMs?: number;
  providerOtherMs?: number;
  networkMs?: number;
  timeToFirstTokenMs?: number;
};

export type TurnTimingProfile = {
  version: number;
  wallMs: number;
  segments: TurnTimingSegments;
  provider: string | null;
  attempts: number;
  modelRequests: number;
  toolCalls: number;
  steps: TurnTimingStep[];
};

/** Event types the store loads for a profile; everything else is ignored. */
export const TURN_TIMING_EVENT_TYPES = [
  "turn.started",
  "turn.recovery.requested",
  "turn.capacity_waiting",
  "turn.startup.phase.completed",
  "agent.model.request",
  "agent.model.usage",
  "agent.toolCall.created",
  "agent.toolCall.output",
  "sandbox.operation.started",
  "sandbox.operation.completed",
  "sandbox.operation.failed",
  "session.context.compaction.started",
  "session.context.compacted",
  "session.context.compaction.skipped",
  "session.requiresAction",
  "user.approvalDecision",
  "session.humanInput.requested",
  "user.humanInputResponse",
  "codex.capacity.waiting",
  "codex.capacity.resumed",
  "codex.capacity.superseded",
] as const;

const TERMINAL_REQUEST_PHASES = new Set(["completed", "failed", "timed_out"]);
const HOSTED_WEB_SEARCH = "web_search_call";
const MCP_FAMILIES = new Set(["custom_mcp", "integration"]);
const SANDBOX_TOOL_FAMILIES = new Set(["shell", "apply_patch", "codemode"]);
// Tools that block until a person answers. `wait_for_input` only ends the
// turn, so it stays an ordinary tool.
const HUMAN_TOOL_NAMES = new Set(["request_human_input", "interaction_request_human"]);
const FIRST_PARTY_PREFIX = /^(?:opengeni|interaction)__/;

// Higher wins where intervals overlap. Equal ranks share the time equally.
const RANK = {
  wait: 7,
  hostedSearch: 6,
  // A compaction owns its whole interval, its own model call included: not
  // every provider path audits that call as a model request.
  compaction: 5,
  model: 4,
  sandbox: 3,
  tool: 2,
  dispatch: 1,
} as const;

type Weights = Partial<Record<TurnTimingCategory, number>>;
type Interval = {
  start: number;
  end: number;
  rank: number;
  weights: Weights;
  /** What kind of work this is, for naming the gap after it. */
  after: "model" | "tool" | null;
  step: TurnTimingStep | null;
  exclusive: number;
};

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegative(value: unknown): number | null {
  const number = finite(value);
  return number !== null && number >= 0 ? number : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function round(value: number): number {
  return Math.round(value);
}

/**
 * The tool a call actually ran. A router call (`tool_invoke`) names the
 * invoked tool in its arguments; the projection keeps only that name.
 */
function invokedToolName(payload: Record<string, unknown>): string | null {
  const args = payload.arguments;
  const fromObject = text(record(args)?.name);
  if (fromObject) return fromObject;
  if (typeof args === "string") {
    const match = /"name"\s*:\s*"([^"]{1,255})"/.exec(args);
    if (match?.[1]) return match[1];
  }
  return null;
}

/** Closed tool family, recognising remote MCP tools whose family was not stamped. */
export function turnTimingToolFamily(toolFamily: string | null, name: string): string {
  const family = agentToolMetricFamily(toolFamily, name);
  if (family !== "other" || toolFamily) return family;
  // Older events and router-invoked tools carry no stamped family. A
  // server-prefixed name that is not first-party belongs to a remote server.
  return name.includes("__") && !FIRST_PARTY_PREFIX.test(name) ? "custom_mcp" : family;
}

export function turnTimingToolCategory(family: string, name: string): TurnTimingCategory {
  if (name === HOSTED_WEB_SEARCH || family === "web") return "web_search";
  if (MCP_FAMILIES.has(family)) return "mcp_tool";
  if (SANDBOX_TOOL_FAMILIES.has(family)) return "sandbox_tool";
  if (family === "human_handoff" || HUMAN_TOOL_NAMES.has(name.replace(FIRST_PARTY_PREFIX, ""))) {
    return "human_wait";
  }
  return "own_tool";
}

function emptySegments(): TurnTimingSegments {
  return Object.fromEntries(TURN_TIMING_CATEGORIES.map((category) => [category, 0])) as Record<
    TurnTimingCategory,
    number
  >;
}

/**
 * Round fractional milliseconds to whole ones that still add up to the wall
 * time (largest remainder), so a profile's segments always sum exactly.
 */
function roundSegments(raw: TurnTimingSegments, wallMs: number): TurnTimingSegments {
  const rounded = emptySegments();
  const remainders: Array<[TurnTimingCategory, number]> = [];
  let total = 0;
  for (const category of TURN_TIMING_CATEGORIES) {
    const value = Math.max(0, raw[category]);
    const floor = Math.floor(value);
    rounded[category] = floor;
    total += floor;
    remainders.push([category, value - floor]);
  }
  remainders.sort((a, b) => b[1] - a[1]);
  let missing = wallMs - total;
  for (let index = 0; missing > 0 && remainders.length > 0; index++, missing--) {
    rounded[remainders[index % remainders.length]![0]] += 1;
  }
  return rounded;
}

type ModelRequest = {
  attemptId: string | null;
  key: string;
  start: number;
  end: number;
  terminal: boolean;
  phase: string;
  provider: string | null;
  model: string | null;
  requestId: string | null;
  dispatchDelayMs: number;
  server: { inference: number; providerOther: number } | null;
  usage: Record<string, unknown> | null;
  usageTiming: Record<string, unknown> | null;
};

function serverTiming(payload: Record<string, unknown>) {
  const server = record(record(record(payload.transport)?.timing)?.server);
  if (!server) return null;
  const inference = nonNegative(server.engineWallMs);
  const pre = nonNegative(server.responsesPreInferenceMs);
  const other = nonNegative(server.responsesOtherMs);
  if (inference === null && pre === null && other === null) return null;
  return { inference: inference ?? 0, providerOther: (pre ?? 0) + (other ?? 0) };
}

/**
 * Pair model request phases into requests. A request id (with its transport
 * attempt) identifies a request when the provider path reports one; otherwise
 * each terminal phase closes the open request of its attempt and dispatch.
 */
function modelRequests(
  events: TurnTimingEvent[],
  fallbackEnd: (attemptId: string | null) => number,
) {
  const requests: ModelRequest[] = [];
  const open = new Map<string, { start: number; payload: Record<string, unknown> }>();
  let unkeyed = 0;
  for (const event of events) {
    if (event.type !== "agent.model.request") continue;
    const payload = event.payload;
    const phase = text(payload.phase) ?? "";
    const requestId = text(payload.requestId);
    const scope = `${event.attemptId ?? ""}|${text(payload.dispatchId) ?? ""}`;
    const key = requestId
      ? `${scope}|${requestId}|${finite(payload.transportAttempt) ?? ""}`
      : `${scope}|`;
    const at = event.occurredAt.getTime();
    if (phase === "started") {
      if (!open.has(key)) open.set(key, { start: at, payload });
      continue;
    }
    if (!TERMINAL_REQUEST_PHASES.has(phase)) {
      if (!open.has(key)) {
        const duration = nonNegative(payload.durationMs);
        open.set(key, { start: duration === null ? at : at - duration, payload });
      }
      continue;
    }
    const started = open.get(key);
    open.delete(key);
    const duration = nonNegative(payload.durationMs);
    const start = duration !== null ? at - duration : (started?.start ?? at);
    requests.push({
      attemptId: event.attemptId,
      key: requestId ? key : `${key}${unkeyed++}`,
      start,
      end: at,
      terminal: true,
      phase,
      provider: text(payload.provider) ?? text(started?.payload.provider),
      model: text(payload.model) ?? text(started?.payload.model),
      requestId,
      dispatchDelayMs: nonNegative(payload.dispatchDelayMs) ?? 0,
      server: phase === "completed" ? serverTiming(payload) : null,
      usage: null,
      usageTiming: null,
    });
  }
  // A request that never reached a terminal phase ran until its attempt ended.
  for (const [key, started] of open) {
    const attemptId = key.split("|")[0] || null;
    requests.push({
      attemptId,
      key,
      start: started.start,
      end: Math.max(started.start, fallbackEnd(attemptId)),
      terminal: false,
      phase: "incomplete",
      provider: text(started.payload.provider),
      model: text(started.payload.model),
      requestId: text(started.payload.requestId),
      dispatchDelayMs: 0,
      server: null,
      usage: null,
      usageTiming: null,
    });
  }
  requests.sort((a, b) => a.start - b.start || a.end - b.end);
  // A request left open cannot outlast the next request of its attempt.
  for (const request of requests) {
    if (request.terminal) continue;
    const next = requests.find(
      (other) =>
        other !== request && other.attemptId === request.attemptId && other.start > request.start,
    );
    if (next) request.end = Math.max(request.start, Math.min(request.end, next.start));
  }
  return requests;
}

function modelWeights(request: ModelRequest): { weights: Weights; split: Partial<TurnTimingStep> } {
  const duration = request.end - request.start;
  if (request.phase !== "completed" || duration <= 0) {
    return { weights: { model_stalled: 1 }, split: {} };
  }
  const dispatch = Math.min(request.dispatchDelayMs, duration);
  const remaining = duration - dispatch;
  if (!request.server) {
    return {
      weights: { dispatch: dispatch / duration, model_unsplit: remaining / duration },
      split: dispatch > 0 ? { dispatchMs: round(dispatch) } : {},
    };
  }
  let { inference, providerOther } = request.server;
  const serverTotal = inference + providerOther;
  // Clocks differ between the provider and the worker. When the provider
  // reports more than the worker measured, scale it down to fit.
  if (serverTotal > remaining && serverTotal > 0) {
    inference = (inference * remaining) / serverTotal;
    providerOther = (providerOther * remaining) / serverTotal;
  }
  const network = Math.max(0, remaining - inference - providerOther);
  return {
    weights: {
      dispatch: dispatch / duration,
      model_inference: inference / duration,
      model_provider_other: providerOther / duration,
      model_network: network / duration,
    },
    split: {
      ...(dispatch > 0 ? { dispatchMs: round(dispatch) } : {}),
      inferenceMs: round(inference),
      providerOtherMs: round(providerOther),
      networkMs: round(network),
    },
  };
}

/**
 * Compute a turn's profile. Event timestamps are clamped into the turn's
 * lifetime (worker and database clocks may differ slightly), so the segments
 * always add up to the wall time.
 */
export function computeTurnTimingProfile(input: {
  turn: TurnTimingTurn;
  attempts: readonly TurnTimingAttempt[];
  events: readonly TurnTimingEvent[];
}): TurnTimingProfile {
  const created = input.turn.createdAt.getTime();
  const finished = Math.max(created, input.turn.finishedAt.getTime());
  const wallMs = round(finished - created);
  const clamp = (value: number) => Math.min(finished, Math.max(created, value));
  const events = [...input.events].sort(
    (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.sequence - b.sequence,
  );
  const attempts = [...input.attempts].sort(
    (a, b) => a.startedAt.getTime() - b.startedAt.getTime(),
  );
  const attemptEnd = new Map<string, number>();
  for (const attempt of attempts) {
    attemptEnd.set(attempt.id, clamp(attempt.closedAt?.getTime() ?? finished));
  }
  const fallbackEnd = (attemptId: string | null) =>
    (attemptId ? attemptEnd.get(attemptId) : undefined) ?? finished;

  const intervals: Interval[] = [];
  const steps: TurnTimingStep[] = [];
  const add = (
    start: number,
    end: number,
    rank: number,
    weights: Weights,
    after: Interval["after"],
    step: TurnTimingStep | null,
  ) => {
    const from = clamp(start);
    const to = clamp(Math.max(start, end));
    if (step) steps.push(step);
    if (to > from)
      intervals.push({ start: from, end: to, rank, weights, after, step, exclusive: 0 });
  };
  const step = (
    kind: TurnTimingStepKind,
    start: number,
    end: number,
    extra: Partial<TurnTimingStep>,
  ) =>
    ({
      kind,
      start: iso(start),
      end: iso(Math.max(start, end)),
      ms: round(Math.max(0, end - start)),
      ...extra,
    }) as TurnTimingStep;

  for (const attempt of attempts) {
    const start = attempt.startedAt.getTime();
    const end = attempt.closedAt?.getTime() ?? finished;
    steps.push(
      step("attempt", start, end, {
        attemptId: attempt.id,
        ...(attempt.outcome ? { outcome: attempt.outcome } : {}),
      }),
    );
  }

  // Model requests, with their usage receipt (model, purpose, timing).
  const requests = modelRequests(events, fallbackEnd);
  let provider: string | null = null;
  const providerCounts = new Map<string, number>();
  for (const event of events) {
    if (event.type !== "agent.model.usage") continue;
    const at = event.occurredAt.getTime();
    const match = [...requests]
      .reverse()
      .find(
        (request) =>
          !request.usage &&
          request.phase === "completed" &&
          request.end <= at &&
          (request.attemptId === null ||
            event.attemptId === null ||
            request.attemptId === event.attemptId),
      );
    if (match) {
      match.usage = event.payload;
      match.usageTiming = record(event.payload.timing);
      continue;
    }
    // A model call with no request audit (an auxiliary call): its usage
    // timing still says when it ran.
    const timing = record(event.payload.timing);
    const duration = nonNegative(timing?.durationMs);
    if (duration === null) continue;
    requests.push({
      attemptId: event.attemptId,
      key: `usage:${event.sequence}`,
      start: at - duration,
      end: at,
      terminal: true,
      phase: "completed",
      provider: text(event.payload.provider),
      model: text(event.payload.model),
      requestId: null,
      dispatchDelayMs: 0,
      server: null,
      usage: event.payload,
      usageTiming: timing,
    });
  }
  for (const request of requests) {
    const usageProvider = text(request.usage?.provider) ?? request.provider;
    if (usageProvider && (request.usage?.purpose ?? "main") === "main") {
      providerCounts.set(usageProvider, (providerCounts.get(usageProvider) ?? 0) + 1);
    }
    const { weights, split } = modelWeights(request);
    const preDispatch = nonNegative(request.usageTiming?.preDispatchMs);
    const ttft = nonNegative(request.usageTiming?.timeToFirstTokenMs);
    const model = text(request.usage?.model) ?? request.model;
    const purpose = text(request.usage?.purpose);
    const modelStep = step("model", request.start, request.end, {
      category:
        request.phase === "completed"
          ? request.server
            ? "model_inference"
            : "model_unsplit"
          : "model_stalled",
      ...(request.attemptId ? { attemptId: request.attemptId } : {}),
      ...(request.requestId ? { requestId: request.requestId } : {}),
      ...(usageProvider ? { provider: usageProvider } : {}),
      ...(model ? { model } : {}),
      ...(purpose ? { purpose } : {}),
      outcome: request.phase,
      ...split,
      ...(preDispatch !== null ? { preDispatchMs: round(preDispatch) } : {}),
      ...(ttft !== null ? { timeToFirstTokenMs: round(ttft) } : {}),
    });
    add(request.start, request.end, RANK.model, weights, "model", modelStep);
    if (preDispatch !== null && preDispatch > 0) {
      // Opengeni work from the model call's entry to its first dispatch.
      const dispatchAt =
        request.start + Math.min(request.dispatchDelayMs, request.end - request.start);
      add(dispatchAt - preDispatch, dispatchAt, RANK.dispatch, { dispatch: 1 }, null, null);
    }
  }
  let best = 0;
  for (const [name, count] of providerCounts) {
    if (count > best) {
      best = count;
      provider = name;
    }
  }

  // Tool calls: first sighting to output. Hosted web search is a provider
  // step inside the model request; its sightings bound it.
  const calls = new Map<
    string,
    {
      first: TurnTimingEvent;
      last: TurnTimingEvent;
      output: TurnTimingEvent | null;
    }
  >();
  for (const event of events) {
    if (event.type !== "agent.toolCall.created" && event.type !== "agent.toolCall.output") continue;
    const id = text(event.payload.id);
    if (!id) continue;
    const key = `${event.attemptId ?? ""}|${id}`;
    const existing = calls.get(key);
    if (event.type === "agent.toolCall.created") {
      if (!existing) calls.set(key, { first: event, last: event, output: null });
      else existing.last = event;
    } else if (existing && !existing.output) {
      existing.output = event;
    }
  }
  let toolCalls = 0;
  for (const call of calls.values()) {
    const createdPayload = call.first.payload;
    const rawName = text(createdPayload.name) ?? "tool";
    const start = call.first.occurredAt.getTime();
    const callId = text(createdPayload.id) ?? undefined;
    const attemptId = call.first.attemptId ?? undefined;
    if (rawName === HOSTED_WEB_SEARCH) {
      const end = (call.output ?? call.last).occurredAt.getTime();
      add(
        start,
        end,
        RANK.hostedSearch,
        { web_search: 1 },
        "model",
        step("web_search", start, end, {
          category: "web_search",
          name: rawName,
          ...(callId ? { callId } : {}),
          ...(attemptId ? { attemptId } : {}),
        }),
      );
      continue;
    }
    toolCalls += 1;
    const invoked = rawName === "tool_invoke" ? invokedToolName(createdPayload) : null;
    const name = invoked ?? rawName;
    const family = turnTimingToolFamily(invoked ? null : text(createdPayload.toolFamily), name);
    const category = turnTimingToolCategory(family, name);
    const end = call.output ? call.output.occurredAt.getTime() : fallbackEnd(call.first.attemptId);
    const output = call.output?.payload;
    const outcome = output ? agentToolCallOutcome(output) : "incomplete";
    add(
      start,
      end,
      RANK.tool,
      { [category]: 1 },
      "tool",
      step("tool", start, end, {
        category,
        name,
        family,
        ...(callId ? { callId } : {}),
        ...(attemptId ? { attemptId } : {}),
        outcome,
      }),
    );
  }

  // Sandbox lifecycle operations, paired by name within an attempt.
  const openSandbox = new Map<string, TurnTimingEvent>();
  const closeSandbox = (started: TurnTimingEvent, end: number, outcome: string) => {
    const start = started.occurredAt.getTime();
    const name = text(started.payload.name) ?? "sandbox";
    add(
      start,
      end,
      RANK.sandbox,
      { sandbox_setup: 1 },
      "tool",
      step("sandbox", start, end, {
        category: "sandbox_setup",
        name,
        outcome,
        ...(started.attemptId ? { attemptId: started.attemptId } : {}),
      }),
    );
  };
  for (const event of events) {
    if (!event.type.startsWith("sandbox.operation.")) continue;
    const key = `${event.attemptId ?? ""}|${text(event.payload.name) ?? ""}`;
    if (event.type === "sandbox.operation.started") {
      if (!openSandbox.has(key)) openSandbox.set(key, event);
      continue;
    }
    const started = openSandbox.get(key);
    if (!started) continue;
    openSandbox.delete(key);
    closeSandbox(
      started,
      event.occurredAt.getTime(),
      event.type === "sandbox.operation.completed" ? "completed" : "failed",
    );
  }
  for (const started of openSandbox.values()) {
    closeSandbox(started, fallbackEnd(started.attemptId), "incomplete");
  }

  // Context compactions inside the turn, from their start until the context
  // was compacted or the compaction was skipped (or the attempt ended).
  const openCompaction = new Map<string, TurnTimingEvent>();
  const closeCompaction = (started: TurnTimingEvent, end: number, outcome: string) => {
    const start = started.occurredAt.getTime();
    const trigger = text(started.payload.trigger);
    add(
      start,
      end,
      RANK.compaction,
      { compaction: 1 },
      "model",
      step("compaction", start, end, {
        category: "compaction",
        outcome,
        ...(trigger ? { name: trigger } : {}),
        ...(started.attemptId ? { attemptId: started.attemptId } : {}),
      }),
    );
  };
  for (const event of events) {
    if (!event.type.startsWith("session.context.compact")) continue;
    const key = event.attemptId ?? "";
    if (event.type === "session.context.compaction.started") {
      if (!openCompaction.has(key)) openCompaction.set(key, event);
      continue;
    }
    const started = openCompaction.get(key);
    if (!started) continue;
    openCompaction.delete(key);
    closeCompaction(
      started,
      event.occurredAt.getTime(),
      event.type === "session.context.compacted" ? "completed" : "skipped",
    );
  }
  for (const started of openCompaction.values()) {
    closeCompaction(started, fallbackEnd(started.attemptId), "incomplete");
  }

  // Waits for a person and for provider capacity: from the request to the
  // answer (or the next start of the turn, or its end).
  const waitPairs: Array<{
    kind: "human_wait" | "capacity_wait";
    starts: (type: string) => boolean;
    ends: (type: string) => boolean;
  }> = [
    {
      kind: "human_wait",
      starts: (type) =>
        type === "session.requiresAction" || type === "session.humanInput.requested",
      ends: (type) => type === "user.approvalDecision" || type === "user.humanInputResponse",
    },
    {
      kind: "capacity_wait",
      starts: (type) => type.endsWith(".capacity.waiting") || type === "turn.capacity_waiting",
      ends: (type) =>
        type.endsWith(".capacity.resumed") ||
        type.endsWith(".capacity.superseded") ||
        type === "turn.started",
    },
  ];
  for (const pair of waitPairs) {
    let open: TurnTimingEvent | null = null;
    const close = (end: number) => {
      if (!open) return;
      const start = open.occurredAt.getTime();
      add(
        start,
        end,
        RANK.wait,
        { [pair.kind]: 1 },
        "tool",
        step(pair.kind, start, end, { category: pair.kind }),
      );
      open = null;
    };
    for (const event of events) {
      if (pair.starts(event.type)) {
        open ??= event;
      } else if (pair.ends(event.type)) {
        close(event.occurredAt.getTime());
      }
    }
    close(finished);
  }

  for (const event of events) {
    if (event.type !== "turn.startup.phase.completed") continue;
    const duration = nonNegative(event.payload.durationMs);
    const name = text(event.payload.phase);
    if (duration === null || !name) continue;
    const end = event.occurredAt.getTime();
    steps.push(
      step("startup", end - duration, end, {
        name,
        ...(event.attemptId ? { attemptId: event.attemptId } : {}),
      }),
    );
  }

  const raw = attribute({
    created,
    finished,
    intervals,
    attempts: attempts.map((attempt) => ({
      start: clamp(attempt.startedAt.getTime()),
      end: attemptEnd.get(attempt.id)!,
    })),
    firstStart: turnFirstStart(input.turn, attempts, events, clamp),
  });
  for (const interval of intervals) {
    if (interval.step) interval.step.exclusiveMs = round(interval.exclusive);
  }
  steps.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  return {
    version: TURN_TIMING_PROFILE_VERSION,
    wallMs,
    segments: roundSegments(raw, wallMs),
    provider,
    attempts: attempts.length,
    modelRequests: requests.length,
    toolCalls,
    steps,
  };
}

function turnFirstStart(
  turn: TurnTimingTurn,
  attempts: readonly TurnTimingAttempt[],
  events: readonly TurnTimingEvent[],
  clamp: (value: number) => number,
): number | null {
  const candidates = [
    turn.startedAt?.getTime(),
    attempts[0]?.startedAt.getTime(),
    events.find((event) => event.type === "turn.started")?.occurredAt.getTime(),
  ].filter((value): value is number => value !== undefined && Number.isFinite(value));
  return candidates.length > 0 ? clamp(Math.min(...candidates)) : null;
}

/**
 * Sweep the turn's lifetime once. At each instant the highest-ranked active
 * intervals own the time (equal ranks share it); an instant with no step is
 * named by its context: queue before the turn started, recovery between
 * attempts and before a later attempt's first step, turn_start before the
 * first step, turn_end after the last one, and otherwise after_model or
 * after_tool by the step that came before.
 */
function attribute(input: {
  created: number;
  finished: number;
  intervals: Interval[];
  attempts: Array<{ start: number; end: number }>;
  firstStart: number | null;
}): TurnTimingSegments {
  const segments = emptySegments();
  const { created, finished, intervals, attempts, firstStart } = input;
  if (finished <= created) return segments;
  const lastActivity = intervals.reduce(
    (latest, interval) => Math.max(latest, interval.end),
    -Infinity,
  );
  const boundaries = new Set<number>([created, finished]);
  if (firstStart !== null) boundaries.add(firstStart);
  for (const interval of intervals) {
    boundaries.add(interval.start);
    boundaries.add(interval.end);
  }
  for (const attempt of attempts) {
    boundaries.add(attempt.start);
    boundaries.add(attempt.end);
  }
  const points = [...boundaries]
    .filter((point) => point >= created && point <= finished)
    .sort((a, b) => a - b);
  const byStart = [...intervals].sort((a, b) => a.start - b.start);
  const active = new Set<Interval>();
  let cursor = 0;
  let lastAfter: Interval["after"] = null;
  let currentAttempt = -1;
  let activityInAttempt = false;
  for (let index = 0; index + 1 < points.length; index++) {
    const from = points[index]!;
    const to = points[index + 1]!;
    const length = to - from;
    while (cursor < byStart.length && byStart[cursor]!.start <= from) {
      active.add(byStart[cursor]!);
      cursor++;
    }
    for (const interval of active) if (interval.end <= from) active.delete(interval);
    const attemptIndex = attempts.findIndex(
      (attempt) => attempt.start <= from && from < attempt.end,
    );
    if (attemptIndex !== -1 && attemptIndex !== currentAttempt) {
      currentAttempt = attemptIndex;
      activityInAttempt = false;
    }
    let top = -1;
    for (const interval of active) top = Math.max(top, interval.rank);
    if (top >= 0) {
      const owners = [...active].filter((interval) => interval.rank === top);
      const share = length / owners.length;
      for (const owner of owners) {
        owner.exclusive += share;
        for (const [category, weight] of Object.entries(owner.weights) as Array<
          [TurnTimingCategory, number]
        >) {
          segments[category] += share * weight;
        }
        if (owner.after) lastAfter = owner.after;
      }
      if (owners.some((owner) => owner.rank !== RANK.dispatch && owner.rank !== RANK.wait)) {
        activityInAttempt = true;
      }
      continue;
    }
    let gap: TurnTimingCategory;
    if (firstStart === null || from < firstStart) gap = "queue";
    else if (from >= lastActivity) gap = lastActivity === -Infinity ? "turn_start" : "turn_end";
    else if (attempts.length > 0 && attemptIndex === -1) gap = "recovery";
    else if (!activityInAttempt) gap = currentAttempt > 0 ? "recovery" : "turn_start";
    else gap = lastAfter === "model" ? "after_model" : "after_tool";
    segments[gap] += length;
  }
  return segments;
}
