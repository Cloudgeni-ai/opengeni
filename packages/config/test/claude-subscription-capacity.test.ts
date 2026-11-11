import { expect, test } from "bun:test";
import type { ClaudeUsageWindow } from "@opengeni/contracts";
import {
  emptyClaudeUsage,
  mergeClaudeUsage,
  parseClaudeUsageHeaders,
  parseClaudeUsageResponse,
} from "../src/claude-subscription-usage";
import { claudeSubscriptionCapacity } from "../src/claude-subscription-capacity";

const now = new Date("2030-01-01T00:00:00Z");
const hour = "2030-01-01T01:00:00Z";
const week = "2030-01-07T00:00:00Z";
function response(model: string, status: string, time: Date, paid?: string) {
  return parseClaudeUsageHeaders(
    new Headers({
      "anthropic-ratelimit-unified-status": status,
      "anthropic-ratelimit-unified-reset": String(Date.parse(hour) / 1000),
      ...(paid ? { "anthropic-ratelimit-unified-overage-status": paid } : {}),
    }),
    time,
    model,
  )!;
}

test("unknown-claim Opus denials survive later Sonnet success and reordered receipts", () => {
  const opus = "claude-opus-5-5";
  const sonnet = "claude-sonnet-5-5";
  const denial = response(opus, "rejected", now);
  let snapshot = mergeClaudeUsage(emptyClaudeUsage(1), denial);
  snapshot = mergeClaudeUsage(snapshot, response(sonnet, "allowed", new Date(now.getTime() + 1)));
  expect(claudeSubscriptionCapacity(snapshot, opus, now).available).toBe(false);
  expect(claudeSubscriptionCapacity(snapshot, sonnet, now).available).toBe(true);
  snapshot = mergeClaudeUsage(snapshot, response(opus, "allowed", new Date(now.getTime() + 2)));
  snapshot = mergeClaudeUsage(snapshot, response(sonnet, "allowed", new Date(now.getTime() + 3)));
  snapshot = mergeClaudeUsage(snapshot, denial);
  expect(claudeSubscriptionCapacity(snapshot, opus, now).available).toBe(true);
});

test("conflicting simultaneous receipts cannot restore paid fallback in either arrival order", () => {
  const model = "claude-opus-5-5";
  const denial = response(model, "rejected", now);
  const paid = response(model, "rejected", now, "allowed");
  const allowed = response(model, "allowed", now);
  for (const pair of [
    [denial, paid],
    [paid, denial],
    [allowed, denial],
    [denial, allowed],
  ]) {
    const snapshot = pair.reduce(
      (state, item) => mergeClaudeUsage(state, item!),
      emptyClaudeUsage(1),
    );
    expect(claudeSubscriptionCapacity(snapshot, model, now).available).toBe(false);
    expect(snapshot.requestStatus?.overageStatus).toBeNull();
  }
});

test("a newer exact-model allowance clears retained named-window denial across other models and replay", () => {
  const denied = response("claude-opus-5-5", "rejected", now);
  denied.windows = [window("seven_day_opus", week, { status: "rejected" })];
  for (const replay of [false, true]) {
    let snapshot = mergeClaudeUsage(emptyClaudeUsage(1), denied);
    snapshot = mergeClaudeUsage(
      snapshot,
      response("claude-opus-5-5", "allowed", new Date(now.getTime() + 1)),
    );
    snapshot = mergeClaudeUsage(
      snapshot,
      response("claude-sonnet-5-5", "allowed", new Date(now.getTime() + 2)),
    );
    if (replay) snapshot = mergeClaudeUsage(snapshot, denied);
    expect(claudeSubscriptionCapacity(snapshot, "claude-opus-5-5", now).available).toBe(true);
  }
});

test("legacy model-claim allowances cannot erase an account-wide rejection", () => {
  const denied = response("claude-opus-5-5", "rejected", now);
  denied.requestStatus!.upstreamModelId = null;
  const allowed = response("claude-sonnet-5-5", "allowed", new Date(now.getTime() + 1));
  allowed.requestStatus!.upstreamModelId = null;
  allowed.requestStatus!.representativeClaim = "seven_day_sonnet";
  const snapshot = mergeClaudeUsage(mergeClaudeUsage(emptyClaudeUsage(1), denied), allowed);
  expect(claudeSubscriptionCapacity(snapshot, "claude-opus-5-5", now).available).toBe(false);
});

