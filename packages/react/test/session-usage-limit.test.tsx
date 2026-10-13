import { describe, expect, test } from "bun:test";
import {
  OpenGeniApiError,
  OpenGeniSessionUsageLimitReachedError,
  type SessionEvent,
} from "@opengeni/sdk";
import type { SessionUsageLimit } from "@opengeni/sdk/session-usage-limits";
import { act } from "react";

import { registerDom, renderComponent } from "./render-hook";
import {
  COMPOSER_SESSION_USAGE_LIMIT_MESSAGE,
  composerSubmissionCanRetry,
  composerSubmissionErrorMessage,
  isCreditExhaustion,
  isSessionUsageLimitSubmissionError,
} from "../src/lib/format";
import { buildTimeline, creditExhaustedFromEvents } from "../src/timeline/projection";
import {
  sessionUsageLimitPercent,
  summarizeSessionUsageLimit,
} from "../src/usage/session-usage-limit";
import {
  sessionChromeGoalPillExplanation,
  sessionChromeGoalPillLabel,
} from "../src/components/session-chrome";

registerDom();
const { SessionUsageLimitNotice } = await import("../src/usage");
const { MessageTimeline } = await import("../src/components/message-timeline");

const ROOT = "11111111-2222-4333-8444-555555555555";

function usage(overrides: Partial<SessionUsageLimit> = {}): SessionUsageLimit {
  return {
    basis: "model_api_equivalent_v1",
    rootSessionId: ROOT,
    inherited: false,
    status: "within",
    limitMicros: 50_000_000,
    usedMicros: 12_340_000,
    version: 3,
    usageRevision: 7,
    history: "complete",
    coverage: "complete",
    pricedCalls: 12,
    freeCalls: 0,
    unpricedCalls: 0,
    updatedAt: "2026-10-13T08:00:00Z",
    ...overrides,
  };
}

function event(sequence: number, type: string, payload: unknown): SessionEvent {
  return {
    id: `usage-limit-${sequence}`,
    workspaceId: "ws",
    sessionId: "session",
    turnId: "turn",
    sequence,
    type,
    payload,
    occurredAt: "2026-10-13T08:00:00Z",
  } as SessionEvent;
}

const stopPayload = {
  output: "",
  segmentLimit: "session_usage_limit",
  sessionUsageLimit: {
    code: "session_usage_limit_reached",
    basis: "model_api_equivalent_v1",
    rootSessionId: ROOT,
    limitMicros: 50_000_000,
    usedMicros: 52_100_000,
    message: "PRIVATE upstream wording: buy credits",
  },
};

describe("summarizeSessionUsageLimit", () => {
  test("known usage reads as used of limit, and overshoot stays in the text", () => {
    expect(summarizeSessionUsageLimit(usage())).toMatchObject({
      state: "within",
      amountText: "$12.34 of $50.00",
      partial: false,
      notes: [],
    });
    const over = summarizeSessionUsageLimit(usage({ status: "reached", usedMicros: 52_100_000 }));
    expect(over.state).toBe("reached");
    expect(over.amountText).toBe("$52.10 of $50.00");
    expect(over.barFraction).toBe(1);
    expect(over.fraction).toBeCloseTo(1.042);
  });

  test("80% is near; a zero limit is reached before any usage", () => {
    expect(summarizeSessionUsageLimit(usage({ usedMicros: 40_000_000 })).state).toBe("near");
    expect(sessionUsageLimitPercent(0.999)).toBe("99");
    expect(
      summarizeSessionUsageLimit(usage({ limitMicros: 0, usedMicros: 0, status: "reached" })).state,
    ).toBe("reached");
  });

  test("partial coverage says at least, with the reason", () => {
    const unpriced = summarizeSessionUsageLimit(usage({ coverage: "partial", unpricedCalls: 2 }));
    expect(unpriced.amountText).toBe("At least $12.34 of $50.00");
    expect(unpriced.notes.join(" ")).toContain("no known price");
    const legacy = summarizeSessionUsageLimit(
      usage({
        history: "legacy_partial",
        coverage: "partial",
        limitMicros: null,
        status: "unlimited",
      }),
    );
    expect(legacy.state).toBe("unlimited");
    expect(legacy.amountText).toBe("At least $12.34 used");
    expect(legacy.notes.join(" ")).toContain("started before usage limits");
  });

  test("unknown usage never renders as $0", () => {
    const preparing = summarizeSessionUsageLimit(
      usage({ status: "preparing", usedMicros: null, history: "preparing", coverage: "partial" }),
    );
    expect(preparing).toMatchObject({ state: "preparing", amountText: "Preparing usage" });
    const unavailable = summarizeSessionUsageLimit(
      usage({ status: "unavailable", usedMicros: null }),
    );
    expect(unavailable).toMatchObject({ state: "unavailable", amountText: "Usage unavailable" });
    for (const summary of [preparing, unavailable]) {
      expect(JSON.stringify(summary)).not.toContain("$0");
      expect(summary.usedMicros).toBeNull();
    }
    expect(summarizeSessionUsageLimit(undefined).state).toBe("unknown");
  });
});

