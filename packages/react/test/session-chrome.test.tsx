import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";

import {
  SessionChrome,
  sessionChromeGoalPillExplanation,
  sessionChromeGoalPillLabel,
  sessionChromeGoalPillState,
} from "../src/components/session-chrome";
import { formatClockTime } from "../src/lib/format";
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
    rootConstraints: overrides?.rootConstraints ?? [],
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
        state: "running",
        reason: "human_turn_running",
        wakeRevision: 1,
        observedRevision: 1,
        nextAttemptAt: null,
        lastError: null,
      }),
    ).toBe("waiting");
    expect(
      sessionChromeGoalPillState("active", {
        state: "blocked",
        reason: "human_turn_running",
        wakeRevision: 1,
        observedRevision: 1,
        nextAttemptAt: null,
        lastError: null,
      }),
    ).toBe("waiting");
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
    // An agent-declared wait_for_input hold shares the Held pill: the goal is
    // deliberately waiting for child results / external input until a deadline.
    expect(
      sessionChromeGoalPillState("active", {
        state: "blocked",
        reason: "held_for_input",
        wakeRevision: 2,
        observedRevision: 1,
        nextAttemptAt: "2026-01-01T00:00:00.000Z",
        lastError: null,
      }),
    ).toBe("held");
    // Idle backoff between consecutive no-input continuations is ordinary
    // scheduled work with a known next-attempt time, not a blocked goal.
    expect(
      sessionChromeGoalPillState("active", {
        state: "scheduled",
        reason: "backoff_pending",
        wakeRevision: 2,
        observedRevision: 1,
        nextAttemptAt: "2026-01-01T00:00:00.000Z",
        lastError: null,
      }),
    ).toBe("scheduled");
  });
});