test("simultaneous denials preserve the latest reset independently of arrival order", () => {
  const first = response("claude-opus-5-5", "rejected", now);
  first.requestStatus!.resetsAt = week;
  first.windows = [window("five_hour", week, { status: "rejected" })];
  const second = response("claude-opus-5-5", "rejected", now);
  second.windows = [window("five_hour", hour, { status: "rejected" })];
  for (const receipts of [
    [first, second],
    [second, first],
  ]) {
    const snapshot = receipts.reduce(
      (state, item) => mergeClaudeUsage(state, item!),
      emptyClaudeUsage(1),
    );
    expect(claudeSubscriptionCapacity(snapshot, "claude-opus-5-5", new Date(hour))).toMatchObject({
      available: false,
      nextCheckAt: new Date(week),
    });
  }
});

test("a direct quota refresh supersedes an older rejection for the exact reported window", () => {
  const denied = response("claude-opus-5-5", "rejected", now);
  denied.requestStatus!.representativeClaim = "five_hour";
  denied.windows = [window("five_hour", hour, { status: "rejected" })];
  const newer = parseClaudeUsageResponse(
    { five_hour: { utilization: 20, resets_at: hour } },
    new Date(now.getTime() + 1),
  )!;
  const snapshot = mergeClaudeUsage(mergeClaudeUsage(emptyClaudeUsage(1), denied), newer);
  expect(claudeSubscriptionCapacity(snapshot, "claude-opus-5-5", now).available).toBe(true);
});

test("missing or exhausted direct quota cannot clear an exact-model restriction", () => {
  const denied = response("claude-opus-5-5", "rejected", now);
  denied.requestStatus!.representativeClaim = "five_hour";
  const directTime = new Date(now.getTime() + 1);
  for (const utilization of [null, 100]) {
    const direct = parseClaudeUsageResponse(
      { five_hour: { utilization, resets_at: hour } },
      directTime,
    )!;
    const allowed = response("claude-sonnet-5-5", "allowed", new Date(now.getTime() + 2));
    allowed.windows = [
      window("five_hour", hour, {
        usedPercent: 20,
        status: "allowed",
        observedAt: allowed.observedAt,
      }),
    ];
    for (const receipts of [
      [denied, direct, allowed],
      [direct, allowed, denied],
    ]) {
      const snapshot = receipts.reduce(
        (state, item) => mergeClaudeUsage(state, item),
        emptyClaudeUsage(1),
      );
      expect(claudeSubscriptionCapacity(snapshot, "claude-opus-5-5", now).available).toBe(false);
    }
  }
});

test("an explicit global dispatch rejection applies even when its claim is extra usage", () => {
  const denied = response("claude-opus-5-5", "rejected", now);
  denied.requestStatus!.upstreamModelId = null;
  denied.requestStatus!.representativeClaim = "overage";
  const snapshot = mergeClaudeUsage(emptyClaudeUsage(1), denied);
  expect(claudeSubscriptionCapacity(snapshot, "claude-opus-5-5", now).available).toBe(false);
});

test("a large all-allowed model ledger cannot manufacture an account-wide rejection", () => {
  let snapshot = emptyClaudeUsage(1);
  for (let index = 0; index < 65; index++)
    snapshot = mergeClaudeUsage(
      snapshot,
      response(`claude-fixture-${index}`, "allowed", new Date(now.getTime() + index)),
    );
  expect(snapshot.requestRestrictions!.length).toBeLessThanOrEqual(64);
  expect(snapshot.requestRestrictions!.every((item) => item.status !== "rejected")).toBe(true);
  expect(claudeSubscriptionCapacity(snapshot, "claude-opus-5-5", now).available).toBe(true);
});
test("expired denial watermarks cannot manufacture a fresh rejection during overflow", () => {
  let snapshot = mergeClaudeUsage(
    emptyClaudeUsage(1),
    response("claude-opus-5-5", "rejected", now),
  );
  const later = new Date("2030-01-02T00:00:00Z");
  for (let index = 0; index < 64; index++)
    snapshot = mergeClaudeUsage(
      snapshot,
      response(`claude-fixture-${index}`, "allowed", new Date(later.getTime() + index)),
    );
  expect(snapshot.requestRestrictions!.length).toBeLessThanOrEqual(64);
  expect(claudeSubscriptionCapacity(snapshot, "claude-opus-5-5", later).available).toBe(true);
  expect(claudeSubscriptionCapacity(snapshot, "claude-fixture-unknown", later).available).toBe(
    true,
  );
});

