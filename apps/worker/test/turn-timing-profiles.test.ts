import { describe, expect, mock, test } from "bun:test";
import { testSettings } from "@opengeni/testing/settings";
import {
  TURN_TIMING_CATEGORIES,
  type RecordedTurnTimingProfile,
  type TurnTimingSegments,
} from "@opengeni/db";
import {
  MODEL_CALL_FACT_RECONCILE_LOOKBACK_MS,
  MODEL_CALL_FACT_RECONCILE_SETTLE_MS,
} from "../src/activities/model-call-fact-reconciler";
import {
  createTurnTimingProfileActivities,
  recordTurnTimingMetrics,
} from "../src/activities/turn-timing-profiles";
import type { ActivityServices } from "../src/activities/types";

const WORKSPACES = Array.from(
  { length: 450 },
  (_, index) => `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
);
const SETTINGS = testSettings();

type Metric = { kind: string; name: string; labels?: Record<string, string>; value: number };

function fakeObservability() {
  const metrics: Metric[] = [];
  const warn = mock((_message: string, _fields?: Record<string, unknown>) => undefined);
  const info = mock((_message: string, _fields?: Record<string, unknown>) => undefined);
  const observability = {
    info,
    warn,
    incrementCounter: (input: { name: string; labels?: Record<string, string>; amount?: number }) =>
      metrics.push({
        kind: "counter",
        name: input.name,
        labels: input.labels,
        value: input.amount ?? 1,
      }),
    observeHistogram: (input: { name: string; labels?: Record<string, string>; value: number }) =>
      metrics.push({
        kind: "histogram",
        name: input.name,
        labels: input.labels,
        value: input.value,
      }),
  };
  return { observability, metrics, warn, info };
}

function services(observability: unknown) {
  return async () =>
    ({ db: {} as never, observability, settings: SETTINGS }) as unknown as ActivityServices;
}

const listWorkspaces = async (_db: unknown, input: { afterId: string | null; limit: number }) =>
  WORKSPACES.filter((id) => input.afterId === null || id > input.afterId).slice(0, input.limit);

function segments(values: Partial<TurnTimingSegments>): TurnTimingSegments {
  return Object.fromEntries(
    TURN_TIMING_CATEGORIES.map((category) => [category, values[category] ?? 0]),
  ) as TurnTimingSegments;
}

function recorded(
  workspaceId: string,
  inserted: boolean,
  turn: Partial<RecordedTurnTimingProfile["turn"]> = {},
): RecordedTurnTimingProfile {
  return {
    inserted,
    turn: {
      id: `turn-${workspaceId}`,
      accountId: "account",
      sessionId: "session",
      status: "completed",
      model: "not-a-configured-model",
      reasoningEffort: "high",
      latencyMode: "standard",
      surface: null,
      source: "user",
      createdAt: new Date(0),
      startedAt: new Date(0),
      finishedAt: new Date(4_000),
      ...turn,
    },
    profile: {
      version: 1,
      wallMs: 4_000,
      segments: segments({ queue: 500, model_inference: 3_000, mcp_tool: 500 }),
      provider: null,
      attempts: 1,
      modelRequests: 1,
      toolCalls: 1,
      steps: [],
    },
  };
}

describe("turn timing profile sweep", () => {
  test("visits every workspace once from a random start, over the settled lookback window", async () => {
    const { observability, metrics, warn } = fakeObservability();
    const nowMs = Date.parse("2026-11-09T12:00:00.000Z");
    const windows = new Map<string, { since: Date; until: Date }>();
    const activity = createTurnTimingProfileActivities(services(observability), {
      now: () => nowMs,
      startAfterWorkspaceId: () => WORKSPACES[300]!,
      listWorkspaces: listWorkspaces as never,
      record: async (_db, input) => {
        windows.set(input.workspaceId, { since: input.since, until: input.until });
        // Only new profiles feed the metrics; a recomputed one is not counted twice.
        input.onRecorded?.(recorded(input.workspaceId, true));
        input.onRecorded?.(recorded(input.workspaceId, false));
        return { turns: 2, inserted: 1, updated: 1, failed: 0 };
      },
    });
    const result = await activity.recordRecentTurnTimingProfiles();
    expect(result).toEqual({
      workspaces: WORKSPACES.length,
      turns: 2 * WORKSPACES.length,
      inserted: WORKSPACES.length,
      updated: WORKSPACES.length,
      failedTurns: 0,
      failedWorkspaces: 0,
      budgetExhausted: false,
    });
    expect(windows.size).toBe(WORKSPACES.length);
    const until = nowMs - MODEL_CALL_FACT_RECONCILE_SETTLE_MS;
    expect(windows.get(WORKSPACES[0]!)).toEqual({
      since: new Date(until - MODEL_CALL_FACT_RECONCILE_LOOKBACK_MS),
      until: new Date(until),
    });
    expect(metrics.filter((metric) => metric.kind === "histogram")).toHaveLength(WORKSPACES.length);
    expect(warn).not.toHaveBeenCalled();
  });

  test("a failing workspace or turn never stops the rest", async () => {
    const { observability, metrics, warn } = fakeObservability();
    const visited: string[] = [];
    const activity = createTurnTimingProfileActivities(services(observability), {
      startAfterWorkspaceId: () => WORKSPACES[0]!,
      listWorkspaces: listWorkspaces as never,
      record: async (_db, input) => {
        visited.push(input.workspaceId);
        if (input.workspaceId === WORKSPACES[5]) throw new Error("database unavailable");
        if (input.workspaceId === WORKSPACES[6]) {
          input.onError?.(new TypeError("malformed history"), "turn-a");
          return { turns: 1, inserted: 0, updated: 0, failed: 1 };
        }
        return { turns: 0, inserted: 0, updated: 0, failed: 0 };
      },
    });
    const result = await activity.recordRecentTurnTimingProfiles();
    expect(visited).toHaveLength(WORKSPACES.length);
    expect(result).toMatchObject({ failedWorkspaces: 1, failedTurns: 1, budgetExhausted: false });
    expect(metrics).toContainEqual({
      kind: "counter",
      name: "opengeni_turn_timing_profile_failures_total",
      labels: undefined,
      value: 1,
    });
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      "turn timing profiles failed for a workspace",
      "turn timing profile failed for a turn",
      "turn timing profiles incomplete",
    ]);
  });

  test("stops at the run budget and leaves the rest to later runs", async () => {
    const { observability } = fakeObservability();
    const visited: string[] = [];
    const activity = createTurnTimingProfileActivities(services(observability), {
      runBudgetMs: 40,
      startAfterWorkspaceId: () => WORKSPACES[0]!,
      listWorkspaces: listWorkspaces as never,
      record: async (_db, input) => {
        visited.push(input.workspaceId);
        await new Promise<void>((resolve) =>
          input.signal!.addEventListener("abort", () => resolve(), { once: true }),
        );
        input.signal!.throwIfAborted();
        throw new Error("unreachable");
      },
    });
    const result = await activity.recordRecentTurnTimingProfiles();
    expect(visited).toHaveLength(1);
    expect(result).toMatchObject({ budgetExhausted: true, failedWorkspaces: 0 });
  });

  test("caller cancellation propagates", async () => {
    const { observability } = fakeObservability();
    const abort = new AbortController();
    abort.abort(new Error("activity cancelled"));
    const activity = createTurnTimingProfileActivities(services(observability), {
      signal: abort.signal,
      listWorkspaces: listWorkspaces as never,
      record: async () => ({ turns: 0, inserted: 0, updated: 0, failed: 0 }),
    });
    await expect(activity.recordRecentTurnTimingProfiles()).rejects.toThrow("activity cancelled");
  });

  test("metrics carry seconds per category with closed labels", () => {
    const { observability, metrics } = fakeObservability();
    recordTurnTimingMetrics(
      observability as never,
      SETTINGS,
      recorded("w", true, { status: "made-up", reasoningEffort: "extreme" }),
    );
    expect(metrics).toEqual([
      {
        kind: "counter",
        name: "opengeni_turn_timing_seconds_total",
        labels: { category: "queue", status: "other", model: "custom", reasoning_effort: "other" },
        value: 0.5,
      },
      {
        kind: "counter",
        name: "opengeni_turn_timing_seconds_total",
        labels: {
          category: "model_inference",
          status: "other",
          model: "custom",
          reasoning_effort: "other",
        },
        value: 3,
      },
      {
        kind: "counter",
        name: "opengeni_turn_timing_seconds_total",
        labels: {
          category: "mcp_tool",
          status: "other",
          model: "custom",
          reasoning_effort: "other",
        },
        value: 0.5,
      },
      {
        kind: "histogram",
        name: "opengeni_turn_wall_seconds",
        labels: { status: "other", model: "custom" },
        value: 4,
      },
    ]);
  });
});