describe("usage-limit stop in the timeline", () => {
  test("renders a neutral non-failure stop with the typed amounts only", () => {
    const completed = event(2, "turn.completed", stopPayload);
    const items = buildTimeline([
      event(1, "agent.message.completed", { messageId: "m", text: "Working" }),
      completed,
    ]);
    const notice = items.find((item) => item.kind === "notice");
    expect(notice).toMatchObject({
      kind: "notice",
      tone: "cancelled",
      sessionUsageLimit: { rootSessionId: ROOT, limitMicros: 50_000_000, usedMicros: 52_100_000 },
    });
    expect(items.find((item) => item.kind === "turn-end")).toMatchObject({
      outcome: "complete",
      failureText: null,
    });
    const serialized = JSON.stringify(items);
    expect(serialized).not.toMatch(/PRIVATE|buy credits|Add credits|monthly|resets/i);
    expect(creditExhaustedFromEvents([completed])).toBe(false);
    expect(isCreditExhaustion({ segmentLimit: "session_usage_limit" })).toBe(false);
  });

  test("a malformed marker is still the same neutral stop", () => {
    const items = buildTimeline([
      event(1, "turn.completed", { output: "", segmentLimit: "session_usage_limit" }),
    ]);
    expect(items.find((item) => item.kind === "notice")).toMatchObject({
      tone: "cancelled",
      sessionUsageLimit: { rootSessionId: null, limitMicros: null, usedMicros: null },
    });
  });

  test("unknown segment limits never fall back to credit exhaustion", () => {
    const completed = event(1, "turn.completed", { output: "", segmentLimit: "future_limit" });
    const items = buildTimeline([completed]);
    expect(JSON.stringify(items)).not.toMatch(/credit/i);
    expect(items.some((item) => item.kind === "notice" && item.tone === "failed")).toBe(false);
    expect(creditExhaustedFromEvents([completed])).toBe(false);
  });

  test("the timeline row is a calm status with no purchase remedy", async () => {
    const view = await renderComponent(
      <div style={{ height: 600 }}>
        <MessageTimeline events={[event(1, "turn.completed", stopPayload)]} />
      </div>,
    );
    const row = view.container.querySelector("[data-og-session-usage-limit-stop]");
    expect(row?.getAttribute("role")).toBe("status");
    expect(row?.textContent).toContain("Usage limit reached");
    expect(row?.textContent).toContain("$52.10 of $50.00 API-equivalent model usage.");
    expect(row?.textContent).not.toMatch(/credit|retry|monthly/i);
    expect(row?.className).not.toContain("failed");
    await view.unmount();
  });
});

describe("composer refusal", () => {
  const body = JSON.stringify({
    error: {
      code: "session_usage_limit_reached",
      message: "limit",
      details: {
        basis: "model_api_equivalent_v1",
        rootSessionId: ROOT,
        limitMicros: 50_000_000,
        usedMicros: 50_000_000,
      },
    },
  });

  test("is not retryable, not a credit refusal, and keeps the draft", () => {
    const error = new OpenGeniSessionUsageLimitReachedError(402, body);
    expect(isSessionUsageLimitSubmissionError(error)).toBe(true);
    expect(composerSubmissionCanRetry(error)).toBe(false);
    const message = composerSubmissionErrorMessage(error);
    expect(message).toBe(COMPOSER_SESSION_USAGE_LIMIT_MESSAGE);
    expect(message).toContain("Your message is saved.");
    expect(message).not.toMatch(/credit|payment|billing/i);
    // A refusal restored from storage after reload keeps its meaning.
    expect(composerSubmissionCanRetry(new Error(message))).toBe(false);
    // Ordinary payment refusals are unchanged.
    expect(
      composerSubmissionCanRetry(
        new OpenGeniApiError(402, JSON.stringify({ error: { code: "payment_required" } })),
      ),
    ).toBe(false);
    expect(composerSubmissionCanRetry(new Error("network down"))).toBe(true);
  });
});

