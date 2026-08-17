import { afterEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";

import {
  SessionChrome,
  sessionChromeGoalPillState,
  sessionChromeQueueWaitCopy,
} from "../src/components/session-chrome";
import type { ComposerState } from "../src/hooks/use-composer";
import type { UseGoalResult } from "../src/hooks/use-goal";
import type { UseTurnQueueResult } from "../src/hooks/use-turn-queue";
import { fakeTurn } from "./fake-client";
import { registerDom, renderComponent, type RenderedComponent } from "./render-hook";

registerDom();

let mounted: RenderedComponent | null = null;

afterEach(async () => {
  if (mounted) {
    const current = mounted;
    mounted = null;
    await current.unmount();
  }
  document.body.replaceChildren();
});

function composer(overrides: Partial<ComposerState> = {}): ComposerState {
  return {
    value: "",
    setValue: () => {},
    send: async () => true,
    steer: async () => true,
    sending: false,
    canSend: false,
    hasDraftContent: () => false,
    pause: async () => {},
    pausing: false,
    resume: async () => {},
    resumeScope: async () => {},
    resuming: false,
    draft: null,
    draftRevision: 0,
    draftLoading: false,
    draftSaving: false,
    draftConflict: null,
    applyDraft: () => {},
    reloadDraft: async () => {},
    resolveDraftConflict: async () => {},
    restoredResources: [],
    removeRestoredResource: () => {},
    error: null,
    clearError: () => {},
    ...overrides,
  };
}

function queue(overrides: Partial<UseTurnQueueResult> = {}): UseTurnQueueResult {
  return {
    snapshot: null,
    queue: [
      fakeTurn({
        id: "11111111-1111-4111-8111-111111111111",
        prompt: "first queued prompt",
      }),
      fakeTurn({
        id: "22222222-2222-4222-8222-222222222222",
        prompt: "second queued prompt",
      }),
    ],
    pendingInputs: [],
    pendingInputAttachment: null,
    effectiveControl: null,
    stoppingPreviousAttempt: false,
    loading: false,
    error: null,
    refresh: async () => {},
    moveTurn: async () => true,
    editTurn: async () => null,
    steerTurn: async () => true,
    removeTurn: async () => true,
    pendingByTurn: {},
    mutationFor: () => null,
    mutating: false,
    mutationError: null,
    clearMutationError: () => {},
    ...overrides,
    activePersonalConnections: overrides.activePersonalConnections ?? [],
  };
}

function pausedEffectiveControl(): NonNullable<UseTurnQueueResult["effectiveControl"]> {
  return {
    state: "paused",
    controlVersion: 4,
    controlEtag: "control-4",
    directState: "paused",
    primaryBlocker: null,
    additionalBlockerCount: 0,
    blockers: [],
    resumeOptions: [],
    override: null,
    settlement: {
      state: "stopping",
      attemptCount: 1,
      interruptionPendingCount: 0,
      quiescencePendingCount: 1,
    },
  };
}

function pendingInput(): UseTurnQueueResult["pendingInputs"][number] {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    sessionId: "44444444-4444-4444-8444-444444444444",
    kind: "agent_message",
    classification: "info",
    sourceId: "55555555-5555-4555-8555-555555555555",
    summary: "Child finished Linear sync",
    createdAt: "2026-07-31T11:00:00.000Z",
  };
}

function goal(overrides: Partial<UseGoalResult["goal"]> = {}): UseGoalResult {
  const record = {
    id: "66666666-6666-4666-8666-666666666666",
    accountId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    sessionId: "22222222-2222-4222-8222-222222222222",
    status: "active" as const,
    text: "Ship the session chrome",
    successCriteria: "Production uses SessionChrome",
    evidence: null,
    rationale: null,
    pausedReason: null,
    createdBy: "api" as const,
    version: 1,
    objectiveRevision: 1,
    mutationPolicy: "preserve_intent" as const,
    autoContinuations: 2,
    noProgressStreak: 0,
    maxAutoContinuations: null,
    metadata: {},
    continuation: {
      state: "running" as const,
      reason: "goal_turn_running" as const,
      wakeRevision: 1,
      observedRevision: 1,
      nextAttemptAt: null,
      lastError: null,
    },
    createdAt: "2026-07-31T06:00:00.000Z",
    updatedAt: "2026-07-31T12:00:00.000Z",
    ...overrides,
  };
  return {
    goal: record,
    isActive: record.status === "active",
    isPaused: record.status === "paused",
    isCompleted: record.status === "completed",
    loading: false,
    error: null,
    refresh: async () => {},
    pause: async () => record,
    resume: async () => record,
    clearGoal: async () => {},
    deleteGoal: async () => {},
    updating: false,
    mutationError: null,
    clearMutationError: () => {},
  };
}

