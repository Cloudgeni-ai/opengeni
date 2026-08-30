import { describe, expect, test } from "bun:test";
import type {
  ContextCompactionItem,
  FleetDecisionItem,
  MachineInputBatchItem,
  StartupPhaseItem,
  TimelineItem,
  WorkerCompletionItem,
} from "@opengeni/sdk/session";
import {
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
});