function usage(windows: ClaudeUsageWindow[] = []) {
  return { ...emptyClaudeUsage(1), windows };
}
function window(
  id: ClaudeUsageWindow["id"],
  resetsAt: string | null = hour,
  extra: Partial<ClaudeUsageWindow> = {},
): ClaudeUsageWindow {
  return { id, usedPercent: 100, status: null, resetsAt, observedAt: now.toISOString(), ...extra };
}

test("unknown quota is usable; disconnected and revoked credentials are not", () => {
  expect(claudeSubscriptionCapacity(usage(), "claude-opus-5-5", now).available).toBe(true);
  expect(claudeSubscriptionCapacity(emptyClaudeUsage(null), "claude-opus-5-5", now).available).toBe(
    false,
  );
  expect(
    claudeSubscriptionCapacity({ ...usage(), refreshStatus: "reconnect" }, "claude-opus-5-5", now)
      .available,
  ).toBe(false);
});

test("another model's shared-window success cannot clear an exact model restriction", () => {
  const denied = response("claude-opus-5-5", "rejected", now);
  denied.requestStatus!.representativeClaim = "five_hour";
  denied.windows = [window("five_hour", hour, { status: "rejected" })];
  const allowed = response("claude-sonnet-5-5", "allowed", new Date(now.getTime() + 1));
  allowed.requestStatus!.representativeClaim = "five_hour";
  allowed.windows = [
    window("five_hour", hour, { status: "allowed", observedAt: allowed.observedAt }),
  ];
  const snapshot = mergeClaudeUsage(mergeClaudeUsage(emptyClaudeUsage(1), denied), allowed);
  expect(claudeSubscriptionCapacity(snapshot, "claude-opus-5-5", now).available).toBe(false);
  expect(claudeSubscriptionCapacity(snapshot, "claude-sonnet-5-5", now).available).toBe(true);
});

test("direct refresh clearance survives newer header display readings, replay and equal-time receipts", () => {
  const denied = response("claude-opus-5-5", "rejected", now);
  denied.requestStatus!.representativeClaim = "five_hour";
  denied.windows = [window("five_hour", hour, { status: "rejected" })];
  const directTime = new Date(now.getTime() + 1);
  const direct = parseClaudeUsageResponse(
    { five_hour: { utilization: 20, resets_at: hour } },
    directTime,
  )!;
  for (const offset of [1, 2]) {
    const header = response("claude-sonnet-5-5", "allowed", new Date(now.getTime() + offset));
    header.requestStatus!.representativeClaim = "five_hour";
    header.windows = [
      window("five_hour", hour, {
        status: "allowed",
        usedPercent: 20,
        observedAt: header.observedAt,
      }),
    ];
    for (const receipts of [
      [denied, direct, header],
      [denied, header, direct],
      [direct, denied, header],
      [direct, header, denied],
      [header, denied, direct],
      [header, direct, denied],
    ]) {
      let snapshot = receipts.reduce(
        (state, item) => mergeClaudeUsage(state, item!),
        emptyClaudeUsage(1),
      );
      snapshot = mergeClaudeUsage(snapshot, denied);
      expect(claudeSubscriptionCapacity(snapshot, "claude-opus-5-5", now).available).toBe(true);
      const roundTrip = mergeClaudeUsage(mergeClaudeUsage(emptyClaudeUsage(1), denied), {
        windows: snapshot.windows,
        observedAt: snapshot.observedAt!,
        source: snapshot.source!,
        requestStatus: snapshot.requestStatus ?? null,
        requestRestrictions: snapshot.requestRestrictions ?? [],
      });
      expect(claudeSubscriptionCapacity(roundTrip, "claude-opus-5-5", now).available).toBe(true);
    }
  }
});

