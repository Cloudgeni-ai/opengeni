import { describe, expect, test } from "bun:test";

import { createTurnFailureJourney, turnFailureClass } from "./turn-failure-analytics";

const base = { reason: null, failedAt: null, consecutiveRecoveryCount: null };

describe("turn failure class", () => {
  test("derives closed classes from codes and markers, never text", () => {
    expect(turnFailureClass({ ...base, reason: "boom" }, true)).toBe("credits_exhausted");
    expect(turnFailureClass({ ...base, structuralSandboxFailure: true }, true)).toBe("sandbox");
    expect(turnFailureClass({ ...base, safetyRefusal: true })).toBe("safety_refusal");
    expect(turnFailureClass({ ...base, failureCode: "codex_plan_entitlement" })).toBe(
      "codex_account",
    );
    expect(turnFailureClass({ ...base, reason: "401 Incorrect API key provided" })).toBe(
      "provider_credentials",
    );
    expect(turnFailureClass({ ...base, failureCode: "provider_rate_limited", reason: "x" })).toBe(
      "rate_limited",
    );
    expect(turnFailureClass({ ...base, quotaScope: "daily" })).toBe("daily_limit");
    expect(turnFailureClass({ ...base, reason: "The model `gpt-x` does not exist" })).toBe(
      "model_unavailable",
    );
    expect(turnFailureClass({ ...base, failureCode: "mcp_transport_timeout" })).toBe("mcp");
    expect(turnFailureClass({ ...base, failureCode: "context_compaction_failed" })).toBe(
      "context_limit",
    );
    expect(turnFailureClass({ ...base, reason: "something odd" })).toBe("other");
    expect(
      turnFailureClass({
        ...base,
        failureCode: "provider_billing_error",
        reason: "synthetic billing refusal",
      }),
    ).toBe("provider_billing");
    expect(
      turnFailureClass({
        ...base,
        failureCode: "pre_claim_failure",
        reason: "getaddrinfo ENOTFOUND database.example.test",
      }),
    ).toBe("pre_start");
  });
});

function harness() {
  const events: Array<[string, Record<string, string>]> = [];
  const timers: Array<() => void> = [];
  const journey = createTurnFailureJourney({
    capture: (name, properties) => events.push([name, properties]),
    setTimer: (run) => {
      timers.push(run);
      return run;
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer as () => void);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  const flush = () => {
    for (const run of timers.splice(0)) run();
  };
  return { events, journey, flush };
}

describe("turn failure journey", () => {
  test("reports the view once and only the first action", () => {
    const { events, journey } = harness();
    journey.viewed("f1", "rate_limited");
    journey.viewed("f1", "rate_limited");
    journey.action("retry");
    journey.action("switch_model");
    expect(events).toEqual([
      ["turn_failure_viewed", { failure_class: "rate_limited" }],
      ["turn_failure_action", { failure_class: "rate_limited", action: "retry" }],
    ]);
  });

  test("a remount is not leaving; dismissal or a long hidden tab is", () => {
    const { events, journey, flush } = harness();
    journey.viewed("f1", "other");
    journey.dismissed("f1");
    journey.viewed("f1", "other");
    flush();
    expect(events.map(([, properties]) => properties.action)).toEqual([undefined]);
    journey.dismissed("f1");
    flush();
    expect(events.at(-1)).toEqual([
      "turn_failure_action",
      { failure_class: "other", action: "left" },
    ]);
    journey.viewed("f2", "sandbox");
    journey.visibilityChanged(true);
    flush();
    expect(events.at(-1)?.[1].action).toBe("left");
  });
});
