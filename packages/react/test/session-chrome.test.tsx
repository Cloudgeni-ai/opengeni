import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";

import { SessionChrome, sessionChromeGoalPillState } from "../src/components/session-chrome";
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
      fakeTurn({ id: "11111111-1111-4111-8111-111111111111", prompt: "first queued prompt" }),
      fakeTurn({ id: "22222222-2222-4222-8222-222222222222", prompt: "second queued prompt" }),
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

  test("expands queue and reveals hover actions wired to queue APIs", async () => {
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
          queue: [fakeTurn({ prompt: "Queued prompt that should wrap on a narrow rail" })],
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