test("named-window rejections without reset permit a bounded authoritative probe", () => {
  const denied = response("claude-opus-5-5", "rejected", now);
  denied.requestStatus!.resetsAt = null;
  denied.requestStatus!.representativeClaim = "five_hour";
  denied.windows = [window("five_hour", null, { status: "rejected" })];
  const snapshot = mergeClaudeUsage(emptyClaudeUsage(1), denied);
  expect(claudeSubscriptionCapacity(snapshot, "claude-opus-5-5", now).available).toBe(false);
  expect(
    claudeSubscriptionCapacity(snapshot, "claude-opus-5-5", new Date(now.getTime() + 60_000))
      .available,
  ).toBe(true);
});

test("conflicting utilization receipts at the same time stay conservative in either order", () => {
  const denied = response("claude-opus-5-5", "rejected", now);
  denied.requestStatus!.representativeClaim = "five_hour";
  const at = new Date(now.getTime() + 1);
  const direct = parseClaudeUsageResponse({ five_hour: { utilization: 20, resets_at: hour } }, at)!;
  const header = response("claude-sonnet-5-5", "allowed", at);
  header.windows = [window("five_hour", hour, { status: "allowed", observedAt: at.toISOString() })];
  for (const receipts of [
    [direct, header],
    [header, direct],
  ]) {
    const snapshot = receipts.reduce(
      (state, item) => mergeClaudeUsage(state, item!),
      mergeClaudeUsage(emptyClaudeUsage(1), denied),
    );
    expect(claudeSubscriptionCapacity(snapshot, "claude-opus-5-5", now).available).toBe(false);
    expect(snapshot.windows[0]!.source).toBe("response_headers");
  }
});

test("one account waits for all applicable limits, not just its first reset", () => {
  const result = claudeSubscriptionCapacity(
    usage([window("five_hour"), window("seven_day", week)]),
    "claude-opus-5-5",
    now,
  );
  expect(result.blockingWindows).toEqual(["five_hour", "seven_day"]);
  expect(result.nextCheckAt?.toISOString()).toBe(new Date(week).toISOString());
  expect(result.available).toBe(false);
});

test("model-specific limits do not disable another Claude model family", () => {
  const snapshot = usage([window("seven_day_opus")]);
  expect(claudeSubscriptionCapacity(snapshot, "claude-opus-5-5", now).available).toBe(false);
  for (const model of ["claude-sonnet-5-5", "claude-haiku-4-5-20251001"])
    expect(claudeSubscriptionCapacity(snapshot, model, now).available).toBe(true);
});

test("elapsed resets override stale exhausted percentages and rejection statuses", () => {
  for (const status of [null, "rejected"] as const) {
    const result = claudeSubscriptionCapacity(
      usage([window("five_hour", now.toISOString(), { status })]),
      "claude-opus-5-5",
      now,
    );
    expect(result.available).toBe(true);
    expect(result.nextCheckAt).toBeNull();
  }
});

test("provider allowed/warning statuses remain authoritative even at full utilization", () => {
  for (const status of ["allowed", "allowed_warning"] as const)
    expect(
      claudeSubscriptionCapacity(
        usage([window("five_hour", hour, { status })]),
        "claude-opus-5-5",
        now,
      ).available,
    ).toBe(true);
  expect(
    claudeSubscriptionCapacity(
      usage([window("five_hour", hour, { status: "rejected", usedPercent: null })]),
      "claude-opus-5-5",
      now,
    ).available,
  ).toBe(false);
});

test("a missing reset schedules a bounded recheck and never invents a provider reset", () => {
  expect(
    claudeSubscriptionCapacity(
      usage([window("five_hour", null)]),
      "claude-opus-5-5",
      now,
    ).nextCheckAt?.toISOString(),
  ).toBe("2030-01-01T00:01:00.000Z");
});