describe("sessionChromeGoalPillState", () => {
  test("maps continuation projection to pill states", () => {
    expect(sessionChromeGoalPillState("completed", null)).toBe("completed");
    expect(sessionChromeGoalPillState("paused", null)).toBe("paused");
    expect(sessionChromeGoalPillState("active", null)).toBe("invariant_broken");
    expect(
      sessionChromeGoalPillState("active", {
        state: "running",
        reason: "goal_turn_running",
        wakeRevision: 1,
        observedRevision: 1,
        nextAttemptAt: null,
        lastError: null,
      }),
    ).toBe("pursuing");
    expect(
      sessionChromeGoalPillState("active", {
        state: "blocked",
        reason: "workstream_paused",
        wakeRevision: 1,
        observedRevision: 1,
        nextAttemptAt: null,
        lastError: null,
      }),
    ).toBe("held");
  });
});

describe("sessionChromeQueueWaitCopy", () => {
  test("explains only durable queue conditions the host actually knows", () => {
    expect(sessionChromeQueueWaitCopy("running", null, false)).toContain("after the current turn");
    expect(sessionChromeQueueWaitCopy("waiting_capacity", null, false)).toContain(
      "available capacity",
    );
    expect(sessionChromeQueueWaitCopy("requires_action", null, false)).toContain("your response");
    expect(sessionChromeQueueWaitCopy("running", null, true)).toContain(
      "previous command to stop safely",
    );
    expect(sessionChromeQueueWaitCopy("failed", null, false)).toBeNull();

    const paused = pausedEffectiveControl();
    paused.primaryBlocker = {
      kind: "workspace",
      displayName: "Workspace",
      actor: null,
      reason: "Maintenance window",
      changedAt: null,
      revision: 4,
    };
    expect(sessionChromeQueueWaitCopy("running", paused, false)).toBe(
      "Paused by Workspace. Maintenance window. Resume it before queued prompts can run.",
    );
  });
});

