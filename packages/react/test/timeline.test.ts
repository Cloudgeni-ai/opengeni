import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { CREDIT_EXHAUSTION_MESSAGE } from "../src/lib/format";
import {
  buildTimeline,
  creditExhaustedFromEvents,
  extractSessionRef,
  groupTimeline,
  sessionStatusFromEvents,
  toolDisplayName,
  type AgentMessageItem,
  type FleetDecisionItem,
  type MemoryItem,
  type SandboxItem,
  type TimelineGroup,
  type TurnEndItem,
  type ToolCallItem,
  type UserMessageItem,
  type WorkerCompletionItem,
  type WorkerItem,
} from "../src/timeline";

describe("toolDisplayName", () => {
  test("strips the MCP server-id prefix and shows only the tool", () => {
    // Catalog-imported MCP server: <opaque slug+hash>__<tool>.
    expect(
      toolDisplayName("mcp-integrations-sh-supabase-com-34ed9dcf1390-0i6tcf8__list_organizations"),
    ).toBe("list organizations");
    expect(toolDisplayName("opengeni__set_session_title")).toBe("set session title");
  });

  test("plain built-in tool names (no __ boundary) are just de-slugged", () => {
    expect(toolDisplayName("session_create")).toBe("session create");
    expect(toolDisplayName("bash")).toBe("bash");
  });

  test("splits on the FIRST __ so a tool name containing __ survives whole", () => {
    expect(toolDisplayName("mcp-supabase-abc123__do__thing")).toBe("do thing");
  });
});

let sequence = 0;

function event(
  type: string,
  payload: unknown,
  options: { turnId?: string | null } = {},
): SessionEvent {
  sequence += 1;
  return {
    id: `evt-${sequence}`,
    workspaceId: "ws-1",
    sessionId: "session-1",
    sequence,
    type,
    payload,
    occurredAt: new Date(1718000000000 + sequence * 1000).toISOString(),
    turnId: options.turnId === undefined ? "turn-1" : options.turnId,
  };
}

function eventAt(
  sequenceNumber: number,
  type: string,
  payload: unknown,
  options: { turnId?: string | null } = {},
): SessionEvent {
  return {
    id: `evt-${sequenceNumber}`,
    workspaceId: "ws-1",
    sessionId: "session-1",
    sequence: sequenceNumber,
    type,
    payload,
    occurredAt: new Date(1718000000000 + sequenceNumber * 1000).toISOString(),
    turnId: options.turnId === undefined ? "turn-1" : options.turnId,
  };
}

function reset(): void {
  sequence = 0;
}

function fleetDecisionPayload(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    mode: "shadow",
    actual: { outcome: "selected", candidateKey: "c00", reason: "active" },
    comparison: "match",
    replay: {
      schemaVersion: 1,
      policyVersion: "adaptive-shadow-v1",
      mode: "shadow",
      input: { candidates: [{ key: "c00" }, { key: "c01" }] },
      truncatedCandidateCount: 0,
      policyFingerprint: "must-not-reach-the-view",
      inputFingerprint: "must-not-reach-the-view",
      decisionFingerprint: "must-not-reach-the-view",
      decision: {
        outcome: "selected",
        selectedCandidateKey: "c00",
        reason: "affinity_best",
        admission: {
          outcome: "admit",
          reason: "pacing_disabled",
          borrowedIdleCapacity: false,
        },
        borrowedOverlayCapacity: false,
        strandedEligibleCount: 0,
        confidence: "unknown",
        scores: [
          {
            candidateKey: "c00",
            eligible: true,
            rejectionReason: null,
            total: -2_400,
            confidence: "unknown",
          },
          {
            candidateKey: "c01",
            eligible: true,
            rejectionReason: null,
            total: 1_600,
            confidence: "unknown",
          },
        ],
      },
    },
    accountEmail: "secret-owner@example.test",
    credentialId: "credential-secret",
  };
}

type ActivityGroup = Extract<TimelineGroup, { kind: "activity" }>;
type TurnGroup = Extract<TimelineGroup, { kind: "turn" }>;

function activityGroups(groups: TimelineGroup[]): ActivityGroup[] {
  const activities: ActivityGroup[] = [];
  for (const group of groups) {
    if (group.kind === "activity") {
      activities.push(group);
    } else if (group.kind === "turn") {
      activities.push(...activityGroups(group.groups));
    }
  }
  return activities;
}

function turnGroups(groups: TimelineGroup[]): TurnGroup[] {
  return groups.filter((group): group is TurnGroup => group.kind === "turn");
}

function flattenActivityIds(group: TurnGroup | undefined): string[] {
  return activityGroups(group?.groups ?? []).flatMap((activity) =>
    activity.items.map((item) => item.id),
  );
}