describe("goal pause reason", () => {
  test("explains the task usage limit without credits wording", () => {
    const record = { status: "paused" as const, pausedReason: "session_usage_limit" as const };
    expect(sessionChromeGoalPillLabel("paused", record)).toBe("Paused · usage limit");
    const explanation = sessionChromeGoalPillExplanation("paused", record) ?? "";
    expect(explanation).toBe(
      "Paused at the task's usage limit. Raise or remove the limit, then resume.",
    );
  });
});

describe("SessionUsageLimitNotice", () => {
  test("renders nothing while comfortable, unlimited or unknown", async () => {
    for (const value of [usage(), usage({ limitMicros: null, status: "unlimited" }), null]) {
      const view = await renderComponent(<SessionUsageLimitNotice usage={value} />);
      expect(view.container.textContent).toBe("");
      await view.unmount();
    }
  });

  test("reached is a non-dismissible status with one Change limit action", async () => {
    const changes: number[] = [];
    const view = await renderComponent(
      <SessionUsageLimitNotice
        usage={usage({ status: "reached", usedMicros: 52_100_000 })}
        onChangeLimit={() => changes.push(1)}
        dismissStorageKey="ws"
      />,
    );
    const notice = view.container.querySelector('[data-og-session-usage-limit="reached"]');
    expect(notice?.getAttribute("role")).toBe("status");
    expect(notice?.textContent).toContain("Usage limit reached");
    expect(notice?.textContent).toContain("$52.10 of $50.00");
    expect(notice?.textContent).not.toMatch(/credit|retry|monthly|reset/i);
    const buttons = [...view.container.querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["Change limit"]);
    await act(async () => buttons[0]!.click());
    expect(changes).toEqual([1]);
    await view.unmount();
  });

  test("goal and read-only variants say what comes next", async () => {
    const goal = await renderComponent(
      <SessionUsageLimitNotice
        usage={usage({ status: "reached", usedMicros: 50_000_000 })}
        onChangeLimit={() => undefined}
        goalPaused
      />,
    );
    expect(goal.container.textContent).toContain("then resume the goal");
    await goal.unmount();
    const child = await renderComponent(
      <SessionUsageLimitNotice
        usage={usage({ status: "reached", usedMicros: 50_000_000, inherited: true })}
        mainTaskHref={`/workspaces/ws/sessions/${ROOT}`}
      />,
    );
    expect(child.container.querySelector("button")).toBeNull();
    expect(child.container.querySelector("a")?.textContent).toBe("Open main task");
    expect(child.container.textContent).toContain("Someone who can run the main task");
    await child.unmount();
  });

  test("a refused Send shows reached before the projection is re-read", async () => {
    const view = await renderComponent(
      <SessionUsageLimitNotice
        usage={usage()}
        refusal={{ rootSessionId: ROOT, limitMicros: 50_000_000, usedMicros: 50_010_000 }}
        onChangeLimit={() => undefined}
      />,
    );
    expect(view.container.textContent).toContain("$50.01 of $50.00");
    await view.unmount();
  });

  test("near is dismissible per limit version", async () => {
    sessionStorage.clear();
    const near = usage({ usedMicros: 42_000_000 });
    const first = await renderComponent(
      <SessionUsageLimitNotice usage={near} dismissStorageKey="ws" />,
    );
    expect(first.container.textContent).toContain("84% of its usage limit ($42.00 of $50.00)");
    const dismiss = first.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss"]',
    );
    await act(async () => dismiss!.click());
    expect(first.container.textContent).toBe("");
    await first.unmount();
    const same = await renderComponent(
      <SessionUsageLimitNotice usage={near} dismissStorageKey="ws" />,
    );
    expect(same.container.textContent).toBe("");
    await same.unmount();
    const changed = await renderComponent(
      <SessionUsageLimitNotice usage={{ ...near, version: 4 }} dismissStorageKey="ws" />,
    );
    expect(changed.container.textContent).toContain("84%");
    await changed.unmount();
  });
});