describe("SessionChrome", () => {
  test("hides when there are no signals", async () => {
    mounted = await renderComponent(<SessionChrome queue={queue({ queue: [] })} />);
    expect(mounted.container.querySelector("[data-og-session-chrome]")).toBeNull();
  });

  test("can gain its first signal after mounting empty", async () => {
    mounted = await renderComponent(<SessionChrome queue={queue({ queue: [] })} />);
    await mounted.rerender(<SessionChrome queue={queue()} composer={composer()} />);

    expect(mounted.container.querySelector("[data-og-session-chrome]")).not.toBeNull();
    expect(mounted.container.textContent).toContain("2 queued prompts");
  });

  test("shows the current durable reason ahead of a queued prompt", async () => {
    mounted = await renderComponent(
      <SessionChrome
        queue={queue()}
        composer={composer()}
        sessionStatus="waiting_capacity"
        defaultActive="queue"
      />,
    );
    expect(
      mounted.container.querySelector('[data-testid="session-chrome-queue-wait-reason"]')
        ?.textContent,
    ).toContain("Waiting for available capacity before the next prompt can start.");
  });

  test("renders separate incoming and queue segments", async () => {
    mounted = await renderComponent(
      <SessionChrome
        queue={queue({ pendingInputs: [pendingInput()] })}
        composer={composer()}
        goal={goal()}
        agentsSignal={{ count: 2, detail: "1 running", tone: "running" }}
        agentsPanel={<div data-testid="agents-body">agents</div>}
      />,
    );
    const root = mounted.container.querySelector("[data-og-session-chrome]");
    expect(root).not.toBeNull();
    expect(
      mounted.container.querySelector('[data-og-session-chrome-signal="incoming"]'),
    ).not.toBeNull();
    expect(
      mounted.container.querySelector('[data-og-session-chrome-signal="queue"]'),
    ).not.toBeNull();
    expect(
      mounted.container.querySelector('[data-og-session-chrome-signal="goal"]'),
    ).not.toBeNull();
    expect(
      mounted.container.querySelector('[data-og-session-chrome-signal="agents"]'),
    ).not.toBeNull();
  });

  test("shows an ordinary Send receipt before the server queue refresh arrives", async () => {
    mounted = await renderComponent(
      <SessionChrome
        queue={queue({ queue: [] })}
        composer={composer({
          optimisticMessages: [
            {
              clientEventId: "client-send-1",
              text: "Investigate the startup delay",
              annotations: [],
              resources: [],
              occurredAt: "2026-08-14T10:00:00.000Z",
              state: "sending",
            },
          ],
        })}
      />,
    );

    const queueChip = mounted.container.querySelector<HTMLButtonElement>(
      '[data-og-session-chrome-signal="queue"]',
    );
    expect(queueChip?.textContent).toContain("Sending prompt");
    expect(queueChip?.textContent).toContain("Investigate the startup delay");

    await act(async () => queueChip?.click());
    const localRow = mounted.container.querySelector(
      '[data-queue-client-event-id="client-send-1"]',
    );
    expect(localRow?.textContent).toContain("Investigate the startup delay");
    expect(localRow?.textContent).toContain("Sending");
    expect(localRow?.querySelector("button")).toBeNull();
  });

  test("deduplicates an accepted Send receipt against its durable queued turn", async () => {
    const durable = fakeTurn({
      triggerEventId: "99999999-9999-4999-8999-999999999999",
      prompt: "Investigate the startup delay",
    });
    mounted = await renderComponent(
      <SessionChrome
        defaultActive="queue"
        queue={queue({ queue: [durable] })}
        composer={composer({
          optimisticMessages: [
            {
              clientEventId: "client-send-2",
              triggerEventId: durable.triggerEventId,
              text: durable.prompt,
              annotations: [],
              resources: [],
              occurredAt: "2026-08-14T10:00:00.000Z",
              state: "queued",
            },
          ],
        })}
      />,
    );

    expect(
      mounted.container.querySelector('[data-og-session-chrome-signal="queue"]')?.textContent,
    ).toContain("1 queued prompt");
    expect(mounted.container.querySelectorAll("[data-queue-turn-id]")).toHaveLength(1);
    expect(mounted.container.querySelector("[data-queue-client-event-id]")).toBeNull();
  });

  test("presents queued realtime work as voice instead of leaking agent context", async () => {
    const transcript = "Find the LangFuse repository";
    const prompt = [
      "<realtime_delegation>",
      `  <input>${transcript}</input>`,
      "  <transcript_delta>user: please do that too</transcript_delta>",
      "</realtime_delegation>",
    ].join("\n");
    mounted = await renderComponent(
      <SessionChrome
        queue={queue({
          queue: [
            fakeTurn({
              prompt,
              metadata: {
                realtimeDelegation: { inputTranscript: transcript },
              },
            }),
          ],
        })}
        composer={composer()}
      />,
    );

    const queueChip = mounted.container.querySelector<HTMLButtonElement>(
      '[data-og-session-chrome-signal="queue"]',
    );
    expect(queueChip?.textContent).toContain("Voice request queued");
    expect(queueChip?.textContent).toContain(transcript);
    expect(queueChip?.textContent).not.toContain("realtime_delegation");
    expect(queueChip?.querySelector(".lucide-audio-lines")).not.toBeNull();

    await act(async () => {
      queueChip?.click();
    });
    const panel = mounted.container.querySelector('[data-og-session-chrome-panel="queue"]');
    expect(panel?.textContent).toContain(transcript);
    expect(panel?.textContent).not.toContain("realtime_delegation");
  });

  test("presents an accepted Steer as changing direction instead of queued", async () => {
    const steeringTurn = fakeTurn({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      prompt: "Focus on the authentication failure first",
      position: 0,
      metadata: { delivery: "steer" },
    });
    const laterTurn = fakeTurn({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      prompt: "Then update the documentation",
      position: 1,
    });
    mounted = await renderComponent(
      <SessionChrome queue={queue({ queue: [steeringTurn, laterTurn] })} composer={composer()} />,
    );

    const steeringChip = mounted.container.querySelector<HTMLButtonElement>(
      '[data-og-session-chrome-signal="steering"]',
    );
    const queueChip = mounted.container.querySelector<HTMLButtonElement>(
      '[data-og-session-chrome-signal="queue"]',
    );
    expect(steeringChip?.textContent).toContain("Changing direction");
    expect(steeringChip?.textContent).toContain("Focus on the authentication failure first");
    expect(queueChip?.textContent).toContain("1 queued prompt");

    await act(async () => steeringChip?.click());
    const steeringPanel = mounted.container.querySelector(
      '[data-og-session-chrome-panel="steering"]',
    );
    expect(steeringPanel?.textContent).toContain("Direction accepted");
    expect(steeringPanel?.textContent).not.toContain("stopped");

    await act(async () => queueChip?.click());
    const queuePanel = mounted.container.querySelector('[data-og-session-chrome-panel="queue"]');
    expect(queuePanel?.textContent).toContain("Then update the documentation");
    expect(queuePanel?.textContent).not.toContain("Focus on the authentication failure first");
  });

  test("shows a composer Steer optimistically before the server responds", async () => {
    mounted = await renderComponent(
      <SessionChrome
        queue={queue({ queue: [] })}
        composer={composer({
          sending: true,
          steering: {
            phase: "submitting",
            text: "Use the smaller patch",
            clientEventId: "client-steer-1",
            triggerEventId: null,
            turnId: null,
          },
        })}
      />,
    );

    const steeringChip = mounted.container.querySelector<HTMLButtonElement>(
      '[data-og-session-chrome-signal="steering"]',
    );
    expect(steeringChip?.textContent).toContain("Changing direction");
    expect(steeringChip?.textContent).toContain("Use the smaller patch");
    expect(mounted.container.querySelector('[data-og-session-chrome-signal="queue"]')).toBeNull();
  });

  test("shows accepted Steer as stopping while physical quiescence is pending", async () => {
    const steeringTurn = fakeTurn({
      prompt: "Use the corrected digest",
      metadata: { delivery: "steer" },
    });
    mounted = await renderComponent(
      <SessionChrome
        queue={queue({ queue: [steeringTurn], stoppingPreviousAttempt: true })}
        composer={composer()}
      />,
    );

    const steeringChip = mounted.container.querySelector<HTMLButtonElement>(
      '[data-og-session-chrome-signal="steering"]',
    );
    expect(steeringChip?.textContent).toContain("Stopping previous work");
    expect(steeringChip?.textContent).not.toContain("Changing direction");

    await act(async () => steeringChip?.click());
    const steeringPanel = mounted.container.querySelector(
      '[data-og-session-chrome-panel="steering"]',
    );
    expect(steeringPanel?.textContent).toContain("Direction saved");
    expect(steeringPanel?.textContent).toContain("previous command to stop safely");
    expect(steeringPanel?.textContent).not.toContain("agent will continue");
  });

  test("shows an accepted composer Steer receipt before the queue refresh arrives", async () => {
    mounted = await renderComponent(
      <SessionChrome
        queue={queue({ queue: [], stoppingPreviousAttempt: false })}
        composer={composer({
          stoppingAttempt: "previous",
          steering: {
            phase: "accepted",
            text: "Use the corrected digest",
            clientEventId: "client-steer-2",
            triggerEventId: "event-steer-2",
            turnId: "11111111-1111-4111-8111-111111111111",
            stoppingPreviousAttempt: true,
          },
        })}
      />,
    );

    const steeringChip = mounted.container.querySelector<HTMLButtonElement>(
      '[data-og-session-chrome-signal="steering"]',
    );
    expect(steeringChip?.textContent).toContain("Stopping previous work");
    expect(steeringChip?.textContent).not.toContain("Changing direction");
  });

  test("shows a Pause receipt as stopping current work before the queue refresh arrives", async () => {
    mounted = await renderComponent(
      <SessionChrome
        queue={queue({ queue: [], stoppingPreviousAttempt: false })}
        composer={composer({ stoppingAttempt: "current" })}
      />,
    );

    const stoppingChip = mounted.container.querySelector<HTMLButtonElement>(
      '[data-og-session-chrome-signal="steering"]',
    );
    expect(stoppingChip?.textContent).toContain("Stopping current work");
    await act(async () => stoppingChip?.click());
    expect(
      mounted.container.querySelector('[data-og-session-chrome-panel="steering"]')?.textContent,
    ).toContain("current command to stop safely");
  });

  test("shows stopping even when no Steer is queued", async () => {
    mounted = await renderComponent(
      <SessionChrome
        queue={queue({
          queue: [],
          stoppingPreviousAttempt: true,
          effectiveControl: pausedEffectiveControl(),
        })}
      />,
    );

    const stoppingChip = mounted.container.querySelector<HTMLButtonElement>(
      '[data-og-session-chrome-signal="steering"]',
    );
    expect(stoppingChip?.textContent).toContain("Stopping current work");
    await act(async () => stoppingChip?.click());
    expect(
      mounted.container.querySelector('[data-og-session-chrome-panel="steering"]')?.textContent,
    ).toContain("current command to stop safely");
  });

  test("expands queue with clear direct and disclosed actions wired to queue APIs", async () => {
    const calls: string[] = [];
    const q = queue({
      removeTurn: async (turnId) => {
        calls.push(`remove:${turnId}`);
        return true;
      },
      steerTurn: async (turnId) => {
        calls.push(`steer:${turnId}`);
        return true;
      },
      moveTurn: async (turnId, before) => {
        calls.push(`move:${turnId}:${before ?? "null"}`);
        return true;
      },
      editTurn: async (turnId) => {
        calls.push(`edit:${turnId}`);
        return null;
      },
    });
    mounted = await renderComponent(<SessionChrome queue={q} composer={composer()} />);

    const queueChip = mounted.container.querySelector<HTMLButtonElement>(
      '[data-og-session-chrome-signal="queue"]',
    );
    expect(queueChip).not.toBeNull();
    await act(async () => {
      queueChip?.click();
    });
    expect(
      mounted.container.querySelector('[data-og-session-chrome-panel="queue"]'),
    ).not.toBeNull();
    expect(mounted.container.querySelector('[data-og-session-chrome-open="true"]')).not.toBeNull();

    const steer = mounted.container.querySelector<HTMLButtonElement>(
      '[aria-label="Steer queued prompt 1"]',
    );
    const more = mounted.container.querySelector<HTMLButtonElement>(
      '[aria-label="More actions for queued prompt 1"]',
    );
    expect(steer?.textContent).toBe("Steer");
    expect(more?.textContent).toBe("More");
    expect(more?.getAttribute("aria-expanded")).toBe("false");
    const firstQueueRow = mounted.container.querySelector<HTMLElement>(
      '[data-queue-turn-id="11111111-1111-4111-8111-111111111111"]',
    );
    expect(firstQueueRow?.style.contentVisibility).toBe("auto");
    expect(firstQueueRow?.style.containIntrinsicSize).toBe(
      "auto var(--_og-session-chrome-queue-row-intrinsic-size)",
    );
    expect(firstQueueRow?.className).toContain(
      "[--_og-session-chrome-queue-row-intrinsic-size:1.75rem]",
    );
    expect(firstQueueRow?.className).toContain(
      "pointer-coarse:[--_og-session-chrome-queue-row-intrinsic-size:2.75rem]",
    );
    expect(mounted.container.querySelector('[aria-label="Remove queued prompt 1"]')).toBeNull();
    await act(async () => {
      more?.click();
    });

    const remove = mounted.container.querySelector<HTMLButtonElement>(
      '[aria-label="Remove queued prompt 1"]',
    );
    const edit = mounted.container.querySelector<HTMLButtonElement>(
      '[aria-label="Edit queued prompt 1"]',
    );
    const moveDown = mounted.container.querySelector<HTMLButtonElement>(
      '[aria-label="Move queued prompt 1 down"]',
    );
    expect(remove).not.toBeNull();
    expect(steer).not.toBeNull();
    expect(edit).not.toBeNull();
    expect(moveDown).not.toBeNull();
    expect(remove?.textContent).toBe("Delete");
    expect(edit?.textContent).toBe("Edit");
    expect(more?.getAttribute("aria-expanded")).toBe("true");
    expect(
      mounted.container.querySelector(`#${more?.getAttribute("aria-controls")}`),
    ).not.toBeNull();
    expect(moveDown?.dataset.queueCommand).toBe("move");
    expect(moveDown?.dataset.queueCommandTurnId).toBe("11111111-1111-4111-8111-111111111111");
    expect(remove?.querySelector("svg")).toBeNull();

    await act(async () => {
      steer?.click();
      remove?.click();
      edit?.click();
      moveDown?.click();
    });
    expect(calls).toContain("steer:11111111-1111-4111-8111-111111111111");
    expect(calls).toContain("remove:11111111-1111-4111-8111-111111111111");
    expect(calls).toContain("edit:11111111-1111-4111-8111-111111111111");
    expect(
      calls.some((entry) => entry.startsWith("move:11111111-1111-4111-8111-111111111111:")),
    ).toBe(true);
  });

  test("keeps the complete projected order visible while a production queue move is pending", async () => {
    const first = fakeTurn({
      id: "11111111-1111-4111-8111-111111111111",
      prompt: "first queued prompt",
    });
    const second = fakeTurn({
      id: "22222222-2222-4222-8222-222222222222",
      prompt: "second queued prompt",
    });
    let releaseMove!: () => void;
    const moveGate = new Promise<void>((resolve) => {
      releaseMove = resolve;
    });

    function Harness() {
      const [items, setItems] = useState([first, second]);
      const [pendingTurnId, setPendingTurnId] = useState<string | null>(null);
      return (
        <SessionChrome
          defaultActive="queue"
          composer={composer()}
          queue={queue({
            queue: items,
            pendingByTurn: pendingTurnId ? { [pendingTurnId]: "move" } : {},
            mutationFor: (turnId) => (turnId === pendingTurnId ? "move" : null),
            mutating: pendingTurnId !== null,
            moveTurn: async (turnId) => {
              setPendingTurnId(turnId);
              await moveGate;
              setItems([second, first]);
              setPendingTurnId(null);
              return true;
            },
          })}
        />
      );
    }

    mounted = await renderComponent(<Harness />);
    await act(async () => {
      mounted?.container
        .querySelector<HTMLButtonElement>('[aria-label="More actions for queued prompt 1"]')
        ?.click();
    });
    const moveDown = mounted.container.querySelector<HTMLButtonElement>(
      '[aria-label="Move queued prompt 1 down"]',
    );
    await act(async () => {
      moveDown?.click();
      await Promise.resolve();
    });
    expect(
      [...mounted.container.querySelectorAll("[data-queue-turn-id]")].map((row) =>
        row.getAttribute("data-queue-turn-id"),
      ),
    ).toEqual([second.id, first.id]);
    expect(
      mounted.container.querySelector('[data-testid="session-chrome-queue-mutation-move"]')
        ?.textContent,
    ).toContain("Saving new position…");

    await act(async () => {
      releaseMove();
      await moveGate;
    });
    expect(
      [...mounted.container.querySelectorAll("[data-queue-turn-id]")].map((row) =>
        row.getAttribute("data-queue-turn-id"),
      ),
    ).toEqual([second.id, first.id]);
  });

  test("restores canonical order and explains a rejected production queue move", async () => {
    const first = fakeTurn({
      id: "11111111-1111-4111-8111-111111111111",
      prompt: "first queued prompt",
    });
    const second = fakeTurn({
      id: "22222222-2222-4222-8222-222222222222",
      prompt: "second queued prompt",
    });
    let releaseMove!: () => void;
    const moveGate = new Promise<void>((resolve) => {
      releaseMove = resolve;
    });

    function Harness() {
      const [pendingTurnId, setPendingTurnId] = useState<string | null>(null);
      const [mutationError, setMutationError] = useState<Error | null>(null);
      return (
        <SessionChrome
          defaultActive="queue"
          composer={composer()}
          queue={queue({
            queue: [first, second],
            pendingByTurn: pendingTurnId ? { [pendingTurnId]: "move" } : {},
            mutationFor: (turnId) => (turnId === pendingTurnId ? "move" : null),
            mutating: pendingTurnId !== null,
            mutationError,
            moveTurn: async (turnId) => {
              setPendingTurnId(turnId);
              await moveGate;
              setMutationError(new Error("Queue version changed on the server"));
              setPendingTurnId(null);
              return false;
            },
          })}
        />
      );
    }

    mounted = await renderComponent(<Harness />);
    await act(async () => {
      mounted?.container
        .querySelector<HTMLButtonElement>('[aria-label="More actions for queued prompt 1"]')
        ?.click();
    });
    await act(async () => {
      mounted?.container
        .querySelector<HTMLButtonElement>('[aria-label="Move queued prompt 1 down"]')
        ?.click();
      await Promise.resolve();
    });
    expect(
      [...mounted.container.querySelectorAll("[data-queue-turn-id]")].map((row) =>
        row.getAttribute("data-queue-turn-id"),
      ),
    ).toEqual([second.id, first.id]);

    await act(async () => {
      releaseMove();
      await moveGate;
    });
    expect(
      [...mounted.container.querySelectorAll("[data-queue-turn-id]")].map((row) =>
        row.getAttribute("data-queue-turn-id"),
      ),
    ).toEqual([first.id, second.id]);
    expect(
      mounted.container.querySelector('[data-testid="session-chrome-queue-error"]')?.textContent,
    ).toContain("Queue version changed on the server");
  });

  test("applies the checked-out queue draft to the production composer immediately", async () => {
    const applied: string[] = [];
    const source = fakeTurn({
      id: "11111111-1111-4111-8111-111111111111",
      prompt: "edit this exact queued prompt",
    });
    mounted = await renderComponent(
      <SessionChrome
        defaultActive="queue"
        queue={queue({
          queue: [source],
          editTurn: async () => ({
            revision: 3,
            text: source.prompt,
            resources: source.resources,
            tools: source.tools,
            toolsProvided: true,
            model: source.model,
            reasoningEffort: source.reasoningEffort,
            latencyMode: source.latencyMode,
            sourceTurnId: source.id,
            sourceTurnVersion: source.version,
            updatedAt: new Date().toISOString(),
          }),
        })}
        composer={composer({ applyDraft: (draft) => applied.push(draft.text) })}
      />,
    );

    await act(async () => {
      mounted?.container
        .querySelector<HTMLButtonElement>('[aria-label="More actions for queued prompt 1"]')
        ?.click();
    });
    await act(async () => {
      mounted?.container
        .querySelector<HTMLButtonElement>('[aria-label="Edit queued prompt 1"]')
        ?.click();
      await Promise.resolve();
    });
    expect(applied).toEqual([source.prompt]);
  });

  test("surfaces queue mutation failures with canonical refresh and dismissal actions", async () => {
    let refreshed = 0;
    let dismissed = 0;
    mounted = await renderComponent(
      <SessionChrome
        defaultActive="queue"
        queue={queue({
          queue: [],
          mutationError: new Error("Queue version changed on the server"),
          refresh: async () => {
            refreshed += 1;
          },
          clearMutationError: () => {
            dismissed += 1;
          },
        })}
        composer={composer()}
      />,
    );

    expect(
      mounted.container.querySelector('[data-og-session-chrome-signal="queue"]')?.textContent,
    ).toContain("Queue action failed");
    const alert = mounted.container.querySelector('[data-testid="session-chrome-queue-error"]');
    expect(alert?.textContent).toContain("The queue action was not applied.");
    expect(alert?.textContent).toContain("Queue version changed on the server");
    await act(async () => {
      [...alert!.querySelectorAll("button")].forEach((button) => button.click());
      await Promise.resolve();
    });
    expect(refreshed).toBe(1);
    expect(dismissed).toBe(1);
  });

  test("inbox dismiss action appears when onDismissIncoming is provided", async () => {
    const dismissed: string[] = [];
    mounted = await renderComponent(
      <SessionChrome
        queue={queue({ queue: [], pendingInputs: [pendingInput()] })}
        onDismissIncoming={(id) => {
          dismissed.push(id);
        }}
      />,
    );
    const chip = mounted.container.querySelector<HTMLButtonElement>(
      '[data-og-session-chrome-signal="incoming"]',
    );
    await act(async () => {
      chip?.click();
    });
    const dismiss = mounted.container.querySelector<HTMLButtonElement>(
      '[aria-label="Dismiss incoming Update"]',
    );
    expect(dismiss).not.toBeNull();
    await act(async () => {
      dismiss?.click();
    });
    expect(dismissed).toEqual(["33333333-3333-4333-8333-333333333333"]);
  });

  test("segment switches keep the panel shell and queue actions explain themselves on touch", async () => {
    mounted = await renderComponent(
      <SessionChrome
        queue={queue({ pendingInputs: [pendingInput()] })}
        composer={composer()}
        goal={goal()}
        agentsSignal={{ count: 1, detail: "running" }}
        agentsPanel={<div data-testid="agents-body">agents</div>}
      />,
    );

    const goalChip = mounted.container.querySelector<HTMLButtonElement>(
      '[data-og-session-chrome-signal="goal"]',
    );
    const queueChip = mounted.container.querySelector<HTMLButtonElement>(
      '[data-og-session-chrome-signal="queue"]',
    );
    expect(goalChip).not.toBeNull();
    expect(queueChip).not.toBeNull();

    await act(async () => {
      goalChip?.click();
    });
    const shell = mounted.container.querySelector("[data-og-session-chrome-panel-shell]");
    expect(shell).not.toBeNull();
    expect(mounted.container.querySelector('[data-og-session-chrome-panel="goal"]')).not.toBeNull();
    expect(mounted.container.querySelector('[data-og-session-chrome-open="true"]')).not.toBeNull();

    await act(async () => {
      queueChip?.click();
    });
    expect(mounted.container.querySelector("[data-og-session-chrome-panel-shell]")).toBe(shell);
    expect(
      mounted.container.querySelector('[data-og-session-chrome-panel="queue"]'),
    ).not.toBeNull();
    expect(mounted.container.querySelector('[data-og-session-chrome-open="true"]')).not.toBeNull();

    const steer = mounted.container.querySelector<HTMLButtonElement>(
      '[aria-label="Steer queued prompt 1"]',
    );
    expect(steer).not.toBeNull();
    expect(steer?.textContent).toBe("Steer");
    expect(steer?.getAttribute("title")).toBeNull();
    const more = mounted.container.querySelector<HTMLButtonElement>(
      '[aria-label="More actions for queued prompt 1"]',
    );
    expect(more?.textContent).toBe("More");
    expect(mounted.container.querySelector('[aria-label="Remove queued prompt 1"]')).toBeNull();
    await act(async () => {
      more?.click();
    });
    const remove = mounted.container.querySelector<HTMLButtonElement>(
      '[aria-label="Remove queued prompt 1"]',
    );
    expect(remove?.textContent).toBe("Delete");
    expect(remove?.getAttribute("title")).toBeNull();
    expect(more?.getAttribute("aria-expanded")).toBe("true");
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();

    // Truncated prompt / signal chips stay tip-free; queue controls use visible copy.
    const prompt = mounted.container.querySelector('[data-og-session-chrome-panel="queue"] p');
    expect(prompt?.closest('[data-slot="tooltip-trigger"]')).toBeNull();
    expect(queueChip?.getAttribute("data-slot")).not.toBe("tooltip-trigger");
  });

  test("puts the close affordance on the expanded chip", async () => {
    mounted = await renderComponent(
      <SessionChrome
        queue={queue({
          queue: [
            fakeTurn({
              prompt: "Queued prompt that should wrap on a narrow rail",
            }),
          ],
        })}
        composer={composer()}
        goal={goal()}
        agentsSignal={{ count: 15, detail: "Idle" }}
        defaultActive="agents"
      />,
    );
    const agentsChip = mounted.container.querySelector<HTMLButtonElement>(
      '[data-og-session-chrome-signal="agents"]',
    );
    const close = agentsChip?.querySelector('[data-testid="session-chrome-close"]');
    expect(close).not.toBeNull();
    expect(agentsChip?.getAttribute("aria-label")).toBe("Close 15 agents");
    // Other chips stay free of a close glyph.
    const queueChip = mounted.container.querySelector('[data-og-session-chrome-signal="queue"]');
    expect(queueChip?.querySelector('[data-testid="session-chrome-close"]')).toBeNull();
  });

  test("caps expanded panel height so long agents/queue lists scroll inside", async () => {
    mounted = await renderComponent(
      <SessionChrome
        queue={queue({ queue: [] })}
        agentsSignal={{ count: 29, detail: "5 paused", tone: "waiting" }}
        agentsPanel={
          <ul data-testid="agents-body">
            {Array.from({ length: 29 }, (_, index) => (
              <li key={index}>agent {index + 1}</li>
            ))}
          </ul>
        }
      />,
    );
    const agentsChip = mounted.container.querySelector<HTMLButtonElement>(
      '[data-og-session-chrome-signal="agents"]',
    );
    await act(async () => {
      agentsChip?.click();
    });
    const body = mounted.container.querySelector<HTMLElement>(
      "[data-og-session-chrome-panel-shell] > div",
    );
    expect(body).not.toBeNull();
    expect(body?.style.maxHeight).toBe("var(--og-session-chrome-panel-max-height)");
    expect(body?.className).toContain("overflow-y-auto");
  });
});
