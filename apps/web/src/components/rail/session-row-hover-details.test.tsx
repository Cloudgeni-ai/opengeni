import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SessionListEntry } from "@opengeni/sdk";
import { renderToStaticMarkup } from "react-dom/server";

import { formatAbsoluteTime } from "@/components/ui/relative-time";
import {
  formatWaitDuration,
  nextCheckLabel,
  sessionHoverDescription,
  sessionHoverFacts,
} from "@/lib/session-hover-facts";

import { SessionRowHoverDetails } from "./session-row-hover-details";

beforeAll(() => {
  GlobalRegistrator.register();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

const NOW = Date.parse("2026-10-09T14:00:00Z");
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const human = { kind: "subject", subjectId: "user:maja", label: "Maja Berg" } as const;

const activeControl: SessionListEntry["effectiveControl"] = {
  state: "active",
  controlVersion: 1,
  controlEtag: "etag",
  directState: "active",
  primaryBlocker: null,
  additionalBlockerCount: 0,
  blockers: [],
  resumeOptions: [],
  override: null,
  settlement: null,
};

function entry(overrides: Partial<SessionListEntry> = {}): SessionListEntry {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    workspaceId: "00000000-0000-4000-8000-0000000000aa",
    accountId: "00000000-0000-4000-8000-0000000000bb",
    status: "idle",
    title: "Astra strategy takeover",
    titleSource: "agent",
    displayTitle: "Astra strategy takeover",
    renameSeed: "Astra strategy takeover",
    scheduledTaskId: null,
    siteOrigin: null,
    createdBy: human,
    channelId: null,
    parentSessionId: null,
    rootSessionId: "00000000-0000-4000-8000-000000000001",
    effectiveControl: activeControl,
    lastSequence: 10,
    pinned: false,
    pinnedAt: null,
    pinVersion: 0,
    unread: false,
    activelyWorking: false,
    attentionVersion: 0,
    archived: false,
    archivedAt: null,
    archiveVersion: 0,
    createdAt: minutesAgo(180),
    updatedAt: minutesAgo(4),
    ...overrides,
  } as SessionListEntry;
}

function render(
  session: SessionListEntry,
  extra: { count?: number; truncated?: boolean; showCreator?: boolean } = {},
) {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    <SessionRowHoverDetails
      session={session}
      title={session.displayTitle}
      descendantCount={extra.count ?? session.treeStats?.totalDescendants ?? 0}
      descendantCountTruncated={extra.truncated ?? session.treeStats?.truncated ?? false}
      showCreator={extra.showCreator}
      now={NOW}
    />,
  );
  return host;
}