test("unused or exhausted extra-usage balances do not block the base subscription", () => {
  for (const id of ["overage", "seven_day_overage_included"] as const) {
    expect(claudeSubscriptionCapacity(usage([window(id)]), "claude-opus-5-5", now).available).toBe(
      true,
    );
    expect(
      claudeSubscriptionCapacity(
        usage([window(id, hour, { status: "rejected" })]),
        "claude-opus-5-5",
        now,
      ).available,
    ).toBe(true);
  }
});

function dispatch(extra: Partial<NonNullable<ReturnType<typeof usage>["requestStatus"]>> = {}) {
  return {
    status: "rejected" as const,
    resetsAt: hour,
    representativeClaim: "five_hour" as const,
    overageStatus: null,
    overageResetsAt: null,
    upstreamModelId: "claude-opus-5-5",
    observedAt: now.toISOString(),
    ...extra,
  };
}

test("a rejected extra-usage balance never blocks an available base plan", () => {
  const snapshot = {
    ...usage([window("five_hour", hour, { usedPercent: 20, status: "allowed" })]),
    requestStatus: dispatch({
      status: "allowed",
      overageStatus: "rejected",
      overageResetsAt: week,
    }),
  };
  expect(claudeSubscriptionCapacity(snapshot, "claude-opus-5-5", now).available).toBe(true);
});

test("fresh authoritative paid fallback permits a blocked plan, but an opt-out does not", () => {
  for (const overageStatus of ["allowed", "allowed_warning"] as const) {
    const snapshot = {
      ...usage([window("five_hour")]),
      requestStatus: dispatch({ overageStatus, overageResetsAt: week }),
    };
    expect(claudeSubscriptionCapacity(snapshot, "claude-opus-5-5", now).available).toBe(true);
    expect(
      claudeSubscriptionCapacity(snapshot, "claude-opus-5-5", now, { allowOverage: false })
        .available,
    ).toBe(false);
  }
});

test("base-plan reset before a rejected monthly overage reset restores plan capacity", () => {
  const snapshot = {
    ...usage([window("five_hour")]),
    requestStatus: dispatch({ overageStatus: "rejected", overageResetsAt: week }),
  };
  expect(
    claudeSubscriptionCapacity(snapshot, "claude-opus-5-5", now).nextCheckAt?.toISOString(),
  ).toBe(new Date(hour).toISOString());
  expect(claudeSubscriptionCapacity(snapshot, "claude-opus-5-5", new Date(hour)).available).toBe(
    true,
  );
});

test("a Sonnet allowed response never overrides the retained Opus rejection", () => {
  const snapshot = {
    ...usage([window("seven_day_opus", week, { status: "rejected" })]),
    requestStatus: dispatch({
      status: "allowed",
      upstreamModelId: "claude-sonnet-5-5",
      representativeClaim: "seven_day_sonnet",
    }),
  };
  expect(claudeSubscriptionCapacity(snapshot, "claude-opus-5-5", now).available).toBe(false);
  expect(claudeSubscriptionCapacity(snapshot, "claude-sonnet-5-5", now).available).toBe(true);
});

test("newer per-window data cannot be overridden by older paid fallback status", () => {
  const snapshot = {
    ...usage([window("five_hour", hour, { observedAt: "2030-01-01T00:00:01.000Z" })]),
    requestStatus: dispatch({ overageStatus: "allowed" }),
  };
  expect(claudeSubscriptionCapacity(snapshot, "claude-opus-5-5", now).available).toBe(false);
});

test("a rejected unified status blocks even when no representative window is understood", () => {
  const snapshot = {
    ...usage(),
    requestStatus: dispatch({ representativeClaim: null, resetsAt: null }),
  };
  expect(claudeSubscriptionCapacity(snapshot, "claude-opus-5-5", now)).toMatchObject({
    available: false,
    nextCheckAt: new Date(now.getTime() + 60_000),
  });
  expect(
    claudeSubscriptionCapacity(snapshot, "claude-opus-5-5", new Date(now.getTime() + 60_000))
      .available,
  ).toBe(true);
});