describe("SessionChrome", () => {
  test("hides when there are no signals", async () => {
    mounted = await renderComponent(<SessionChrome queue={queue({ queue: [] })} />);
    expect(mounted.container.querySelector("[data-og-session-chrome]")).toBeNull();
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

  test("keeps accepted Steer out of queue chrome", async () => {
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

    const queueChip = mounted.container.querySelector<HTMLButtonElement>(
      '[data-og-session-chrome-signal="queue"]',
    );
    expect(
      mounted.container.querySelector('[data-og-session-chrome-signal="steering"]'),
    ).toBeNull();
    expect(queueChip?.textContent).toContain("1 queued prompt");

    await act(async () => queueChip?.click());
    const queuePanel = mounted.container.querySelector('[data-og-session-chrome-panel="queue"]');
    expect(queuePanel?.textContent).toContain("Then update the documentation");
    expect(queuePanel?.textContent).not.toContain("Focus on the authentication failure first");
  });

  test("does not manufacture chrome for an optimistic Steer", async () => {
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

    expect(
      mounted.container.querySelector('[data-og-session-chrome-signal="steering"]'),
    ).toBeNull();
    expect(mounted.container.querySelector('[data-og-session-chrome-signal="queue"]')).toBeNull();
  });

  test("lands an optimistic Send in the queue instead of chat chrome", async () => {
    mounted = await renderComponent(
      <SessionChrome
        queue={queue({ queue: [] })}
        composer={composer({
          optimisticMessages: [
            {
              clientEventId: "client-send-queued-1",
              delivery: "send",
              destination: "queue",
              text: "Run this after the current task",
              annotations: [],
              resources: [],
              occurredAt: new Date().toISOString(),
              state: "sending",
            },
          ],
        })}
      />,
    );

    expect(
      mounted.container.querySelector('[data-og-session-chrome-signal="queue"]')?.textContent,
    ).toContain("1 queued prompt");
    await act(async () => {
      mounted!.container
        .querySelector<HTMLButtonElement>('[data-og-session-chrome-signal="queue"]')
        ?.click();
    });
    expect(
      mounted.container.querySelector("[data-optimistic-queue-message]")?.textContent,
    ).toContain("Run this after the current task");
    expect(
      mounted.container.querySelector('[data-og-session-chrome-signal="steering"]'),
    ).toBeNull();
  });

  test("a live queued Send marks the stable queue chip without opening or moving the drawer", async () => {
    mounted = await renderComponent(
      <SessionChrome queue={queue({ queue: [] })} composer={composer()} />,
    );

    await mounted.rerender(
      <SessionChrome
        queue={queue({ queue: [] })}
        composer={composer({
          optimisticMessages: [
            {
              clientEventId: "client-send-arrival-1",
              delivery: "send",
              destination: "queue",
              text: "Run after the active turn",
              annotations: [],
              resources: [],
              occurredAt: new Date().toISOString(),
              state: "sending",
            },
          ],
        })}
      />,
    );

    expect(
      mounted.container.querySelector('[data-og-session-chrome-signal="queue"]')?.textContent,
    ).toContain("1 queued prompt");
    expect(mounted.container.querySelector('[data-og-session-chrome-open="false"]')).not.toBeNull();
    expect(mounted.container.querySelector('[data-og-session-chrome-panel="queue"]')).toBeNull();
    expect(
      mounted.container.querySelector('[data-testid="session-chrome-queue-arrival"]'),
    ).not.toBeNull();
  });

  test("stops animating once an optimistic queue placement is confirmed", async () => {
    mounted = await renderComponent(
      <SessionChrome
        queue={queue({ queue: [] })}
        composer={composer({
          optimisticMessages: [
            {
              clientEventId: "client-send-confirmed-1",
              delivery: "send",
              destination: "queue",
              text: "Confirmed queued work",
              annotations: [],
              resources: [],
              occurredAt: new Date().toISOString(),
              state: "queued",
            },
          ],
        })}
      />,
    );

    await act(async () => {
      mounted!.container
        .querySelector<HTMLButtonElement>('[data-og-session-chrome-signal="queue"]')
        ?.click();
    });
    const row = mounted.container.querySelector("[data-optimistic-queue-message]");
    expect(row?.textContent).toContain("Queued");
    expect(row?.querySelector(".animate-og-spin")).toBeNull();
  });

  test("surfaces and retries an empty authoritative queue load failure", async () => {
    let refreshCalls = 0;
    mounted = await renderComponent(
      <SessionChrome
        queue={queue({
          queue: [],
          error: new Error("gateway timeout"),
          refresh: async () => {
            refreshCalls += 1;
          },
        })}
        composer={composer()}
      />,
    );

    const chip = mounted.container.querySelector<HTMLButtonElement>(
      '[data-og-session-chrome-signal="queue"]',
    );
    expect(chip?.textContent).toContain("Queue needs attention");
    await act(async () => chip?.click());
    const panel = mounted.container.querySelector('[data-og-session-chrome-panel="queue"]');
    expect(panel?.textContent).toContain("Queue unavailable");
    await act(async () => {
      Array.from(panel?.querySelectorAll("button") ?? [])
        .find((button) => button.textContent === "Retry")
        ?.click();
    });
    expect(refreshCalls).toBe(1);
  });

  test("keeps an empty queue mutation failure visible until dismissed", async () => {
    let dismissed = 0;
    mounted = await renderComponent(
      <SessionChrome
        queue={queue({
          queue: [],
          mutationError: new Error("outcome unknown"),
          clearMutationError: () => {
            dismissed += 1;
          },
        })}
        composer={composer()}
      />,
    );

    const chip = mounted.container.querySelector<HTMLButtonElement>(
      '[data-og-session-chrome-signal="queue"]',
    );
    expect(chip?.textContent).toContain("Queue needs attention");
    await act(async () => chip?.click());
    const panel = mounted.container.querySelector('[data-og-session-chrome-panel="queue"]');
    expect(panel?.textContent).toContain("Not confirmed");
    await act(async () => {
      Array.from(panel?.querySelectorAll("button") ?? [])
        .find((button) => button.textContent === "Dismiss")
        ?.click();
    });
    expect(dismissed).toBe(1);
  });

  test("retires the optimistic queue row once an authoritative snapshot passes its receipt", async () => {
    const effectiveControl = pausedEffectiveControl();
    const optimisticMessages: NonNullable<ComposerState["optimisticMessages"]> = [
      {
        clientEventId: "client-send-started-1",
        delivery: "send",
        destination: "queue",
        turnId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        appliedQueueVersion: 4,
        text: "This turn has already started",
        annotations: [],
        resources: [],
        occurredAt: new Date().toISOString(),
        state: "queued",
      },
    ];
    mounted = await renderComponent(
      <SessionChrome
        queue={queue({ queue: [], effectiveControl })}
        composer={composer({ optimisticMessages })}
      />,
    );
    await act(async () => {
      mounted!.container
        .querySelector<HTMLButtonElement>('[data-og-session-chrome-signal="queue"]')
        ?.click();
    });
    expect(mounted.container.querySelector("[data-optimistic-queue-message]")).not.toBeNull();

    await mounted.rerender(
      <SessionChrome
        queue={queue({
          snapshot: {
            version: 4,
            effectiveControl,
            stoppingPreviousAttempt: false,
            items: [],
            pendingInputs: [],
            pendingInputAttachment: null,
            activePersonalConnections: [],
          },
          queue: [],
          effectiveControl,
        })}
        composer={composer({ optimisticMessages })}
      />,
    );

    expect(mounted.container.querySelector('[data-og-session-chrome-signal="queue"]')).toBeNull();
    expect(mounted.container.querySelector("[data-optimistic-queue-message]")).toBeNull();
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

    expect(
      mounted.container.querySelector('[data-og-session-chrome-signal="steering"]'),
    ).toBeNull();
    expect(
      mounted.container.querySelector('[data-testid="session-chrome-stopping"]')?.textContent,
    ).toContain("Previous work stopping");
    expect(mounted.container.querySelector('[data-og-session-chrome-panel="steering"]')).toBeNull();
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

    expect(
      mounted.container.querySelector('[data-testid="session-chrome-stopping"]')?.textContent,
    ).toContain("Previous work stopping");
    expect(
      mounted.container.querySelector('[data-og-session-chrome-signal="steering"]'),
    ).toBeNull();
  });

  test("shows a Pause receipt as stopping current work before the queue refresh arrives", async () => {
    mounted = await renderComponent(
      <SessionChrome
        queue={queue({ queue: [], stoppingPreviousAttempt: false })}
        composer={composer({ stoppingAttempt: "current" })}
      />,
    );

    expect(
      mounted.container.querySelector('[data-testid="session-chrome-stopping"]')?.textContent,
    ).toContain("Current work stopping");
    expect(mounted.container.querySelector('[data-og-session-chrome-panel="steering"]')).toBeNull();
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

    expect(
      mounted.container.querySelector('[data-testid="session-chrome-stopping"]')?.textContent,
    ).toContain("Current work stopping");
    expect(mounted.container.querySelector('[data-og-session-chrome-panel="steering"]')).toBeNull();
  });

  test("expands queue and reveals hover actions wired to queue APIs", async () => {
    const calls: string[] = [];
    const appliedDrafts: Array<NonNullable<ComposerState["draft"]>> = [];
    const checkedOut: NonNullable<ComposerState["draft"]> = {
      revision: 3,
      text: "first queued prompt",
      resources: [],
      model: "model-x",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sourceTurnId: "11111111-1111-4111-8111-111111111111",
      sourceTurnVersion: 1,
      updatedAt: new Date().toISOString(),
    };
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
        return checkedOut;
      },
    });
    mounted = await renderComponent(
      <SessionChrome
        queue={q}
        composer={composer({
          applyDraft: (draft) => appliedDrafts.push(draft),
        })}
      />,
    );

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

    const remove = mounted.container.querySelector<HTMLButtonElement>(
      '[aria-label="Remove queued prompt 1"]',
    );
    const steer = mounted.container.querySelector<HTMLButtonElement>(
      '[aria-label="Steer queued prompt 1"]',
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
    expect(steer?.disabled).toBe(true);

    // The optimistic→authoritative row handoff must settle before pointer
    // actions become available; otherwise a press can be lost on DOM replace.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 260));
    });
    expect(steer?.disabled).toBe(false);

    await act(async () => {
      steer?.click();
      remove?.click();
      edit?.click();
      moveDown?.click();
    });
    expect(calls).toContain("steer:11111111-1111-4111-8111-111111111111");
    expect(calls).toContain("remove:11111111-1111-4111-8111-111111111111");
    expect(calls).toContain("edit:11111111-1111-4111-8111-111111111111");
    expect(appliedDrafts).toEqual([checkedOut]);
    expect(
      calls.some((entry) => entry.startsWith("move:11111111-1111-4111-8111-111111111111:")),
    ).toBe(true);
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

  test("segment switches keep the panel shell and drop native title tooltips", async () => {
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

    const remove = mounted.container.querySelector<HTMLButtonElement>(
      '[aria-label="Remove queued prompt 1"]',
    );
    expect(remove).not.toBeNull();
    expect(remove?.getAttribute("title")).toBeNull();
    expect(remove?.getAttribute("data-slot")).toBe("tooltip-trigger");

    const steer = mounted.container.querySelector<HTMLButtonElement>(
      '[aria-label="Steer queued prompt 1"]',
    );
    expect(steer).not.toBeNull();
    expect(steer?.getAttribute("data-slot")).toBe("tooltip-trigger");

    // Truncated prompt / signal chips stay tip-free; only icon actions use Tooltip.
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
      "[data-og-session-chrome-panel-shell] > div > div",
    );
    expect(body).not.toBeNull();
    expect(body?.style.maxHeight).toBe("var(--og-session-chrome-panel-max-height)");
    expect(body?.className).toContain("overflow-y-auto");
  });
});