describe("SessionRowHoverDetails", () => {
  test("a working session shows its model, sub-agent states and background commands", () => {
    const host = render(
      entry({
        status: "running",
        model: "codex/gpt-6-astra",
        reasoningEffort: "max",
        backgroundCommandActivity: { state: "running", count: 2 },
        treeStats: {
          directChildren: 3,
          totalDescendants: 5,
          runningDescendants: 2,
          queuedDescendants: 0,
          attentionDescendants: 1,
          pausedDescendants: 1,
          failedDescendants: 2,
          unreadFailedDescendants: 1,
          truncated: false,
        },
      }),
    );
    const text = host.textContent ?? "";
    expect(text).toContain("Astra strategy takeover");
    expect(host.querySelector("[data-slot=status-badge]")?.textContent).toBe("Running");
    expect(text).toContain("GPT-6 Astra");
    expect(text).toContain("Max reasoning");
    expect(host.querySelector("[data-model-vendor=openai]")).not.toBeNull();
    expect(text).toContain("5 sub-agents · 1 needs you · 1 unread failure · 2 running · 1 paused");
    expect(text).toContain("2 background commands running");
    // Historical failures that were already reviewed and zero states stay out.
    expect(text).not.toContain("2 failed");
    expect(text).not.toContain("0 queued");
    expect(text).toContain("Maja Berg");
    expect(text).toContain("Updated 4 min ago");
    expect(text).toContain(
      `Created ${formatAbsoluteTime(minutesAgo(180), { now: NOW }).replace("Today", "today")}`,
    );
  });

  test("a session that needs you says for how long", () => {
    const text =
      render(entry({ status: "requires_action", requiresActionSince: minutesAgo(24) }))
        .textContent ?? "";
    expect(text).toContain("Needs you");
    expect(text).toContain("Waiting on you for 24 min");
  });

  test("an out-of-turn wait shows the agent's reason and the next check", () => {
    const deadlineAt = new Date(NOW + 30 * 60_000).toISOString();
    const host = render(
      entry({
        status: "idle",
        inputWait: { deadlineAt, reason: "Waiting for the staging deploy to finish" },
      }),
    );
    const text = host.textContent ?? "";
    expect(host.querySelector("[data-slot=status-badge]")?.textContent).toBe("Waiting");
    expect(text).toContain(nextCheckLabel(deadlineAt, NOW)!);
    expect(host.querySelector("[data-session-hover-reason]")?.textContent).toBe(
      "Waiting for the staging deploy to finish",
    );
  });

  test("a pause names whether it came from this session or its parent", () => {
    const parent = "00000000-0000-4000-8000-0000000000cc";
    const throughParent = render(
      entry({
        status: "idle",
        parentSessionId: parent,
        effectiveControl: {
          ...activeControl,
          state: "paused",
          primaryBlocker: {
            kind: "session",
            sessionId: parent,
            displayName: "Grocery Bot setup",
            actor: null,
            reason: "Holding until the API key is rotated",
            changedAt: minutesAgo(10),
            revision: 1,
          },
        },
      }),
    );
    expect(throughParent.querySelector("[data-slot=status-badge]")?.textContent).toBe("Paused");
    expect(throughParent.textContent).toContain("Paused through Grocery Bot setup");
    expect(throughParent.textContent).toContain("Holding until the API key is rotated");

    const direct = render(
      entry({ effectiveControl: { ...activeControl, state: "paused", directState: "paused" } }),
    );
    expect(direct.textContent).toContain("Paused directly");
  });

  test("a finished session hides empty and zero facts", () => {
    const host = render(
      entry({
        treeStats: {
          directChildren: 0,
          totalDescendants: 0,
          runningDescendants: 0,
          queuedDescendants: 0,
          attentionDescendants: 0,
          pausedDescendants: 0,
          failedDescendants: 0,
          truncated: false,
        },
      }),
    );
    const text = host.textContent ?? "";
    expect(host.querySelector("[data-slot=status-badge]")?.textContent).toBe("Idle");
    expect(text).not.toContain("sub-agent");
    expect(text).not.toContain("reasoning");
    expect(text).not.toMatch(/\b0\b/);
    expect(host.querySelector("[data-session-hover-activity]")).toBeNull();
    expect(host.querySelector("[data-session-hover-reason]")).toBeNull();
  });

  test("lower-bound counts keep their plus and creators hide in personal workspaces", () => {
    const host = render(
      entry({
        treeStats: {
          directChildren: 40,
          totalDescendants: 1000,
          runningDescendants: 3,
          queuedDescendants: 0,
          attentionDescendants: 1,
          pausedDescendants: 0,
          failedDescendants: 0,
          truncated: true,
        },
      }),
      { showCreator: false },
    );
    const text = host.textContent ?? "";
    expect(text).toContain("1,000+ sub-agents · 1+ need you · 3+ running");
    expect(text).not.toContain("Maja Berg");
  });

  test("schedule and Site origins appear when relevant", () => {
    expect(render(entry({ scheduledTaskId: "task-1" })).textContent).toContain(
      "Started by a schedule",
    );
    expect(render(entry({ hasSchedules: true })).textContent).toContain("On a schedule");
    expect(
      render(
        entry({
          siteOrigin: { siteId: "00000000-0000-4000-8000-0000000000dd", title: "Support portal" },
        }),
      ).textContent,
    ).toContain("Started from Support portal");
  });
});