describe("buildTimeline", () => {
  test("projects a bounded identity-free fleet shadow decision", () => {
    reset();
    const items = buildTimeline([event("codex.fleet.decision", fleetDecisionPayload())]);

    expect(items).toHaveLength(1);
    const decision = items[0] as FleetDecisionItem;
    expect(decision).toMatchObject({
      kind: "fleet-decision",
      turnId: "turn-1",
      policyVersion: "adaptive-shadow-v1",
      actualOutcome: "selected",
      actualCandidateKey: "c00",
      shadowOutcome: "selected",
      shadowCandidateKey: "c00",
      comparison: "match",
      candidateCount: 2,
      truncatedCandidateCount: 0,
      scoreRowsTruncatedCount: 0,
    });
    expect(decision.scores).toEqual([
      {
        candidateKey: "c00",
        eligible: true,
        rejectionReason: null,
        total: -2_400,
        confidence: "unknown",
      },
      {
        candidateKey: "c01",
        eligible: true,
        rejectionReason: null,
        total: 1_600,
        confidence: "unknown",
      },
    ]);
    const projected = JSON.stringify(decision);
    expect(projected).not.toContain("secret-owner@example.test");
    expect(projected).not.toContain("credential-secret");
    expect(projected).not.toContain("Fingerprint");
    expect(projected).not.toContain("must-not-reach-the-view");
  });

  test("accepts manager priority as a paced standard-work admission reason", () => {
    reset();
    const payload = fleetDecisionPayload();
    payload.comparison = "different_outcome";
    const replay = payload.replay as { decision: Record<string, unknown> };
    replay.decision = {
      ...replay.decision,
      outcome: "paced",
      selectedCandidateKey: null,
      reason: "admission_paced",
      admission: {
        outcome: "pace",
        reason: "manager_priority",
        borrowedIdleCapacity: false,
      },
      borrowedOverlayCapacity: false,
      strandedEligibleCount: 0,
      scores: [],
    };

    const [item] = buildTimeline([event("codex.fleet.decision", payload)]);
    expect(item).toMatchObject({
      kind: "fleet-decision",
      shadowOutcome: "paced",
      shadowReason: "admission_paced",
      admissionOutcome: "pace",
      admissionReason: "manager_priority",
    });
  });

  test("caps score rows at 32 without reading an extra secret-shaped row", () => {
    reset();
    const payload = fleetDecisionPayload();
    const replay = payload.replay as Record<string, unknown>;
    const input = replay.input as Record<string, unknown>;
    const decision = replay.decision as Record<string, unknown>;
    input.candidates = Array.from({ length: 32 }, (_, index) => ({
      key: `c${index.toString(36).padStart(2, "0")}`,
    }));
    decision.scores = [
      ...Array.from({ length: 32 }, (_, index) => ({
        candidateKey: `c${index.toString(36).padStart(2, "0")}`,
        eligible: true,
        rejectionReason: null,
        total: index,
        confidence: "unknown",
      })),
      {
        candidateKey: "credential-secret@example.test",
        eligible: true,
        rejectionReason: null,
        total: 33,
        confidence: "unknown",
      },
    ];

    const [item] = buildTimeline([event("codex.fleet.decision", payload)]);
    expect(item?.kind).toBe("fleet-decision");
    if (item?.kind !== "fleet-decision") throw new Error("expected fleet decision");
    expect(item.scores).toHaveLength(32);
    expect(item.scoreRowsTruncatedCount).toBe(1);
    expect(JSON.stringify(item)).not.toContain("credential-secret@example.test");
  });

  test("drops malformed or identity-shaped fleet events instead of rendering payload strings", () => {
    reset();
    const invalidAlias = fleetDecisionPayload();
    (invalidAlias.actual as Record<string, unknown>).candidateKey =
      "credential-secret@example.test";

    const invalidEnum = fleetDecisionPayload();
    (invalidEnum.replay as { decision: Record<string, unknown> }).decision.reason =
      "operator supplied this arbitrary message";

    const invalidNumber = fleetDecisionPayload();
    const invalidScores = (invalidNumber.replay as { decision: { scores: unknown[] } }).decision
      .scores;
    (invalidScores[0] as Record<string, unknown>).total = Number.POSITIVE_INFINITY;

    const inconsistentReason = fleetDecisionPayload();
    (inconsistentReason.actual as Record<string, unknown>).reason = "all_capped";

    expect(buildTimeline([event("codex.fleet.decision", invalidAlias)])).toEqual([]);
    expect(buildTimeline([event("codex.fleet.decision", invalidEnum)])).toEqual([]);
    expect(buildTimeline([event("codex.fleet.decision", invalidNumber)])).toEqual([]);
    expect(buildTimeline([event("codex.fleet.decision", inconsistentReason)])).toEqual([]);
  });

  test("projects childCompletion user messages as worker-completion items", () => {
    reset();
    const items = buildTimeline([
      event("user.message", {
        text: "Worker finished",
        childCompletion: {
          childSessionId: "22222222-3333-4444-9555-666666666672",
          status: "idle",
          goal: {
            status: "completed",
            text: "Ship the patch",
            evidence: "Tests passed",
            pausedReason: "none",
          },
        },
      }),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["worker-completion"]);
    const completion = items[0] as WorkerCompletionItem;
    expect(completion.childSessionId).toBe("22222222-3333-4444-9555-666666666672");
    expect(completion.childStatus).toBe("idle");
    expect(completion.goalStatus).toBe("completed");
    expect(completion.goalText).toBe("Ship the patch");
    expect(completion.evidence).toBe("Tests passed");
    expect(completion.pausedReason).toBe("none");
    expect(completion.text).toBe("Worker finished");
  });

  test("leaves malformed childCompletion payloads as plain user messages", () => {
    reset();
    const items = buildTimeline([
      event("user.message", {
        text: "Still readable",
        childCompletion: { childSessionId: "22222222-3333-4444-9555-666666666672" },
      }),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["user-message"]);
    expect((items[0] as UserMessageItem).text).toBe("Still readable");
  });

  test("leaves invalid childCompletion session ids as plain user messages", () => {
    reset();
    const items = buildTimeline([
      event("user.message", {
        text: "Still readable",
        childCompletion: { childSessionId: "not-a-uuid", status: "idle" },
      }),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["user-message"]);
    expect((items[0] as UserMessageItem).text).toBe("Still readable");
  });

  test("accumulates streaming deltas into one agent message and finalizes on completed", () => {
    reset();
    const items = buildTimeline([
      event("user.message", { text: "Deploy staging" }),
      event("agent.message.delta", { text: "On it — " }),
      event("agent.message.delta", { text: "checking the cluster." }),
      event("agent.message.completed", { text: "On it — checking the cluster." }),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["user-message", "agent-message"]);
    const message = items[1] as AgentMessageItem;
    expect(message.text).toBe("On it — checking the cluster.");
    expect(message.streaming).toBe(false);
  });

  test("keeps accumulated text when completed text does not extend it", () => {
    reset();
    const items = buildTimeline([
      event("agent.message.delta", { text: "Streamed body" }),
      event("agent.message.completed", { text: "different" }),
    ]);
    const message = items[0] as AgentMessageItem;
    expect(message.text).toBe("Streamed body");
    expect(message.streaming).toBe(false);
  });

  test("completed reconciles the same-turn message even after intervening activity", () => {
    reset();
    const items = buildTimeline([
      event("agent.message.delta", { text: "Checking the cluster" }),
      event("agent.toolCall.created", {
        id: "call-1",
        name: "exec",
        arguments: { cmd: "kubectl get pods" },
      }),
      event("agent.toolCall.output", { id: "call-1", output: "ok" }),
      event("agent.message.completed", { text: "Checking the cluster now." }),
    ]);
    const messages = items.filter((item) => item.kind === "agent-message");
    expect(messages).toHaveLength(1);
    expect((messages[0] as AgentMessageItem).text).toBe("Checking the cluster now.");
    expect((messages[0] as AgentMessageItem).streaming).toBe(false);
  });

  test("a steering user message does not complete in-flight tool calls", () => {
    reset();
    const items = buildTimeline([
      event("agent.toolCall.created", { id: "call-1", name: "terraform_apply", arguments: {} }),
      event("user.message", { text: "Hold off on the database changes" }),
    ]);
    expect((items[0] as ToolCallItem).status).toBe("running");
    expect(items[1]?.kind).toBe("user-message");
  });

  test("legacy user messages with no queued turn keep their ledger position", () => {
    reset();
    const items = buildTimeline([
      event(
        "agent.toolCall.created",
        { id: "call-1", name: "exec_command", arguments: { cmd: "make build" } },
        { turnId: "turn-a" },
      ),
      event("user.message", { text: "legacy steering" }, { turnId: null }),
      event(
        "agent.toolCall.created",
        { id: "call-2", name: "exec_command", arguments: { cmd: "make test" } },
        { turnId: "turn-a" },
      ),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["tool-call", "user-message", "tool-call"]);
    expect((items[1] as UserMessageItem).text).toBe("legacy steering");
  });

  test("a genesis user message with queued and started events stays first", () => {
    const items = buildTimeline([
      eventAt(2, "user.message", { text: "First message" }, { turnId: null }),
      eventAt(
        4,
        "turn.queued",
        { turnId: "turn-a", triggerEventId: "evt-2", source: "user" },
        { turnId: "turn-a" },
      ),
      eventAt(6, "turn.started", { triggerEventId: "evt-2" }, { turnId: "turn-a" }),
      eventAt(9, "agent.message.completed", { text: "First answer." }, { turnId: "turn-a" }),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["user-message", "agent-message"]);
    expect((items[0] as UserMessageItem).text).toBe("First message");
  });

  test("a queued user message anchors where its turn starts instead of its ledger sequence", () => {
    const groups = groupTimeline(
      buildTimeline([
        eventAt(2, "user.message", { text: "First message" }, { turnId: null }),
        eventAt(
          4,
          "turn.queued",
          { turnId: "turn-a", triggerEventId: "evt-2", source: "user" },
          { turnId: "turn-a" },
        ),
        eventAt(6, "turn.started", { triggerEventId: "evt-2" }, { turnId: "turn-a" }),
        eventAt(
          9,
          "agent.toolCall.created",
          { id: "call-a-1", name: "exec_command", arguments: { cmd: "first step" } },
          { turnId: "turn-a" },
        ),
        eventAt(16, "user.message", { text: "QUEUED-MSG" }, { turnId: null }),
        eventAt(
          17,
          "turn.queued",
          { turnId: "turn-b", triggerEventId: "evt-16", source: "user" },
          { turnId: "turn-b" },
        ),
        eventAt(
          41,
          "agent.toolCall.created",
          { id: "call-a-2", name: "exec_command", arguments: { cmd: "second step" } },
          { turnId: "turn-a" },
        ),
        eventAt(
          57,
          "agent.message.completed",
          { text: "Turn A final answer." },
          { turnId: "turn-a" },
        ),
        eventAt(58, "turn.completed", {}, { turnId: "turn-a" }),
        eventAt(61, "turn.started", { triggerEventId: "evt-16" }, { turnId: "turn-b" }),
        eventAt(
          62,
          "agent.toolCall.created",
          { id: "call-b-1", name: "exec_command", arguments: { cmd: "queued work" } },
          { turnId: "turn-b" },
        ),
        eventAt(
          80,
          "agent.message.completed",
          { text: "Turn B final answer." },
          { turnId: "turn-b" },
        ),
        eventAt(94, "turn.completed", {}, { turnId: "turn-b" }),
      ]),
    );

    expect(
      groups.map((group) =>
        group.kind === "item" ? `${group.kind}:${group.item.kind}` : group.kind,
      ),
    ).toEqual([
      "item:user-message",
      "turn",
      "item:agent-message",
      "item:user-message",
      "turn",
      "item:agent-message",
    ]);
    const turns = turnGroups(groups);
    expect(turns).toHaveLength(2);
    expect(flattenActivityIds(turns[0])).toEqual(["evt-9", "evt-41"]);
    expect(flattenActivityIds(turns[1])).toEqual(["evt-62"]);
    expect(groups[2]?.kind === "item" ? groups[2].item : null).toMatchObject({
      kind: "agent-message",
      text: "Turn A final answer.",
    });
    expect(groups[3]?.kind === "item" ? groups[3].item : null).toMatchObject({
      kind: "user-message",
      text: "QUEUED-MSG",
    });
  });

  test("a recovered turn keeps its prompt anchored at the first attempt start", () => {
    const items = buildTimeline([
      eventAt(2, "user.message", { text: "Recover this work" }, { turnId: null }),
      eventAt(
        4,
        "turn.queued",
        { turnId: "turn-a", triggerEventId: "evt-2", source: "user" },
        { turnId: "turn-a" },
      ),
      eventAt(5, "turn.started", { triggerEventId: "evt-2" }, { turnId: "turn-a" }),
      eventAt(
        8,
        "agent.message.completed",
        { text: "Durable output from the first attempt." },
        { turnId: "turn-a" },
      ),
      eventAt(10, "turn.recovery.requested", { reason: "worker_shutdown" }, { turnId: "turn-a" }),
      eventAt(12, "turn.started", { triggerEventId: "evt-2" }, { turnId: "turn-a" }),
    ]);

    const promptIndex = items.findIndex(
      (item) => item.kind === "user-message" && item.text === "Recover this work",
    );
    const durableOutputIndex = items.findIndex(
      (item) =>
        item.kind === "agent-message" && item.text === "Durable output from the first attempt.",
    );
    expect(promptIndex).toBeGreaterThanOrEqual(0);
    expect(durableOutputIndex).toBeGreaterThan(promptIndex);
  });

  test("a queued user message stays out of the timeline until the queued turn starts", () => {
    const waitingItems = buildTimeline([
      eventAt(2, "user.message", { text: "First message" }, { turnId: null }),
      eventAt(
        4,
        "turn.queued",
        { turnId: "turn-a", triggerEventId: "evt-2", source: "user" },
        { turnId: "turn-a" },
      ),
      eventAt(6, "turn.started", { triggerEventId: "evt-2" }, { turnId: "turn-a" }),
      eventAt(9, "agent.message.delta", { text: "Still working." }, { turnId: "turn-a" }),
      eventAt(16, "user.message", { text: "Queued follow-up" }, { turnId: null }),
      eventAt(
        17,
        "turn.queued",
        { turnId: "turn-b", triggerEventId: "evt-16", source: "user" },
        { turnId: "turn-b" },
      ),
    ]);
    expect(
      waitingItems.find((item) => item.kind === "user-message" && item.text === "Queued follow-up"),
    ).toBeUndefined();
    expect(waitingItems.at(-1)).toMatchObject({
      kind: "agent-message",
      text: "Still working.",
    });

    const anchoredItems = buildTimeline([
      eventAt(2, "user.message", { text: "First message" }, { turnId: null }),
      eventAt(
        4,
        "turn.queued",
        { turnId: "turn-a", triggerEventId: "evt-2", source: "user" },
        { turnId: "turn-a" },
      ),
      eventAt(6, "turn.started", { triggerEventId: "evt-2" }, { turnId: "turn-a" }),
      eventAt(9, "agent.message.delta", { text: "Still working." }, { turnId: "turn-a" }),
      eventAt(16, "user.message", { text: "Queued follow-up" }, { turnId: null }),
      eventAt(
        17,
        "turn.queued",
        { turnId: "turn-b", triggerEventId: "evt-16", source: "user" },
        { turnId: "turn-b" },
      ),
      eventAt(57, "agent.message.completed", { text: "Turn A done." }, { turnId: "turn-a" }),
      eventAt(58, "turn.completed", {}, { turnId: "turn-a" }),
      eventAt(61, "turn.started", { triggerEventId: "evt-16" }, { turnId: "turn-b" }),
      eventAt(
        62,
        "agent.toolCall.created",
        { id: "call-b-1", name: "exec_command", arguments: { cmd: "follow-up" } },
        { turnId: "turn-b" },
      ),
    ]);
    const followUpIndex = anchoredItems.findIndex(
      (item) => item.kind === "user-message" && item.text === "Queued follow-up",
    );
    const turnBIndex = anchoredItems.findIndex(
      (item) => item.kind === "tool-call" && item.turnId === "turn-b",
    );
    expect(followUpIndex).toBeGreaterThan(-1);
    expect(turnBIndex).toBeGreaterThan(followUpIndex);
  });

  test("a queued user message cancelled before start is omitted without touching a running turn", () => {
    const groups = groupTimeline(
      buildTimeline([
        eventAt(2, "user.message", { text: "First message" }, { turnId: null }),
        eventAt(
          4,
          "turn.queued",
          { turnId: "turn-a", triggerEventId: "evt-2", source: "user" },
          { turnId: "turn-a" },
        ),
        eventAt(6, "turn.started", { triggerEventId: "evt-2" }, { turnId: "turn-a" }),
        eventAt(
          9,
          "agent.toolCall.created",
          { id: "call-a-1", name: "exec_command", arguments: { cmd: "first step" } },
          { turnId: "turn-a" },
        ),
        eventAt(16, "user.message", { text: "Retracted follow-up" }, { turnId: null }),
        eventAt(
          17,
          "turn.queued",
          { turnId: "turn-b", triggerEventId: "evt-16", source: "user" },
          { turnId: "turn-b" },
        ),
        eventAt(
          18,
          "session.queue.changed",
          { operation: "move", targetTurnId: "turn-b", queueVersion: 2 },
          { turnId: "turn-b" },
        ),
        eventAt(
          19,
          "turn.cancelled",
          { turnId: "turn-b", triggerEventId: "evt-16" },
          { turnId: "turn-b" },
        ),
        eventAt(
          41,
          "agent.toolCall.created",
          { id: "call-a-2", name: "exec_command", arguments: { cmd: "second step" } },
          { turnId: "turn-a" },
        ),
        eventAt(
          57,
          "agent.message.completed",
          { text: "Turn A final answer." },
          { turnId: "turn-a" },
        ),
        eventAt(58, "turn.completed", {}, { turnId: "turn-a" }),
      ]),
    );

    expect(JSON.stringify(groups)).not.toContain("Retracted follow-up");
    expect(JSON.stringify(groups)).not.toContain("Interrupted.");
    expect(
      groups.map((group) =>
        group.kind === "item" ? `${group.kind}:${group.item.kind}` : group.kind,
      ),
    ).toEqual(["item:user-message", "turn", "item:agent-message"]);
    const [turn] = turnGroups(groups);
    expect(turn?.outcome).toBe("complete");
    expect(flattenActivityIds(turn)).toEqual(["evt-9", "evt-41"]);
  });

  test("a queued turn without turn.started anchors on the first same-turn activity", () => {
    const items = buildTimeline([
      eventAt(2, "user.message", { text: "First message" }, { turnId: null }),
      eventAt(
        4,
        "turn.queued",
        { turnId: "turn-a", triggerEventId: "evt-2", source: "user" },
        { turnId: "turn-a" },
      ),
      eventAt(6, "turn.started", { triggerEventId: "evt-2" }, { turnId: "turn-a" }),
      eventAt(16, "user.message", { text: "Crash-resumed follow-up" }, { turnId: null }),
      eventAt(
        17,
        "turn.queued",
        { turnId: "turn-b", triggerEventId: "evt-16", source: "user" },
        { turnId: "turn-b" },
      ),
      eventAt(
        61,
        "agent.toolCall.created",
        { id: "call-b-1", name: "exec_command", arguments: { cmd: "follow-up" } },
        { turnId: "turn-b" },
      ),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["user-message", "user-message", "tool-call"]);
    expect(items[1]).toMatchObject({ kind: "user-message", text: "Crash-resumed follow-up" });
  });

  test("user messages carry their attached resources and requested tools", () => {
    reset();
    const items = buildTimeline([
      event("user.message", {
        text: "Review the repo",
        resources: [
          { kind: "repository", uri: "https://github.com/org/repo.git", ref: "main" },
          { kind: "file", fileId: "file-1" },
          { kind: "file" }, // malformed: dropped
          "garbage",
        ],
        tools: [
          { kind: "mcp", id: "opengeni" },
          { kind: "other", id: "x" },
        ],
      }),
    ]);
    expect(items[0]?.kind).toBe("user-message");
    const message = items[0] as UserMessageItem;
    expect(message.resources).toEqual([
      { kind: "repository", uri: "https://github.com/org/repo.git", ref: "main" },
      { kind: "file", fileId: "file-1" },
    ]);
    expect(message.tools).toEqual([{ kind: "mcp", id: "opengeni" }]);
  });

  test("user messages without payload extras get empty resource and tool lists", () => {
    reset();
    const items = buildTimeline([event("user.message", { text: "hi" })]);
    const message = items[0] as UserMessageItem;
    expect(message.resources).toEqual([]);
    expect(message.tools).toEqual([]);
  });

  test("a delta after a tool call starts a new message instead of appending", () => {
    reset();
    const items = buildTimeline([
      event("agent.message.delta", { text: "First." }),
      event("agent.toolCall.created", { id: "call-1", name: "exec", arguments: { cmd: "ls" } }),
      event("agent.toolCall.output", { id: "call-1", output: "ok" }),
      event("agent.message.delta", { text: "Second." }),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["agent-message", "tool-call", "agent-message"]);
    expect((items[0] as AgentMessageItem).streaming).toBe(false);
  });

  test("matches tool outputs to calls by id and marks them complete", () => {
    reset();
    const items = buildTimeline([
      event("agent.toolCall.created", {
        id: "call-1",
        name: "terraform_plan",
        arguments: { dir: "infra" },
      }),
      event("agent.toolCall.created", {
        id: "call-2",
        name: "read_file",
        arguments: { path: "main.tf" },
      }),
      event("agent.toolCall.output", { id: "call-2", output: "resource {}" }),
    ]);
    const first = items[0] as ToolCallItem;
    const second = items[1] as ToolCallItem;
    expect(first.status).toBe("running");
    expect(second.status).toBe("complete");
    expect(second.output).toBe("resource {}");
  });

  test("session_create becomes a worker item with prompt and spawned session id from MCP output", () => {
    reset();
    const worker = {
      id: "0b3ba745-1111-4222-8333-9c76ad9e0000",
      workspaceId: "ws-1",
      status: "queued",
    };
    const items = buildTimeline([
      event("agent.toolCall.created", {
        id: "call-1",
        name: "session_create",
        arguments: JSON.stringify({ initialMessage: "Run the drift check on prod" }),
      }),
      event("agent.toolCall.output", {
        id: "call-1",
        output: { content: [{ type: "text", text: JSON.stringify(worker) }] },
      }),
    ]);
    expect(items).toHaveLength(1);
    const item = items[0] as WorkerItem;
    expect(item.kind).toBe("worker");
    expect(item.action).toBe("spawn");
    expect(item.prompt).toBe("Run the drift check on prod");
    expect(item.status).toBe("complete");
    expect(item.workerSessionId).toBe(worker.id);
  });

  test("a worker spawn whose output carries an error flag settles to failed, not complete", () => {
    reset();
    const items = buildTimeline([
      event("agent.toolCall.created", {
        id: "call-1",
        name: "session_create",
        arguments: JSON.stringify({ initialMessage: "Run the drift check on prod" }),
      }),
      event("agent.toolCall.output", { id: "call-1", output: "spawn rejected", error: true }),
    ]);
    expect((items[0] as WorkerItem).kind).toBe("worker");
    expect((items[0] as WorkerItem).status).toBe("failed");
  });

  test("a worker message whose MCP output isError settles to failed", () => {
    reset();
    const items = buildTimeline([
      event("agent.toolCall.created", {
        id: "call-1",
        name: "session_send_message",
        arguments: JSON.stringify({
          sessionId: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d",
          message: "go",
        }),
      }),
      event("agent.toolCall.output", {
        id: "call-1",
        output: { isError: true, content: [{ type: "text", text: "delivery failed" }] },
      }),
    ]);
    expect((items[0] as WorkerItem).status).toBe("failed");
  });

  test("session_send_message becomes a worker message item targeting the session in the arguments", () => {
    reset();
    const items = buildTimeline([
      event("agent.toolCall.created", {
        id: "call-1",
        name: "session_send_message",
        arguments: { sessionId: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d", message: "Status?" },
      }),
    ]);
    const item = items[0] as WorkerItem;
    expect(item.action).toBe("message");
    expect(item.workerSessionId).toBe("7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d");
    expect(item.prompt).toBe("Status?");
  });

  test("groups sandbox operations by name and appends command output deltas", () => {
    reset();
    const items = buildTimeline([
      event("sandbox.operation.started", { name: "exec", command: "terraform apply" }),
      event("sandbox.command.output.delta", { text: "Applying…\n" }),
      event("sandbox.command.output.delta", { text: "Done." }),
      event("sandbox.operation.completed", { name: "exec" }),
    ]);
    expect(items).toHaveLength(1);
    const sandbox = items[0] as SandboxItem;
    expect(sandbox.command).toBe("terraform apply");
    expect(sandbox.output).toBe("Applying…\nDone.");
    expect(sandbox.status).toBe("complete");
  });

  test("preserves whether sandbox establishment created, restored, or reattached the box", () => {
    reset();
    const items = buildTimeline([
      event("sandbox.operation.started", { name: "sandbox.provision" }),
      event("sandbox.operation.completed", { name: "sandbox.provision", origin: "resumed" }),
    ]);
    expect(items).toHaveLength(1);
    expect((items[0] as SandboxItem).origin).toBe("resumed");
    expect((items[0] as SandboxItem).status).toBe("complete");
  });

  test("keeps every context compaction visible with its before and after size", () => {
    reset();
    const items = buildTimeline([
      event("session.context.compacted", {
        estimatedTokensBefore: 288_000,
        estimatedTokensAfter: 23_091,
      }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "notice",
      tone: "waiting",
      text: "Active conversation history compacted from approximately 288,000 to 23,091 tokens.",
    });
  });

  test("renders standalone compaction as maintenance, not an extra chat turn", () => {
    reset();
    const items = buildTimeline([
      event("session.context.compacted", {
        estimatedTokensBefore: 288_000,
        estimatedTokensAfter: 23_091,
      }),
      event("turn.completed", {
        maintenance: "context_compaction",
        result: "compacted",
      }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "notice" });
    expect(items.some((item) => item.kind === "turn-end")).toBe(false);
  });

  test("shows why an operator compaction request was skipped", () => {
    reset();
    const items = buildTimeline([
      event("session.context.compaction.skipped", { reason: "replacement_not_smaller" }),
      event("turn.completed", {
        maintenance: "context_compaction",
        result: "replacement_not_smaller",
      }),
    ]);
    expect(items).toEqual([
      expect.objectContaining({
        kind: "notice",
        tone: "waiting",
        text: "Context compaction skipped because the generated checkpoint would not reduce the context.",
      }),
    ]);
  });

  test("shows a terminal compaction-summary failure without claiming history changed", () => {
    reset();
    const items = buildTimeline([
      event("session.context.compaction.skipped", { reason: "summarization_failed" }),
    ]);
    expect(items).toEqual([
      expect.objectContaining({
        kind: "notice",
        tone: "failed",
        text: "Context compaction failed without replacing the active conversation history. Request it again to retry.",
      }),
    ]);
  });

  test("hides same-turn recovery control evidence from the user timeline", () => {
    reset();
    const items = buildTimeline([event("turn.recovery.requested", { reason: "worker_shutdown" })]);
    expect(items).toEqual([]);
  });

  test("hides workspace recovery control evidence from the user timeline", () => {
    reset();
    const items = buildTimeline([event("turn.recovery.requested", { reason: "workspace_pause" })]);
    expect(items).toEqual([]);
  });

  test("hides all rejected attempt evidence from the user timeline", () => {
    reset();
    const items = buildTimeline([
      event("turn.event.rejected_late", {
        rejectedType: "agent.toolCall.output",
        rejectedPayload: { id: "call-1", output: "finished too late" },
        reason: "attempt_changed",
      }),
      event("turn.event.rejected_late", {
        rejectedType: "agent.model.usage",
        rejectedPayload: { inputTokens: 10, outputTokens: 5 },
        reason: "session_paused",
      }),
    ]);
    expect(items).toEqual([]);
  });

  test("hides rejected workspace revision bookkeeping from the user timeline", () => {
    reset();
    const items = buildTimeline([
      event("turn.event.rejected_late", {
        rejectedType: "workspace.revision.captured",
        rejectedPayload: { revision: 3 },
        reason: "active_turn_changed",
      }),
      event("turn.event.rejected_late", {
        rejectedType: "workspace.revision.degraded",
        rejectedPayload: { revision: 4 },
        reason: "active_turn_changed",
      }),
    ]);
    expect(items).toEqual([]);
  });

  test("hides rejected late reasoning fragments from the user timeline", () => {
    reset();
    const items = buildTimeline([
      event("turn.event.rejected_late", {
        rejectedType: "agent.reasoning.delta",
        rejectedPayload: { text: "**internal discarded fragment**" },
        reason: "workspace_paused",
      }),
    ]);
    expect(items).toEqual([]);
  });

  test("routine repository-clone operations never render", () => {
    // Per-turn platform plumbing (idempotent clone check + token re-seed) —
    // rendering it every turn reads as the agent redoing work.
    reset();
    const items = buildTimeline([
      event("sandbox.operation.started", { name: "repository-clone" }),
      event("sandbox.operation.completed", { name: "repository-clone" }),
    ]);
    expect(items.filter((item) => item.kind === "sandbox")).toHaveLength(0);
  });

  test("failed repository-clone operations still surface loudly", () => {
    reset();
    const items = buildTimeline([
      event("sandbox.operation.started", { name: "repository-clone" }),
      event("sandbox.operation.failed", {
        name: "repository-clone",
        error: "authentication failed",
      }),
    ]);
    const sandbox = items.find((item): item is SandboxItem => item.kind === "sandbox");
    expect(sandbox?.name).toBe("repository-clone");
    expect(sandbox?.status).toBe("failed");
    expect(sandbox?.output).toContain("authentication failed");
  });

  test("routine file-resource-download operations never render", () => {
    // Per-turn plumbing: an idempotent `if [ ! -f ] then curl` re-materializes
    // an attached file after a box re-warm and emits its operation every turn
    // even when the file is already present — it must not read as re-downloading.
    reset();
    const items = buildTimeline([
      event("sandbox.operation.started", {
        name: "file-resource-download",
        fileId: "f1",
        path: "files/photo.png",
      }),
      event("sandbox.operation.completed", {
        name: "file-resource-download",
        fileId: "f1",
        path: "files/photo.png",
      }),
    ]);
    expect(items.filter((item) => item.kind === "sandbox")).toHaveLength(0);
  });

  test("failed file-resource-download operations still surface loudly", () => {
    reset();
    const items = buildTimeline([
      event("sandbox.operation.started", { name: "file-resource-download", fileId: "f1" }),
      event("sandbox.operation.failed", {
        name: "file-resource-download",
        fileId: "f1",
        error: "signed URL expired",
      }),
    ]);
    const sandbox = items.find((item): item is SandboxItem => item.kind === "sandbox");
    expect(sandbox?.name).toBe("file-resource-download");
    expect(sandbox?.status).toBe("failed");
    expect(sandbox?.output).toContain("signed URL expired");
  });

  test("sandbox durability lifecycle events are ignored by the projection", () => {
    // sandbox.box.* / sandbox.env.drift are observability spine events —
    // tolerant reader: they must never render or disturb the timeline.
    reset();
    const items = buildTimeline([
      event("sandbox.box.created", { hydrated: "archive" }),
      event("sandbox.box.lost", { sandboxId: "sb-x" }),
      event("sandbox.box.terminated", { actor: "reaper", persisted: true }),
      event("sandbox.box.snapshot", { trigger: "turn-end" }),
      event("sandbox.env.drift", { added: ["A"], removed: [], changed: [] }),
    ]);
    expect(items).toHaveLength(0);
  });

  test("named output deltas route to their own operation among concurrent ones", () => {
    reset();
    const items = buildTimeline([
      event("sandbox.operation.started", { name: "build", command: "docker build ." }),
      event("sandbox.operation.started", { name: "test", command: "bun test" }),
      event("sandbox.command.output.delta", { name: "build", text: "Step 1/4\n" }),
      event("sandbox.command.output.delta", { name: "test", text: "3 pass\n" }),
    ]);
    const build = items.find(
      (item): item is SandboxItem => item.kind === "sandbox" && item.name === "build",
    );
    const test_ = items.find(
      (item): item is SandboxItem => item.kind === "sandbox" && item.name === "test",
    );
    expect(build?.output).toBe("Step 1/4\n");
    expect(test_?.output).toBe("3 pass\n");
  });

  test("failed sandbox operations carry the error message", () => {
    reset();
    const items = buildTimeline([
      event("sandbox.operation.started", { name: "exec", command: "kubectl apply" }),
      event("sandbox.operation.failed", { name: "exec", error: "connection refused" }),
    ]);
    const sandbox = items[0] as SandboxItem;
    expect(sandbox.status).toBe("failed");
    expect(sandbox.output).toContain("connection refused");
  });

  test("only attention statuses project dividers; repeats collapse; failure/interrupt notices surface", () => {
    reset();
    const items = buildTimeline([
      // Machinery telemetry — the header pill owns these; no timeline rows.
      event("session.status.changed", { status: "queued" }),
      event("session.status.changed", { status: "running" }),
      event("session.status.changed", { status: "idle" }),
      // Attention statuses earn a divider, collapsed on repeat.
      event("session.status.changed", { status: "requires_action" }),
      event("session.status.changed", { status: "requires_action" }),
      event("turn.started", { triggerEventId: "evt-start" }),
      event("turn.failed", { error: "model provider unavailable" }),
      event("turn.cancelled", {}),
    ]);
    expect(items.map((item) => item.kind)).toEqual([
      "session-status",
      "turn-end",
      "notice",
      "turn-end",
      "notice",
    ]);
    expect(items[0]).toMatchObject({ kind: "session-status", status: "requires_action" });
    expect(items[1]).toMatchObject({
      outcome: "failed",
      failureText: "model provider unavailable",
    });
    expect(items[2]).toMatchObject({ tone: "failed", text: "model provider unavailable" });
    expect(items[3]).toMatchObject({ outcome: "cancelled", failureText: null });
    expect(items[4]).toMatchObject({ tone: "cancelled" });
  });

  test("turn.completed finalizes the turn's streaming and running items", () => {
    reset();
    const items = buildTimeline([
      event("agent.toolCall.created", { id: "call-1", name: "exec", arguments: {} }),
      event("agent.message.delta", { text: "Wrapping up." }),
      event("turn.completed", {}),
    ]);
    expect((items[0] as ToolCallItem).status).toBe("complete");
    expect((items[1] as AgentMessageItem).streaming).toBe(false);
  });

  test("turn lifecycle events emit turn-end items with their outcome metadata", () => {
    reset();
    const items = buildTimeline([
      event("turn.completed", {}, { turnId: "turn-complete" }),
      event("turn.failed", { error: "model provider unavailable" }, { turnId: "turn-failed" }),
      event("turn.started", { triggerEventId: "evt-cancelled" }, { turnId: "turn-cancelled" }),
      event("turn.cancelled", {}, { turnId: "turn-cancelled" }),
    ]);
    const turnEnds = items.filter((item): item is TurnEndItem => item.kind === "turn-end");
    expect(
      turnEnds.map(({ turnId, outcome, failureText }) => ({ turnId, outcome, failureText })),
    ).toEqual([
      { turnId: "turn-complete", outcome: "complete", failureText: null },
      { turnId: "turn-failed", outcome: "failed", failureText: "model provider unavailable" },
      { turnId: "turn-cancelled", outcome: "cancelled", failureText: null },
    ]);
  });

  test("failed turns with activity fold the failure into turn-end instead of emitting a duplicate notice", () => {
    reset();
    const items = buildTimeline([
      event("agent.toolCall.created", {
        id: "call-1",
        name: "exec_command",
        arguments: { cmd: "make build" },
      }),
      event("turn.failed", { error: "model provider unavailable" }),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["tool-call", "turn-end"]);
    expect(items[1]).toMatchObject({
      outcome: "failed",
      failureText: "model provider unavailable",
    });
  });

  test("failed turns without activity keep the failure notice", () => {
    reset();
    const items = buildTimeline([event("turn.failed", { error: "model provider unavailable" })]);
    expect(items.map((item) => item.kind)).toEqual(["turn-end", "notice"]);
    expect(items[1]).toMatchObject({ tone: "failed", text: "model provider unavailable" });
  });

  test("cancelled turns with activity fold interruption into turn-end instead of emitting a duplicate notice", () => {
    reset();
    const items = buildTimeline([
      event("agent.toolCall.created", {
        id: "call-1",
        name: "exec_command",
        arguments: { cmd: "make test" },
      }),
      event("turn.cancelled", {}),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["tool-call", "turn-end"]);
    expect(items[1]).toMatchObject({ outcome: "cancelled", failureText: null });
  });

  test("cancelled turns without activity keep the interruption notice", () => {
    reset();
    const items = buildTimeline([
      event("turn.started", { triggerEventId: "evt-start" }),
      event("turn.cancelled", {}),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["turn-end", "notice"]);
    expect(items[1]).toMatchObject({ tone: "cancelled", text: "Interrupted." });
  });

  test("null-turn failures use activity since the last turn boundary for notice suppression", () => {
    reset();
    const withActivity = buildTimeline([
      event(
        "agent.toolCall.created",
        { id: "call-1", name: "exec_command", arguments: { cmd: "make build" } },
        { turnId: null },
      ),
      event("turn.failed", { error: "boom" }, { turnId: null }),
    ]);
    expect(withActivity.map((item) => item.kind)).toEqual(["tool-call", "turn-end"]);

    reset();
    const afterUserBoundary = buildTimeline([
      event(
        "agent.toolCall.created",
        { id: "call-1", name: "exec_command", arguments: { cmd: "make build" } },
        { turnId: null },
      ),
      event("user.message", { text: "new turn" }),
      event("turn.failed", { error: "boom" }, { turnId: null }),
    ]);
    expect(afterUserBoundary.map((item) => item.kind)).toEqual([
      "tool-call",
      "user-message",
      "turn-end",
      "notice",
    ]);
  });

  // Chip doctrine: the TURN failed — items caught mid-flight did not. Red is
  // spent once (the turn-level outcome); interrupted items read as calm
  // "cancelled"/interrupted, never as their own failure.
  test("turn.failed marks in-flight tool calls as interrupted (not failed, not complete)", () => {
    reset();
    const items = buildTimeline([
      event("agent.toolCall.created", {
        id: "call-1",
        name: "exec_command",
        arguments: { cmd: "make build" },
      }),
      event("turn.failed", { error: "model provider unavailable" }),
    ]);
    expect((items[0] as ToolCallItem).status).toBe("cancelled");
  });

  test("turn.cancelled marks in-flight tool calls as cancelled (not failed, not complete)", () => {
    reset();
    const items = buildTimeline([
      event("agent.toolCall.created", {
        id: "call-1",
        name: "exec_command",
        arguments: { cmd: "make test" },
      }),
      event("turn.cancelled", {}),
    ]);
    expect((items[0] as ToolCallItem).status).toBe("cancelled");
  });

  test("turn.failed marks in-flight sandbox operations as interrupted", () => {
    reset();
    const items = buildTimeline([
      event("sandbox.operation.started", { name: "exec", command: "terraform apply" }),
      event("turn.failed", { error: "storage error" }),
    ]);
    expect((items[0] as SandboxItem).status).toBe("cancelled");
  });

  test("turn.cancelled marks in-flight sandbox operations as cancelled (not failed)", () => {
    reset();
    const items = buildTimeline([
      event("sandbox.operation.started", { name: "exec", command: "kubectl logs -f" }),
      event("turn.cancelled", {}),
    ]);
    expect((items[0] as SandboxItem).status).toBe("cancelled");
  });

  test("turn.cancelled marks in-flight worker items as cancelled (not failed)", () => {
    reset();
    const items = buildTimeline([
      event("agent.toolCall.created", {
        id: "call-1",
        name: "session_create",
        arguments: JSON.stringify({ initialMessage: "go" }),
      }),
      event("turn.cancelled", {}),
    ]);
    expect((items[0] as WorkerItem).status).toBe("cancelled");
  });

  test("goal events become goal markers with text", () => {
    reset();
    const items = buildTimeline([event("goal.set", { goal: { text: "Keep staging green" } })]);
    expect(items[0]).toMatchObject({ kind: "goal", action: "set", text: "Keep staging green" });
  });

  test("goal.cleared is tolerated as a goal landmark", () => {
    reset();
    const items = buildTimeline([event("goal.cleared", { goalId: "goal-1" })]);
    expect(items[0]).toMatchObject({ kind: "goal", action: "cleared", text: null });
  });

  test("session.requiresAction becomes a waiting notice", () => {
    reset();
    const items = buildTimeline([event("session.requiresAction", { approvals: [] })]);
    expect(items[0]).toMatchObject({ kind: "notice", tone: "waiting" });
  });

  test("tool.auth_needed becomes a structured auth-needed item carrying the full payload", () => {
    reset();
    const items = buildTimeline([
      event(
        "tool.auth_needed",
        {
          serverId: "mcp-linear",
          toolName: "create_issue",
          providerDomain: "linear.app",
          connectionId: "conn-1",
          reason: "refresh_failed",
          scopes: ["issues:write"],
          resource: "https://mcp.linear.app/sse",
          authorizationUrl: "https://linear.app/oauth/authorize",
        },
        { turnId: "turn-1" },
      ),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "auth-needed",
      turnId: "turn-1",
      providerDomain: "linear.app",
      connectionId: "conn-1",
      reason: "refresh_failed",
      scopes: ["issues:write"],
      resource: "https://mcp.linear.app/sse",
      toolName: "create_issue",
      authorizationUrl: "https://linear.app/oauth/authorize",
    });
  });

  test("tool.auth_needed tolerates a sparse payload and drops an unknown reason", () => {
    reset();
    const items = buildTimeline([
      event("tool.auth_needed", { providerDomain: "supabase.com", reason: "who_knows" }),
    ]);
    expect(items[0]).toMatchObject({
      kind: "auth-needed",
      providerDomain: "supabase.com",
      connectionId: null,
      reason: null,
      scopes: [],
      resource: null,
      toolName: null,
      authorizationUrl: null,
    });
  });

  test("unknown event types are ignored, keeping the projection forward-compatible", () => {
    reset();
    const items = buildTimeline([
      event("user.message", { text: "hi" }),
      event("billing.snapshot.created", { amount: 1 }),
    ]);
    expect(items).toHaveLength(1);
  });

  test("is order-insensitive on input (sorts by sequence)", () => {
    reset();
    const ordered = [
      event("user.message", { text: "hi" }),
      event("agent.message.delta", { text: "a" }),
      event("agent.message.delta", { text: "b" }),
    ];
    const shuffled = [ordered[2]!, ordered[0]!, ordered[1]!];
    const items = buildTimeline(shuffled);
    expect((items[1] as AgentMessageItem).text).toBe("ab");
  });
});

describe("groupTimeline", () => {
  test("clusters consecutive activity between messages", () => {
    reset();
    const items = buildTimeline([
      event("user.message", { text: "go" }),
      event("agent.reasoning.delta", { text: "thinking" }),
      event("agent.toolCall.created", { id: "c1", name: "exec", arguments: {} }),
      event("agent.toolCall.output", { id: "c1", output: "done" }),
      event("agent.message.delta", { text: "All done." }),
    ]);
    const groups = groupTimeline(items);
    expect(groups.map((group) => group.kind)).toEqual(["item", "activity", "item"]);
    const activity = groups[1];
    if (activity?.kind !== "activity") {
      throw new Error("expected activity group");
    }
    expect(activity.items.map((item) => item.kind)).toEqual(["reasoning", "tool-call"]);
  });

  test("settled activity groups carry outcome and failure text", () => {
    reset();
    const groups = groupTimeline(
      buildTimeline([
        event("agent.toolCall.created", {
          id: "call-1",
          name: "exec_command",
          arguments: { cmd: "make build" },
        }),
        event("turn.failed", { error: "model provider unavailable" }),
      ]),
    );
    const [activity] = activityGroups(groups);
    // The in-flight call was interrupted BY the failure — the cluster reads
    // calm interrupted; the turn-level fold carries the red + failure text.
    expect(activity?.outcome).toBe("cancelled");
    expect(activity?.failureText).toBeUndefined();
  });

  test("a settled turn folds the full span and leaves the final agent message after it", () => {
    reset();
    const groups = groupTimeline(
      buildTimeline([
        event("user.message", { text: "ship it" }, { turnId: null }),
        event("agent.reasoning.delta", { text: "checking" }, { turnId: "turn-fold" }),
        event(
          "agent.message.completed",
          { text: "The tests need one patch first." },
          { turnId: "turn-fold" },
        ),
        event(
          "agent.toolCall.created",
          { id: "call-1", name: "exec_command", arguments: { cmd: "bun test" } },
          { turnId: "turn-fold" },
        ),
        event("agent.toolCall.output", { id: "call-1", output: "ok" }, { turnId: "turn-fold" }),
        event(
          "agent.message.completed",
          { text: "Final answer: tests are green." },
          { turnId: "turn-fold" },
        ),
        event("turn.completed", {}, { turnId: "turn-fold" }),
      ]),
    );
    expect(groups.map((group) => group.kind)).toEqual(["item", "turn", "item"]);
    const [turn] = turnGroups(groups);
    expect(turn?.id).toBe("turn-turn-fold");
    expect(turn?.outcome).toBe("complete");
    expect(turn?.groups.map((group) => group.kind)).toEqual(["activity", "item", "activity"]);
    const final = groups[2];
    expect(final?.kind).toBe("item");
    expect(final?.kind === "item" ? final.item : null).toMatchObject({
      kind: "agent-message",
      text: "Final answer: tests are green.",
    });
  });

  test("a turn that ends on activity folds everything and extracts nothing", () => {
    reset();
    const groups = groupTimeline(
      buildTimeline([
        event("user.message", { text: "run it" }, { turnId: null }),
        event(
          "agent.message.completed",
          { text: "Starting with the build." },
          { turnId: "turn-activity-end" },
        ),
        event(
          "agent.toolCall.created",
          { id: "call-1", name: "exec_command", arguments: { cmd: "make build" } },
          { turnId: "turn-activity-end" },
        ),
        event(
          "agent.toolCall.output",
          { id: "call-1", output: "ok" },
          { turnId: "turn-activity-end" },
        ),
        event("turn.completed", {}, { turnId: "turn-activity-end" }),
      ]),
    );
    expect(groups.map((group) => group.kind)).toEqual(["item", "turn"]);
    const [turn] = turnGroups(groups);
    expect(turn?.groups.map((group) => group.kind)).toEqual(["item", "activity"]);
  });

  test("a steering user message bounds the turn walk-back", () => {
    reset();
    const groups = groupTimeline(
      buildTimeline([
        event("user.message", { text: "first request" }, { turnId: null }),
        event(
          "agent.toolCall.created",
          { id: "call-1", name: "exec_command", arguments: { cmd: "setup" } },
          { turnId: "turn-steer" },
        ),
        event("user.message", { text: "actually run tests only" }, { turnId: null }),
        event(
          "agent.toolCall.created",
          { id: "call-2", name: "exec_command", arguments: { cmd: "bun test" } },
          { turnId: "turn-steer" },
        ),
        event(
          "agent.message.completed",
          { text: "Final answer after steering." },
          { turnId: "turn-steer" },
        ),
        event("turn.completed", {}, { turnId: "turn-steer" }),
      ]),
    );
    expect(groups.map((group) => group.kind)).toEqual(["item", "activity", "item", "turn", "item"]);
    const [turn] = turnGroups(groups);
    expect(turn?.groups.map((group) => group.kind)).toEqual(["activity"]);
    expect(activityGroups(turn?.groups ?? [])[0]?.items[0]?.id).toBe("evt-4");
  });

  test("sequential turns fold independently and leave between-turn dividers top-level", () => {
    reset();
    const groups = groupTimeline(
      buildTimeline([
        event("user.message", { text: "setup" }, { turnId: null }),
        event(
          "agent.toolCall.created",
          { id: "call-1", name: "exec_command", arguments: { cmd: "setup" } },
          { turnId: "turn-1" },
        ),
        event("agent.message.completed", { text: "Setup complete." }, { turnId: "turn-1" }),
        event("turn.completed", {}, { turnId: "turn-1" }),
        event("session.status.changed", { status: "idle" }, { turnId: null }),
        event("user.message", { text: "deploy" }, { turnId: null }),
        event("session.status.changed", { status: "running" }, { turnId: null }),
        event(
          "agent.toolCall.created",
          { id: "call-2", name: "exec_command", arguments: { cmd: "deploy" } },
          { turnId: "turn-2" },
        ),
        event("agent.message.completed", { text: "Deploy failed." }, { turnId: "turn-2" }),
        event("turn.failed", { error: "deploy failed" }, { turnId: "turn-2" }),
      ]),
    );
    // The idle/running ticks between and inside turns project no rows at all —
    // the shape is purely user → turn → answer, twice.
    expect(groups.map((group) => group.kind)).toEqual([
      "item",
      "turn",
      "item",
      "item",
      "turn",
      "item",
    ]);
    const turns = turnGroups(groups);
    expect(turns.map((turn) => turn.id)).toEqual(["turn-turn-1", "turn-turn-2"]);
    expect(turns[0]?.groups.map((group) => group.kind)).toEqual(["activity"]);
    expect(turns[1]?.groups.map((group) => group.kind)).toEqual(["activity"]);
  });

  test("sequential turns without a user boundary do not absorb the previous final message", () => {
    reset();
    const groups = groupTimeline(
      buildTimeline([
        event(
          "agent.toolCall.created",
          { id: "call-1", name: "exec_command", arguments: { cmd: "setup" } },
          { turnId: "turn-1" },
        ),
        event("agent.message.completed", { text: "Setup complete." }, { turnId: "turn-1" }),
        event("turn.completed", {}, { turnId: "turn-1" }),
        event("session.status.changed", { status: "idle" }, { turnId: null }),
        event(
          "agent.toolCall.created",
          { id: "call-2", name: "exec_command", arguments: { cmd: "deploy" } },
          { turnId: "turn-2" },
        ),
        event("agent.message.completed", { text: "Deploy complete." }, { turnId: "turn-2" }),
        event("turn.completed", {}, { turnId: "turn-2" }),
      ]),
    );
    // No divider row separates the turns anymore; the foreign-turn guard alone
    // keeps turn-2's walk-back from absorbing turn-1's final message.
    expect(
      groups.map((group) =>
        group.kind === "item" ? `${group.kind}:${group.item.kind}` : group.kind,
      ),
    ).toEqual(["turn", "item:agent-message", "turn", "item:agent-message"]);
    const turns = turnGroups(groups);
    expect(turns.map((turn) => turn.groups.map((group) => group.kind))).toEqual([
      ["activity"],
      ["activity"],
    ]);
  });

  test("activity-less turns create no turn group and keep their notice", () => {
    reset();
    const groups = groupTimeline(
      buildTimeline([event("turn.failed", { error: "model provider unavailable" })]),
    );
    expect(groups.map((group) => group.kind)).toEqual(["item"]);
    expect(groups[0]?.kind === "item" ? groups[0].item : null).toMatchObject({
      kind: "notice",
      tone: "failed",
    });
  });

  test("machinery status ticks vanish; attention statuses inside a settled turn fold into the body", () => {
    reset();
    const groups = groupTimeline(
      buildTimeline([
        event("user.message", { text: "run checks" }, { turnId: null }),
        event("session.status.changed", { status: "running" }, { turnId: null }),
        event("session.status.changed", { status: "requires_action" }, { turnId: null }),
        event(
          "agent.toolCall.created",
          { id: "call-1", name: "exec_command", arguments: { cmd: "bun test" } },
          { turnId: "turn-status" },
        ),
        event("agent.message.completed", { text: "Checks passed." }, { turnId: "turn-status" }),
        event("turn.completed", {}, { turnId: "turn-status" }),
      ]),
    );
    expect(groups.map((group) => group.kind)).toEqual(["item", "turn", "item"]);
    const [turn] = turnGroups(groups);
    // The running tick projected nothing; the requires_action divider folds.
    expect(
      turn?.groups.map((group) => (group.kind === "item" ? group.item.kind : group.kind)),
    ).toEqual(["session-status", "activity"]);
    const folded = turn?.groups[0];
    expect(folded?.kind === "item" ? folded.item : null).toMatchObject({
      kind: "session-status",
      status: "requires_action",
    });
  });

  test("live activity groups have no turn outcome", () => {
    reset();
    const groups = groupTimeline(
      buildTimeline([
        event("agent.toolCall.created", {
          id: "call-1",
          name: "exec_command",
          arguments: { cmd: "make build" },
        }),
      ]),
    );
    const [activity] = activityGroups(groups);
    expect(activity?.outcome).toBeUndefined();
    expect(activity?.failureText).toBeUndefined();
  });

  test("a turn split by an interleaved agent message stamps both activity clusters", () => {
    reset();
    const groups = groupTimeline(
      buildTimeline([
        event("agent.reasoning.delta", { text: "thinking" }, { turnId: "turn-split" }),
        event(
          "agent.message.completed",
          { text: "Checking this first." },
          { turnId: "turn-split" },
        ),
        event(
          "agent.toolCall.created",
          { id: "call-1", name: "exec_command", arguments: { cmd: "make build" } },
          { turnId: "turn-split" },
        ),
        event("turn.failed", { error: "compiler exploded" }, { turnId: "turn-split" }),
      ]),
    );
    const activities = activityGroups(groups);
    expect(groups.map((group) => group.kind)).toEqual(["turn"]);
    const [turn] = turnGroups(groups);
    expect(turn?.groups.map((group) => group.kind)).toEqual(["activity", "item", "activity"]);
    expect(activities).toHaveLength(2);
    // Cluster outcomes are their own: the first (reasoning, settled) reads
    // complete; the second held the interrupted in-flight call.
    expect(activities.map((group) => group.outcome)).toEqual(["complete", "cancelled"]);
    expect(activities.map((group) => group.failureText)).toEqual([undefined, undefined]);
  });

  test("sequential settled turns stamp only their own activity groups", () => {
    reset();
    const groups = groupTimeline(
      buildTimeline([
        event(
          "agent.toolCall.created",
          { id: "call-1", name: "exec_command", arguments: { cmd: "setup" } },
          { turnId: "turn-1" },
        ),
        event("turn.completed", {}, { turnId: "turn-1" }),
        event(
          "agent.toolCall.created",
          { id: "call-2", name: "exec_command", arguments: { cmd: "deploy" } },
          { turnId: "turn-2" },
        ),
        event("turn.failed", { error: "deploy failed" }, { turnId: "turn-2" }),
      ]),
    );
    const activities = activityGroups(groups);
    expect(groups.map((group) => group.kind)).toEqual(["turn", "turn"]);
    expect(activities).toHaveLength(2);
    expect(activities.map((group) => group.outcome)).toEqual(["complete", "cancelled"]);
    expect(activities.map((group) => group.items.map((item) => item.turnId))).toEqual([
      ["turn-1"],
      ["turn-2"],
    ]);
    expect(activities[0]?.failureText).toBeUndefined();
    expect(activities[1]?.failureText).toBeUndefined();
  });

  test("a null-turn failure stamps the trailing activity group", () => {
    reset();
    const groups = groupTimeline(
      buildTimeline([
        event(
          "agent.toolCall.created",
          { id: "call-1", name: "exec_command", arguments: { cmd: "tail logs" } },
          { turnId: null },
        ),
        event("turn.failed", { error: "tail failed" }, { turnId: null }),
      ]),
    );
    const [activity] = activityGroups(groups);
    expect(activity?.outcome).toBe("cancelled");
  });

  test("a null-turn cancellation keeps the legacy finalize path (not a queued retraction)", () => {
    reset();
    const groups = groupTimeline(
      buildTimeline([
        event(
          "agent.toolCall.created",
          { id: "call-1", name: "exec_command", arguments: { cmd: "tail logs" } },
          { turnId: null },
        ),
        event("turn.cancelled", {}, { turnId: null }),
      ]),
    );
    const [activity] = activityGroups(groups);
    // Null turnId proves nothing about queued-turn retraction; the trailing
    // group still settles as cancelled exactly as before.
    expect(activity?.outcome).toBe("cancelled");
    expect(activity?.items[0]).toMatchObject({ status: "cancelled" });
  });
});

describe("sessionStatusFromEvents", () => {
  test("returns the latest status and null when absent", () => {
    reset();
    const events = [
      event("session.status.changed", { status: "running" }),
      event("session.status.changed", { status: "idle" }),
    ];
    expect(sessionStatusFromEvents(events)).toBe("idle");
    expect(sessionStatusFromEvents([event("user.message", { text: "x" })])).toBeNull();
  });
});

describe("extractSessionRef", () => {
  const id = "3f6e1a2b-4c5d-4e6f-8a9b-0c1d2e3f4a5b";

  test("finds ids in raw objects, json strings, and MCP content wrappers", () => {
    expect(extractSessionRef({ sessionId: id })).toBe(id);
    expect(extractSessionRef({ id, status: "queued" })).toBe(id);
    expect(extractSessionRef(JSON.stringify({ session: { id, workspaceId: "ws" } }))).toBe(id);
    expect(
      extractSessionRef({
        content: [{ type: "text", text: JSON.stringify({ id, status: "queued" }) }],
      }),
    ).toBe(id);
    expect(extractSessionRef({ structuredContent: { sessionId: id } })).toBe(id);
  });

  test("rejects non-uuid ids and unrelated payloads", () => {
    expect(extractSessionRef({ id: "not-a-uuid", status: "queued" })).toBeNull();
    expect(extractSessionRef("plain text output")).toBeNull();
    expect(extractSessionRef(null)).toBeNull();
  });
});

describe("cluster outcomes inside a failed turn", () => {
  // The user-reported case: a turn fails at its LAST step; the earlier
  // sub-clusters all completed. Only the turn-level fold may show failed —
  // completed clusters stay calm.
  test("completed sub-clusters keep outcome complete when the turn fails later", () => {
    reset();
    const items = buildTimeline([
      event("agent.toolCall.created", { id: "c1", name: "exec_command", arguments: { cmd: "ls" } }),
      event("agent.toolCall.output", { id: "c1", output: "ok" }),
      event("agent.message.completed", { text: "Narration between clusters." }),
      event("agent.toolCall.created", {
        id: "c2",
        name: "exec_command",
        arguments: { cmd: "pwd" },
      }),
      event("agent.toolCall.output", { id: "c2", output: "/workspace" }),
      event("turn.failed", { error: "context overflow" }),
    ]);
    const groups = groupTimeline(items);
    const turnGroup = groups.find((group) => group.kind === "turn");
    expect(turnGroup?.outcome).toBe("failed");
    const activity = collectActivityGroups(groups);
    expect(activity.length).toBeGreaterThan(0);
    for (const cluster of activity) {
      expect(cluster.outcome).toBe("complete");
    }
  });

  test("only the cluster containing a genuinely failed item shows failed", () => {
    reset();
    const items = buildTimeline([
      event("agent.toolCall.created", { id: "c1", name: "exec_command", arguments: { cmd: "ls" } }),
      event("agent.toolCall.output", { id: "c1", output: "ok" }),
      event("agent.message.completed", { text: "Narration." }),
      event("agent.toolCall.created", {
        id: "c2",
        name: "exec_command",
        arguments: { cmd: "boom" },
      }),
      event("agent.toolCall.output", { id: "c2", output: "exit 1", error: true }),
      event("turn.failed", { error: "tool failed" }),
    ]);
    const groups = groupTimeline(items);
    const activity = collectActivityGroups(groups);
    const outcomes = activity.map((cluster) => cluster.outcome);
    expect(outcomes).toContain("failed");
    expect(outcomes.filter((outcome) => outcome === "failed").length).toBe(1);
  });
});

describe("credit exhaustion", () => {
  // Case (b), the worst one: the engine ends a budget-exhausted turn as a
  // NOMINALLY completed turn. It must project as a failure, never as a clean
  // "complete" chip on an otherwise healthy-looking idle session.
  test("turn.completed with budget_exhausted projects as a failed turn-end plus a failed notice", () => {
    reset();
    const items = buildTimeline([
      event("user.message", { text: "keep going" }),
      event("agent.message.delta", { text: "Working…" }),
      event("turn.completed", {
        detail: "insufficient OpenGeni credits",
        segmentLimit: "budget_exhausted",
      }),
    ]);
    expect(items.map((item) => item.kind)).toEqual([
      "user-message",
      "agent-message",
      "turn-end",
      "notice",
    ]);
    expect(items[2]).toMatchObject({
      kind: "turn-end",
      outcome: "failed",
      failureText: CREDIT_EXHAUSTION_MESSAGE,
    });
    expect(items[3]).toMatchObject({
      kind: "notice",
      tone: "failed",
      text: CREDIT_EXHAUSTION_MESSAGE,
    });
  });

  test("turn.completed with only the detail text (no segmentLimit) still projects as failed", () => {
    reset();
    const items = buildTimeline([
      event("turn.completed", { detail: "insufficient OpenGeni credits" }),
    ]);
    expect(items[0]).toMatchObject({
      kind: "turn-end",
      outcome: "failed",
      failureText: CREDIT_EXHAUSTION_MESSAGE,
    });
    expect(items[1]).toMatchObject({ kind: "notice", tone: "failed" });
  });

  test("ordinary turn.completed is untouched — complete turn-end, no notice", () => {
    reset();
    const items = buildTimeline([
      event("turn.completed", { detail: "all good", segmentLimit: "max_turns" }),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["turn-end"]);
    expect(items[0]).toMatchObject({ outcome: "complete", failureText: null });
  });

  // Case (a): turn.failed carrying the raw engine error (bare or wrapped in
  // "Activity task failed") maps to the same canonical sentence.
  test("turn.failed with the credit error renders the canonical message", () => {
    reset();
    const items = buildTimeline([
      event("turn.failed", { error: "Activity task failed: insufficient OpenGeni credits" }),
    ]);
    expect(items[0]).toMatchObject({
      kind: "turn-end",
      outcome: "failed",
      failureText: CREDIT_EXHAUSTION_MESSAGE,
    });
    expect(items[1]).toMatchObject({
      kind: "notice",
      tone: "failed",
      text: CREDIT_EXHAUSTION_MESSAGE,
    });
  });

  test("groupTimeline folds a credit-exhausted turn as failed", () => {
    reset();
    const groups = groupTimeline(
      buildTimeline([
        event("agent.toolCall.created", {
          id: "c1",
          name: "exec_command",
          arguments: { cmd: "ls" },
        }),
        event("agent.toolCall.output", { id: "c1", output: "ok" }),
        event("turn.completed", {
          detail: "insufficient OpenGeni credits",
          segmentLimit: "budget_exhausted",
        }),
      ]),
    );
    const turnGroup = groups.find((group) => group.kind === "turn");
    expect(turnGroup?.outcome).toBe("failed");
    expect(turnGroup?.failureText).toBe(CREDIT_EXHAUSTION_MESSAGE);
  });
});

describe("creditExhaustedFromEvents", () => {
  test("true when the LAST turn-end is credit exhaustion (either payload shape)", () => {
    reset();
    expect(
      creditExhaustedFromEvents([
        event("turn.completed", {}, { turnId: "turn-1" }),
        event(
          "turn.completed",
          { detail: "insufficient OpenGeni credits", segmentLimit: "budget_exhausted" },
          { turnId: "turn-2" },
        ),
      ]),
    ).toBe(true);
    reset();
    expect(
      creditExhaustedFromEvents([
        event("turn.failed", { error: "Activity task failed: insufficient OpenGeni credits" }),
      ]),
    ).toBe(true);
  });

  test("false when a later turn settles any other way, or with no turn ends", () => {
    reset();
    expect(
      creditExhaustedFromEvents([
        event(
          "turn.completed",
          { detail: "insufficient OpenGeni credits", segmentLimit: "budget_exhausted" },
          { turnId: "turn-1" },
        ),
        event("turn.completed", {}, { turnId: "turn-2" }),
      ]),
    ).toBe(false);
    reset();
    expect(
      creditExhaustedFromEvents([
        event("user.message", { text: "hello" }),
        event("agent.message.delta", { text: "hi" }),
      ]),
    ).toBe(false);
    expect(creditExhaustedFromEvents([])).toBe(false);
  });

  test("orders by sequence, not array order", () => {
    reset();
    expect(
      creditExhaustedFromEvents([
        eventAt(20, "turn.completed", { segmentLimit: "budget_exhausted" }, { turnId: "turn-2" }),
        eventAt(10, "turn.completed", {}, { turnId: "turn-1" }),
      ]),
    ).toBe(true);
  });
});

function collectActivityGroups(groups: ReturnType<typeof groupTimeline>) {
  const out: Array<Extract<ReturnType<typeof groupTimeline>[number], { kind: "activity" }>> = [];
  for (const group of groups) {
    if (group.kind === "activity") out.push(group);
    if (group.kind === "turn") {
      for (const inner of group.groups) {
        if (inner.kind === "activity") out.push(inner);
      }
    }
  }
  return out;
}

describe("buildTimeline — memory writes", () => {
  test("projects memory.saved into a neutral MemoryItem carrying id, kind, preview", () => {
    reset();
    const items = buildTimeline([
      event("memory.saved", {
        memoryId: "mem-1",
        kind: "preference",
        preview: "Prefers concise prose over bullet lists.",
        deduped: false,
      }),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["memory"]);
    const memory = items[0] as MemoryItem;
    expect(memory.variant).toBe("saved");
    expect(memory.memoryKind).toBe("preference");
    expect(memory.preview).toBe("Prefers concise prose over bullet lists.");
    expect(memory.memoryId).toBe("mem-1");
    expect(memory.deduped).toBeUndefined();
    expect(memory.replacementPreview).toBeUndefined();
  });

  test("carries a deduped flag through only when the save collapsed into an existing memory", () => {
    reset();
    const items = buildTimeline([
      event("memory.saved", {
        memoryId: "mem-2",
        kind: "semantic",
        preview: "Ships on Fridays.",
        deduped: true,
      }),
    ]);
    expect((items[0] as MemoryItem).deduped).toBe(true);
  });

  test("projects memory.corrected supersede into a MemoryItem with old preview, new replacement, and both ids", () => {
    reset();
    const items = buildTimeline([
      event("memory.corrected", {
        memoryId: "mem-old",
        kind: "decision",
        preview: "Deploy from the release branch.",
        action: "superseded",
        replacementMemoryId: "mem-new",
        replacementPreview: "Deploy from main after a green staging run.",
      }),
    ]);
    const memory = items[0] as MemoryItem;
    expect(memory.kind).toBe("memory");
    expect(memory.variant).toBe("corrected");
    expect(memory.preview).toBe("Deploy from the release branch.");
    expect(memory.replacementPreview).toBe("Deploy from main after a green staging run.");
    expect(memory.memoryId).toBe("mem-old");
    expect(memory.replacementMemoryId).toBe("mem-new");
  });

  test("projects an archive (corrected, no replacement) carrying the archived action", () => {
    reset();
    const items = buildTimeline([
      event("memory.corrected", {
        memoryId: "mem-3",
        kind: "episodic",
        preview: "Tried the beta once.",
        action: "archived",
      }),
    ]);
    const memory = items[0] as MemoryItem;
    expect(memory.variant).toBe("corrected");
    expect(memory.action).toBe("archived");
    expect(memory.replacementPreview).toBeUndefined();
    expect(memory.replacementMemoryId).toBeUndefined();
  });

  test("projects an in-place update (corrected, no replacement) carrying the updated action", () => {
    reset();
    const items = buildTimeline([
      event("memory.corrected", {
        memoryId: "mem-4",
        kind: "preference",
        preview: "Prefers dark mode.",
        action: "updated",
      }),
    ]);
    const memory = items[0] as MemoryItem;
    expect(memory.variant).toBe("corrected");
    expect(memory.action).toBe("updated");
    expect(memory.replacementPreview).toBeUndefined();
  });

  test("drops a malformed memory event with no memory id rather than rendering a blank row", () => {
    reset();
    const items = buildTimeline([
      event("memory.saved", { kind: "preference", preview: "no id here" }),
    ]);
    expect(items).toEqual([]);
  });

  test("clusters memory writes as activity steps alongside tool calls", () => {
    reset();
    const groups = groupTimeline(
      buildTimeline([
        event("agent.toolCall.created", { id: "call-1", name: "memory_save", arguments: {} }),
        event("agent.toolCall.output", { id: "call-1", output: "ok" }),
        event("memory.saved", { memoryId: "mem-1", kind: "preference", preview: "A preference." }),
      ]),
    );
    const activities = collectActivityGroups(groups);
    expect(activities).toHaveLength(1);
    expect(activities[0]!.items.map((item) => item.kind)).toEqual(["tool-call", "memory"]);
  });
});