describe("SessionChrome goal pill reasons", () => {
  const paused = (pausedReason: string | null) =>
    goal({
      status: "paused",
      pausedReason,
      continuation: {
        state: "inactive",
        reason: "goal_inactive",
        wakeRevision: 1,
        observedRevision: 1,
        nextAttemptAt: null,
        lastError: null,
      },
    });

  test("spells out why a goal is paused", () => {
    expect(sessionChromeGoalPillLabel("paused", paused("max_auto_continuations").goal)).toBe(
      "Paused · cap",
    );
    expect(sessionChromeGoalPillLabel("paused", paused("limits").goal)).toBe("Paused · budget");
    expect(sessionChromeGoalPillLabel("paused", paused("user_pause").goal)).toBe(
      "Paused · manually",
    );
    expect(sessionChromeGoalPillLabel("paused", paused("api").goal)).toBe("Paused · manually");
    expect(sessionChromeGoalPillLabel("paused", paused("agent").goal)).toBe("Paused · agent");
    // Unknown/legacy reasons and missing records keep the bare label.
    expect(sessionChromeGoalPillLabel("paused", paused("something_else").goal)).toBe("Paused");
    expect(sessionChromeGoalPillLabel("paused", paused(null).goal)).toBe("Paused");
    expect(sessionChromeGoalPillLabel("paused", null)).toBe("Paused");
    expect(sessionChromeGoalPillLabel("pursuing", goal().goal)).toBe("Pursuing");
    expect(
      sessionChromeGoalPillExplanation("paused", paused("max_auto_continuations").goal),
    ).toContain("continuation cap");
    expect(sessionChromeGoalPillExplanation("paused", paused("limits").goal)).toContain("limits");
    expect(sessionChromeGoalPillExplanation("paused", paused("agent").goal)).toContain(
      "human decision",
    );
    expect(sessionChromeGoalPillExplanation("pursuing", goal().goal)).toBeNull();
  });

  test("explains idle backoff as the next goal check time", () => {
    const record = goal({
      continuation: {
        state: "scheduled",
        reason: "backoff_pending",
        wakeRevision: 2,
        observedRevision: 1,
        nextAttemptAt: "2026-08-22T14:05:00.000Z",
        lastError: null,
      },
    }).goal;
    expect(sessionChromeGoalPillLabel("scheduled", record)).toBe("Scheduled");
    expect(sessionChromeGoalPillExplanation("scheduled", record)).toBe(
      `Next goal check at ${formatClockTime("2026-08-22T14:05:00.000Z")}.`,
    );
  });

  test("explains an agent wait_for_input hold with its reason and deadline", () => {
    const record = goal({
      continuation: {
        state: "blocked",
        reason: "held_for_input",
        wakeRevision: 2,
        observedRevision: 1,
        nextAttemptAt: "2026-08-22T18:00:00.000Z",
        lastError: null,
        holdReason: "waiting for two child sessions to report",
      },
    }).goal;
    expect(sessionChromeGoalPillLabel("held", record)).toBe("Held");
    const explanation = sessionChromeGoalPillExplanation("held", record);
    expect(explanation).toContain("Waiting for input: waiting for two child sessions to report");
    expect(explanation).toContain(`until ${formatClockTime("2026-08-22T18:00:00.000Z")}`);
    // Older servers omit holdReason; the hold still explains itself.
    const legacy = goal({
      continuation: { ...record!.continuation!, holdReason: undefined },
    }).goal;
    expect(sessionChromeGoalPillExplanation("held", legacy)).toContain("Waiting for input until");
  });

  test("renders the pause reason on the chip and in the panel", async () => {
    mounted = await renderComponent(
      <SessionChrome
        queue={queue({ queue: [] })}
        composer={composer()}
        goal={paused("max_auto_continuations")}
      />,
    );
    const chip = mounted.container.querySelector<HTMLButtonElement>(
      '[data-og-session-chrome-signal="goal"]',
    );
    expect(chip?.textContent).toContain("Paused · cap");
    expect(chip?.getAttribute("title")).toContain("continuation cap");
    await act(async () => {
      chip?.click();
    });
    const panel = mounted.container.querySelector('[data-og-session-chrome-panel="goal"]');
    expect(panel?.textContent).toContain("Paused · cap");
    expect(
      panel?.querySelector("[data-og-session-chrome-goal-explanation]")?.textContent,
    ).toContain("New input");
  });
});
