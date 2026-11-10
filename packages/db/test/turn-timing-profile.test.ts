import { describe, expect, test } from "bun:test";
import {
  computeTurnTimingProfile,
  TURN_TIMING_CATEGORIES,
  turnTimingToolCategory,
  turnTimingToolFamily,
  type TurnTimingEvent,
  type TurnTimingProfile,
} from "../src/turn-timing-profile";
import { fixtureInput, loadTurnTimingFixture } from "./turn-timing-fixtures";

const T0 = Date.parse("2026-01-05T10:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms);
const ATTEMPT = "00000000-0000-4000-8000-000000000001";

function nonZero(profile: TurnTimingProfile) {
  return Object.fromEntries(Object.entries(profile.segments).filter(([, value]) => value > 0));
}

function expectExactSum(profile: TurnTimingProfile) {
  const sum = TURN_TIMING_CATEGORIES.reduce(
    (total, category) => total + profile.segments[category],
    0,
  );
  expect(sum).toBe(profile.wallMs);
  for (const category of TURN_TIMING_CATEGORIES) {
    expect(Number.isSafeInteger(profile.segments[category])).toBe(true);
    expect(profile.segments[category]).toBeGreaterThanOrEqual(0);
  }
}

let sequence = 0;
function event(
  type: string,
  ms: number,
  payload: Record<string, unknown> = {},
  attemptId: string | null = ATTEMPT,
): TurnTimingEvent {
  return { type, sequence: ++sequence, occurredAt: at(ms), attemptId, payload };
}

function synthetic(events: TurnTimingEvent[], finishedMs: number, startedMs = 100) {
  return computeTurnTimingProfile({
    turn: { createdAt: at(0), startedAt: at(startedMs), finishedAt: at(finishedMs) },
    attempts: [
      { id: ATTEMPT, startedAt: at(startedMs), closedAt: at(finishedMs), outcome: "completed" },
    ],
    events,
  });
}

describe("turn timing profiles from recorded event logs", () => {
  test("a Responses turn with remote MCP tools splits model time by the provider's server timing", async () => {
    const profile = computeTurnTimingProfile(
      fixtureInput(await loadTurnTimingFixture("responses-mcp-tools")),
    );
    expectExactSum(profile);
    expect(profile.wallMs).toBe(908_879);
    expect(nonZero(profile)).toEqual({
      turn_start: 2155,
      dispatch: 2401,
      model_inference: 554_899,
      model_provider_other: 24_773,
      model_network: 15_279,
      model_unsplit: 203_384,
      mcp_tool: 1969,
      sandbox_tool: 62_603,
      own_tool: 39_286,
      after_model: 1916,
      after_tool: 155,
      turn_end: 59,
    });
    expect(profile.provider).toBe("codex-subscription");
    expect(profile.attempts).toBe(1);
    expect(profile.modelRequests).toBe(23);
    expect(profile.toolCalls).toBe(105);

    // Every remote MCP call is its own step with the identity a product needs
    // to join its own logs: call id, tool name, start, end and outcome.
    const mcp = profile.steps.filter((step) => step.category === "mcp_tool");
    expect(mcp).toHaveLength(40);
    for (const step of mcp) {
      expect(step.kind).toBe("tool");
      expect(step.callId).toMatch(/^call_\d+$/);
      expect(step.name).toMatch(/^mcp_\d{24}__[a-z_]+$/);
      expect(step.family).toBe("integration");
      expect(step.outcome).toBe("ok");
      expect(Date.parse(step.end) - Date.parse(step.start)).toBe(step.ms);
    }
    expect(mcp.reduce((total, step) => total + step.exclusiveMs!, 0)).toBeCloseTo(1969, -1);

    // The first request: 14,092 ms, 104 ms dispatch, 11,748 ms engine time,
    // 1,044 ms other provider time and the rest on the wire.
    const first = profile.steps.find((step) => step.kind === "model")!;
    expect(first).toMatchObject({
      ms: 14_092,
      purpose: "main",
      outcome: "completed",
      dispatchMs: 104,
      inferenceMs: 11_748,
      providerOtherMs: 1045,
      networkMs: 1196,
      preDispatchMs: 170,
    });
    // The remote compaction call reports no server timing.
    expect(profile.steps.find((step) => step.purpose === "compaction")).toMatchObject({
      category: "model_unsplit",
      ms: 203_440,
    });
  });

  test("a turn that waited hours for provider capacity across three attempts", async () => {
    const profile = computeTurnTimingProfile(
      fixtureInput(await loadTurnTimingFixture("capacity-wait-recovery")),
    );
    expectExactSum(profile);
    expect(nonZero(profile)).toEqual({
      turn_start: 1243,
      dispatch: 2114,
      model_inference: 112_077,
      model_provider_other: 17_782,
      model_network: 11_042,
      model_stalled: 56,
      sandbox_tool: 10_138,
      own_tool: 1344,
      sandbox_setup: 188,
      capacity_wait: 62_823_906,
      after_model: 3120,
      after_tool: 258,
      recovery: 2774,
      turn_end: 58,
    });
    expect(profile.attempts).toBe(3);
    expect(profile.steps.filter((step) => step.kind === "sandbox")).toHaveLength(2);
    // The quota failure that triggered the failover is a stalled request.
    expect(profile.steps.filter((step) => step.outcome === "failed")).toMatchObject([
      { kind: "model", category: "model_stalled", ms: 56 },
    ]);
  });

  test("a Messages turn without server timing keeps model time unsplit", async () => {
    const profile = computeTurnTimingProfile(
      fixtureInput(await loadTurnTimingFixture("messages-provider-no-server-timing")),
    );
    expectExactSum(profile);
    expect(nonZero(profile)).toEqual({
      turn_start: 1000,
      dispatch: 275,
      model_unsplit: 5472,
      own_tool: 141,
      after_model: 281,
      turn_end: 47,
    });
    // No request id on this path: requests pair by order within the attempt.
    expect(profile.steps.filter((step) => step.kind === "model").map((step) => step.ms)).toEqual([
      2933, 2539,
    ]);
    expect(
      profile.steps.filter((step) => step.kind === "startup").map((step) => step.name),
    ).toEqual(["credential_mint", "tools", "client_publication", "model_preparation"]);
  });

  test("a Messages turn's in-turn compaction is its own category, not the gap after a tool", async () => {
    // The compaction's summary call reports usage with no request audit and
    // no timing; without its own category its 6.7 s was after_tool.
    const profile = computeTurnTimingProfile(
      fixtureInput(await loadTurnTimingFixture("messages-in-turn-compaction")),
    );
    expectExactSum(profile);
    expect(nonZero(profile)).toEqual({
      turn_start: 800,
      dispatch: 424,
      model_unsplit: 8278,
      compaction: 6699,
      sandbox_tool: 1085,
      own_tool: 67,
      after_model: 190,
      after_tool: 85,
      turn_end: 72,
    });
    expect(profile.toolCalls).toBe(4);
    expect(profile.steps.filter((step) => step.kind === "compaction")).toMatchObject([
      { category: "compaction", name: "proactive", outcome: "completed", ms: 6699 },
    ]);
  });
});

describe("turn timing attribution rules", () => {
  test("a turn cancelled while queued is all queue", () => {
    const profile = computeTurnTimingProfile({
      turn: { createdAt: at(0), startedAt: null, finishedAt: at(4_000) },
      attempts: [],
      events: [],
    });
    expect(nonZero(profile)).toEqual({ queue: 4_000 });
    expect(profile.steps).toEqual([]);
  });

  test("parallel tools share their overlap and the model outranks hosted search only by rank", () => {
    const profile = synthetic(
      [
        event("turn.started", 100),
        event("agent.model.request", 200, {
          phase: "started",
          requestId: "r1",
          transportAttempt: 1,
        }),
        // Hosted web search inside the model request.
        event("agent.toolCall.created", 400, { id: "ws_1", name: "web_search_call" }),
        event("agent.toolCall.created", 900, { id: "ws_1", name: "web_search_call" }),
        event("agent.model.request", 1_200, {
          phase: "completed",
          requestId: "r1",
          transportAttempt: 1,
          durationMs: 1_000,
          transport: {
            kind: "websocket",
            timing: { server: { engineWallMs: 600, responsesOtherMs: 100 } },
          },
        }),
        event("agent.toolCall.created", 1_300, {
          id: "c1",
          name: "exec_command",
          toolFamily: "exec_command",
        }),
        event("agent.toolCall.created", 1_300, {
          id: "c2",
          name: "mcp_abc__lookup",
          toolFamily: "custom",
        }),
        event("agent.toolCall.output", 1_700, { id: "c1", output: "done" }),
        event("agent.toolCall.output", 2_300, { id: "c2", output: { isError: true } }),
      ],
      2_500,
    );
    expectExactSum(profile);
    // The model request lost 500 ms to hosted search; the remaining 500 ms
    // keep the request's own split: 60% engine, 10% provider, 30% network.
    expect(nonZero(profile)).toEqual({
      queue: 100,
      turn_start: 100,
      web_search: 500,
      model_inference: 300,
      model_provider_other: 50,
      model_network: 150,
      after_model: 100,
      sandbox_tool: 200,
      mcp_tool: 800,
      turn_end: 200,
    });
    const tools = profile.steps.filter((step) => step.kind === "tool");
    expect(
      tools.map((step) => [step.callId, step.category, step.ms, step.exclusiveMs, step.outcome]),
    ).toEqual([
      ["c1", "sandbox_tool", 400, 200, "ok"],
      ["c2", "mcp_tool", 1_000, 800, "error"],
    ]);
  });

  test("failed and unfinished model requests are stalled; a usage receipt adds dispatch time", () => {
    const profile = synthetic(
      [
        event("agent.model.request", 200, { phase: "started", dispatchId: "1" }),
        event("agent.model.request", 700, { phase: "failed", dispatchId: "1", durationMs: 500 }),
        event("agent.model.request", 1_000, { phase: "started", dispatchId: "1" }),
        event("agent.model.request", 2_000, {
          phase: "completed",
          dispatchId: "1",
          durationMs: 1_000,
        }),
        event("agent.model.usage", 2_010, {
          provider: "p",
          model: "m",
          purpose: "main",
          timing: { preDispatchMs: 200, durationMs: 990 },
        }),
        event("agent.model.request", 2_100, { phase: "started", dispatchId: "1" }),
      ],
      3_000,
    );
    expectExactSum(profile);
    expect(nonZero(profile)).toEqual({
      queue: 100,
      turn_start: 100,
      model_stalled: 500 + 900,
      after_model: 200,
      dispatch: 200,
      model_unsplit: 1_000,
    });
    expect(
      profile.steps.filter((step) => step.kind === "model").map((step) => step.outcome),
    ).toEqual(["failed", "completed", "incomplete"]);
    expect(profile.provider).toBe("p");
  });

  test("a router call is attributed to the tool it invoked", () => {
    const profile = synthetic(
      [
        event("agent.toolCall.created", 200, {
          id: "c1",
          name: "tool_invoke",
          toolFamily: "tool_invoke",
          arguments: '{"name":"mcp_0a1b__create_ticket","arguments":{}}',
        }),
        event("agent.toolCall.output", 1_200, {
          id: "c1",
          output: "Tool execution was not approved.",
        }),
      ],
      1_300,
    );
    expect(profile.steps.find((step) => step.kind === "tool")).toMatchObject({
      name: "mcp_0a1b__create_ticket",
      family: "custom_mcp",
      category: "mcp_tool",
      outcome: "rejected",
    });
    expect(profile.segments.mcp_tool).toBe(1_000);
  });

  test("waiting for an approval is human time, not tool time", () => {
    const profile = synthetic(
      [
        event("agent.toolCall.created", 200, {
          id: "c1",
          name: "opengeni__deploy",
          toolFamily: "deploy",
        }),
        event("session.requiresAction", 300),
        event("user.approvalDecision", 5_300),
        event("agent.toolCall.output", 5_500, { id: "c1", output: "ok" }),
      ],
      5_600,
    );
    expectExactSum(profile);
    expect(profile.segments.human_wait).toBe(5_000);
    expect(profile.segments.own_tool).toBe(300);
  });

  test("a tool still running when the turn ended runs to the end of its attempt", () => {
    const profile = synthetic(
      [
        event("agent.toolCall.created", 200, {
          id: "c1",
          name: "exec_command",
          toolFamily: "exec_command",
        }),
      ],
      1_000,
    );
    expect(profile.steps.find((step) => step.kind === "tool")).toMatchObject({
      outcome: "incomplete",
      ms: 800,
    });
    expect(profile.segments.sandbox_tool).toBe(800);
  });

  test("event times outside the turn are clamped into it", () => {
    const profile = synthetic(
      [
        event("agent.model.request", 500, { phase: "completed", durationMs: 2_000 }),
        event("agent.toolCall.created", 900, {
          id: "c1",
          name: "exec_command",
          toolFamily: "exec_command",
        }),
        event("agent.toolCall.output", 9_000, { id: "c1", output: "ok" }),
      ],
      1_000,
    );
    expectExactSum(profile);
    expect(profile.wallMs).toBe(1_000);
  });

  test("a compaction whose model call has no request audit is compaction, not after_tool", () => {
    // A Messages-style in-turn compaction: its summary call reports usage
    // without a request audit or timing, between a tool result and the next
    // request.
    const profile = synthetic(
      [
        event("agent.model.request", 200, { phase: "completed", durationMs: 100 }),
        event("agent.model.usage", 201, { provider: "p", model: "m", purpose: "main" }),
        event("agent.toolCall.created", 210, {
          id: "c1",
          name: "exec_command",
          toolFamily: "shell",
        }),
        event("agent.toolCall.output", 400, { id: "c1", output: "ok" }),
        event("session.context.compaction.started", 402, { trigger: "proactive" }),
        event("agent.model.usage", 5_300, { provider: "p", model: "m", purpose: "compaction" }),
        event("session.context.compacted", 5_402),
        event("agent.model.request", 5_500, { phase: "completed", durationMs: 90 }),
      ],
      5_600,
    );
    expectExactSum(profile);
    expect(nonZero(profile)).toEqual({
      queue: 100,
      model_unsplit: 100 + 90,
      after_model: 10 + 8,
      sandbox_tool: 190,
      after_tool: 2,
      compaction: 5_000,
      turn_end: 100,
    });
    expect(profile.steps.find((step) => step.kind === "compaction")).toMatchObject({
      category: "compaction",
      name: "proactive",
      outcome: "completed",
      ms: 5_000,
      exclusiveMs: 5_000,
    });
    expect(profile.provider).toBe("p");
  });

  test("a compaction owns its audited model call; a skipped or unfinished one still counts", () => {
    const profile = synthetic(
      [
        event("session.context.compaction.started", 200, { trigger: "auto" }),
        event("agent.model.request", 1_200, { phase: "completed", durationMs: 900 }),
        event("agent.model.usage", 1_201, { provider: "p", purpose: "compaction" }),
        event("session.context.compaction.skipped", 1_300),
        event("agent.model.request", 2_000, { phase: "completed", durationMs: 500 }),
        event("session.context.compaction.started", 2_100, { trigger: "overflow" }),
      ],
      3_000,
    );
    expectExactSum(profile);
    expect(nonZero(profile)).toEqual({
      queue: 100,
      turn_start: 100,
      compaction: 1_100 + 900,
      after_model: 200 + 100,
      model_unsplit: 500,
    });
    expect(
      profile.steps.filter((step) => step.kind === "compaction").map((step) => step.outcome),
    ).toEqual(["skipped", "incomplete"]);
  });

  test("tool families and categories", () => {
    expect(turnTimingToolFamily("integration:example.com", "mcp_1__x")).toBe("integration");
    expect(turnTimingToolFamily("custom", "mcp_1__x")).toBe("custom_mcp");
    expect(turnTimingToolFamily(null, "mcp_1f2e__list")).toBe("custom_mcp");
    expect(turnTimingToolFamily(null, "opengeni__unknown_tool")).toBe("other");
    expect(turnTimingToolCategory("shell", "exec_command")).toBe("sandbox_tool");
    expect(turnTimingToolCategory("web", "web_fetch")).toBe("web_search");
    expect(turnTimingToolCategory("human_input", "opengeni__wait_for_input")).toBe("own_tool");
    expect(turnTimingToolCategory("human_input", "request_human_input")).toBe("human_wait");
  });
});
