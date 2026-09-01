import { describe, expect, test } from "bun:test";
import type {
  AuthNeededItem,
  ContextCompactionItem,
  FleetDecisionItem,
  MachineInputBatchItem,
  StartupPhaseItem,
  TimelineItem,
  WorkerCompletionItem,
} from "@opengeni/sdk/session";
import {
  authNeededPresentation,
  boundedTimelineValue,
  TIMELINE_KIND_LABELS,
  timelineItemLabel,
  timelineItemOutcome,
  timelineItemSummary,
} from "../src/timeline-presentation";

const timelineKinds = [
  "agent-message",
  "auth-needed",
  "context-compaction",
  "fleet-decision",
  "goal",
  "human-input",
  "machine-input-batch",
  "memory",
  "notice",
  "reasoning",
  "sandbox",
  "session-status",
  "startup-phase",
  "tool-call",
  "turn-end",
  "user-message",
  "worker",
  "worker-completion",
] as const satisfies readonly TimelineItem["kind"][];

describe("native Svelte timeline presentation", () => {
  test("has an exhaustive stable human label for every timeline kind", () => {
    expect(Object.keys(TIMELINE_KIND_LABELS).sort()).toEqual([...timelineKinds]);
    expect(
      timelineItemLabel({
        kind: "turn-end",
        id: "turn-end",
        turnId: "turn",
        outcome: "complete",
        failureText: null,
        occurredAt: "2026-08-29T00:00:00.000Z",
      }),
    ).toBe("Turn");
  });

  test("projects dynamic outcomes and summaries without reflective field guessing", () => {
    const startup = {
      kind: "startup-phase",
      id: "startup",
      turnId: "turn",
      phase: "provider_first_byte",
      status: "complete",
      startedAt: "2026-08-29T00:00:00.000Z",
      completedAt: "2026-08-29T00:00:00.042Z",
      durationMs: 42,
      outcome: null,
      occurredAt: "2026-08-29T00:00:00.042Z",
    } satisfies StartupPhaseItem;
    const completion = {
      kind: "worker-completion",
      id: "completion",
      turnId: "turn",
      childSessionId: "child",
      childStatus: "idle",
      goalStatus: "completed",
      goalText: "Ship the renderer",
      evidence: "All checks pass",
      pausedReason: null,
      text: "Done",
      occurredAt: "2026-08-29T00:00:01.000Z",
    } satisfies WorkerCompletionItem;
    const compaction = {
      kind: "context-compaction",
      id: "compaction",
      turnId: "turn",
      phase: "compacted",
      trigger: "auto",
      estimatedTokensBefore: 20_000,
      estimatedTokensAfter: 4_000,
      skipReason: null,
      implementation: "summary-v1",
      occurredAt: "2026-08-29T00:00:02.000Z",
    } satisfies ContextCompactionItem;

    expect(timelineItemOutcome(startup)).toBe("complete");
    expect(timelineItemSummary(startup)).toBe("provider first byte · 42 ms");
    expect(timelineItemSummary(completion)).toBe("Ship the renderer");
    expect(timelineItemSummary(compaction)).toBe("Conversation history compacted");
  });

  test("classifies batched machine input and bounds structured evidence", () => {
    const machineInput = {
      kind: "machine-input-batch",
      id: "machine",
      turnId: "turn",
      members: [
        {
          id: "needs-action",
          kind: "child_requires_action",
          classification: "action_required",
          sourceId: "child",
          summary: "Child needs approval",
        },
        {
          id: "failed",
          kind: "child_terminal_result",
          classification: "failure",
          sourceId: "child",
          summary: "Child failed",
        },
      ],
      occurredAt: "2026-08-29T00:00:03.000Z",
    } satisfies MachineInputBatchItem;
    const fleet = {
      kind: "fleet-decision",
      actualOutcome: "selected",
      actualReason: "lease_reused",
    } as FleetDecisionItem;

    expect(timelineItemOutcome(machineInput)).toBe("failed");
    expect(timelineItemSummary(machineInput)).toBe("2 machine inputs");
    expect(timelineItemSummary(fleet)).toBe("selected · lease reused");
    expect(boundedTimelineValue({ value: "abcdef" }, 8)).toBe('{\n  "val…');
  });

  test("presents capability setup rationale, action, and prerequisites", () => {
    const item = {
      kind: "auth-needed",
      id: "auth-capability",
      turnId: "turn",
      serverId: "catalog",
      source: "capability",
      providerDomain: "api.datadoghq.com",
      connectionId: null,
      reason: "missing_connection",
      scopes: [],
      resource: null,
      toolName: "query_metrics",
      authorizationUrl: null,
      capability: {
        id: "datadog",
        name: "Datadog",
        kind: "api",
        source: "library",
        action: "add_credentials",
        rationale: "Add a read-only API key to query service health.",
        requiredVariables: ["DD_API_KEY", "DD_APP_KEY"],
      },
      occurredAt: "2026-09-01T00:00:00.000Z",
    } satisfies AuthNeededItem;

    expect(authNeededPresentation(item)).toEqual({
      provider: "Datadog",
      title: "Set up Datadog",
      reasonLine: "Add a read-only API key to query service health.",
      actionLabel: "Review",
      actionable: true,
      capability: true,
      requiredVariables: ["DD_API_KEY", "DD_APP_KEY"],
      followUpLine:
        "No access has been granted. Review and confirm the provider before continuing.",
    });
    expect(timelineItemSummary(item)).toBe("Set up Datadog");
  });

  test("distinguishes missing connections from unavailable authority", () => {
    const base = {
      kind: "auth-needed",
      id: "auth",
      turnId: "turn",
      serverId: "github",
      source: "tool",
      providerDomain: "github.com",
      connectionId: null,
      scopes: [],
      resource: null,
      toolName: "list_pull_requests",
      authorizationUrl: null,
      occurredAt: "2026-09-01T00:00:00.000Z",
    } as const;
    const missing = authNeededPresentation({ ...base, reason: "missing_connection" });
    expect(missing).toMatchObject({
      title: "Connect Github",
      reasonLine: "It isn't connected yet.",
      actionLabel: "Connect",
      actionable: true,
    });
    const unavailable = authNeededPresentation({
      ...base,
      reason: "personal_authority_unavailable",
    });
    expect(unavailable).toMatchObject({
      title: "Github tools unavailable",
      actionable: false,
      followUpLine: null,
    });
  });
});