describe("session hover facts", () => {
  test("wait durations read as durations", () => {
    expect(formatWaitDuration(minutesAgo(0.5), NOW)).toBe("<1 min");
    expect(formatWaitDuration(minutesAgo(24), NOW)).toBe("24 min");
    expect(formatWaitDuration(minutesAgo(60), NOW)).toBe("1 hour");
    expect(formatWaitDuration(minutesAgo(60 * 30), NOW)).toBe("30 hours");
    expect(formatWaitDuration(minutesAgo(60 * 24 * 3), NOW)).toBe("3 days");
    expect(formatWaitDuration("not a date", NOW)).toBeNull();
  });

  test("an elapsed recheck is due, not in the past", () => {
    expect(nextCheckLabel(minutesAgo(1), NOW)).toBe("Next check due now");
  });

  test("background commands and unavailable statuses", () => {
    const facts = (activity: SessionListEntry["backgroundCommandActivity"]) =>
      sessionHoverFacts(entry({ backgroundCommandActivity: activity }), {
        descendantCount: 0,
        descendantCountTruncated: false,
        now: NOW,
      }).commands;
    expect(facts({ state: "running", count: 1 })).toBe("1 background command running");
    expect(facts({ state: "stopping", count: 2 })).toBe("Stopping 2 background commands");
    // Unavailable statuses are never counted as running.
    expect(facts({ state: "running", count: 3, unavailableCount: 1 })).toBe(
      "2 background commands running · 1 command status unavailable",
    );
    expect(facts({ state: "running", count: 1, unavailableCount: 1 })).toBe(
      "1 command status unavailable",
    );
    expect(facts({ state: "stopping", count: 2, unavailableCount: 2 })).toBe(
      "Stop requested · 2 command statuses unavailable",
    );
  });

  test("needs-you and failed sessions keep their status while paused", () => {
    const facts = sessionHoverFacts(
      entry({
        status: "requires_action",
        requiresActionSince: minutesAgo(5),
        effectiveControl: { ...activeControl, state: "paused", directState: "paused" },
      }),
      { descendantCount: 0, descendantCountTruncated: false, now: NOW },
    );
    expect(facts.status.label).toBe("Needs you");
    expect(facts.context).toEqual(["Waiting on you for 5 min", "Paused directly"]);
  });

  test("a needs-you session keeps its status and says it is pausing", () => {
    const facts = sessionHoverFacts(
      entry({
        status: "requires_action",
        effectiveControl: {
          ...activeControl,
          state: "paused",
          directState: "paused",
          settlement: {
            state: "stopping",
            attemptCount: 1,
            interruptionPendingCount: 1,
            quiescencePendingCount: 0,
          },
        },
      }),
      { descendantCount: 0, descendantCountTruncated: false, now: NOW },
    );
    expect(facts.status.label).toBe("Needs you");
    expect(facts.context).toEqual(["Pausing"]);

    const settling = sessionHoverFacts(
      entry({
        status: "running",
        effectiveControl: {
          ...activeControl,
          state: "paused",
          settlement: {
            state: "stopping",
            attemptCount: 1,
            interruptionPendingCount: 1,
            quiescencePendingCount: 0,
          },
        },
      }),
      { descendantCount: 0, descendantCountTruncated: false, now: NOW },
    );
    expect(settling.status.label).toBe("Pausing");
    expect(settling.context).toEqual([]);
  });

  test("the accessible description carries what the card adds, without timestamps", () => {
    const facts = sessionHoverFacts(
      entry({
        status: "idle",
        inputWait: {
          deadlineAt: new Date(NOW + 30 * 60_000).toISOString(),
          reason: "Waiting for the deploy.",
        },
        model: "codex/gpt-6-astra",
        reasoningEffort: "max",
        backgroundCommandActivity: { state: "running", count: 1 },
      }),
      { descendantCount: 2, descendantCountTruncated: false, now: NOW },
    );
    expect(sessionHoverDescription(facts)).toBe(
      `${nextCheckLabel(new Date(NOW + 30 * 60_000).toISOString(), NOW)}. Waiting for the deploy. GPT-6 Astra, Max reasoning. 2 sub-agents. 1 background command running`,
    );
    expect(
      sessionHoverDescription(
        sessionHoverFacts(entry(), {
          descendantCount: 0,
          descendantCountTruncated: false,
          now: NOW,
        }),
      ),
    ).toBe("");
  });

  test("a cancelled session is never shown as paused", () => {
    const facts = sessionHoverFacts(
      entry({ status: "cancelled", effectiveControl: { ...activeControl, state: "paused" } }),
      { descendantCount: 0, descendantCountTruncated: false, now: NOW },
    );
    expect(facts.status.label).toBe("Cancelled");
    expect(facts.context).toEqual([]);
  });
});
