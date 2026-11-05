import { describe, expect, test } from "bun:test";
import type { EnrollmentRecord } from "@opengeni/db";
import {
  agentUpdateBrowserClosingNotice,
  automaticAgentUpdateDue,
  browserClosingUpdateAt,
  browserUpdateDecision,
  retryableAgentUpdateBackoffMs,
  withBrowserClosingNotice,
} from "../src/sandbox/agent-update";

const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function machine(
  agentVersion: string | null,
  update: Partial<NonNullable<EnrollmentRecord["agentUpdate"]>> | null = null,
  overrides: Partial<EnrollmentRecord> = {},
): EnrollmentRecord {
  return {
    os: "linux",
    connectionInstanceId: "current",
    connectionGeneration: 3,
    agentVersion,
    agentUpdate: update
      ? {
          operationId: "00000000-0000-4000-8000-000000000001",
          status: "failed",
          targetVersion: "0.1.60",
          expectedBinarySha256: null,
          errorCode: null,
          retryable: false,
          rolledBack: false,
          connectionInstanceId: "current",
          connectionGeneration: 3,
          requestedAt: minutesAgo(120),
          updatedAt: minutesAgo(1),
          completedAt: null,
          ...update,
        }
      : null,
    ...overrides,
  } as EnrollmentRecord;
}

describe("automatic agent updates", () => {
  test("an outdated live machine with no update history is asked to update", () => {
    expect(automaticAgentUpdateDue(machine("0.1.55"), "0.1.60", NOW)).toBe(true);
  });

  test("current, ahead, unknown and offline machines are left alone", () => {
    expect(automaticAgentUpdateDue(machine("0.1.60"), "0.1.60", NOW)).toBe(false);
    // An operator rollback to an older promoted build stays an explicit request.
    expect(automaticAgentUpdateDue(machine("0.1.61"), "0.1.60", NOW)).toBe(false);
    expect(automaticAgentUpdateDue(machine(null), "0.1.60", NOW)).toBe(false);
    expect(automaticAgentUpdateDue(machine("dev-build"), "0.1.60", NOW)).toBe(false);
    expect(
      automaticAgentUpdateDue(
        machine("0.1.55", null, { connectionInstanceId: null }),
        "0.1.60",
        NOW,
      ),
    ).toBe(false);
  });

  test("a Mac that must bootstrap through the whole-app installer is never updated by RPC", () => {
    expect(automaticAgentUpdateDue(machine("0.1.28", null, { os: "macos" }), "0.1.60", NOW)).toBe(
      false,
    );
  });

  test("a busy postponement is retried after its backoff", () => {
    const busy = { status: "failed" as const, errorCode: "update_busy_work", retryable: true };
    expect(
      automaticAgentUpdateDue(
        machine("0.1.55", { ...busy, updatedAt: minutesAgo(9) }),
        "0.1.60",
        NOW,
      ),
    ).toBe(false);
    expect(
      automaticAgentUpdateDue(
        machine("0.1.55", { ...busy, updatedAt: minutesAgo(10) }),
        "0.1.60",
        NOW,
      ),
    ).toBe(true);
  });

  test("other retryable failures back off longer; non-retryable ones wait for a newer promotion", () => {
    const retryable = { status: "failed" as const, errorCode: "download_failed", retryable: true };
    expect(
      automaticAgentUpdateDue(
        machine("0.1.55", { ...retryable, updatedAt: minutesAgo(30) }),
        "0.1.60",
        NOW,
      ),
    ).toBe(false);
    expect(
      automaticAgentUpdateDue(
        machine("0.1.55", { ...retryable, updatedAt: minutesAgo(60) }),
        "0.1.60",
        NOW,
      ),
    ).toBe(true);
    const fatal = { status: "failed" as const, errorCode: "signature_invalid", retryable: false };
    expect(
      automaticAgentUpdateDue(
        machine("0.1.55", { ...fatal, updatedAt: minutesAgo(600) }),
        "0.1.60",
        NOW,
      ),
    ).toBe(false);
    expect(
      automaticAgentUpdateDue(
        machine("0.1.55", { ...fatal, targetVersion: "0.1.59" }),
        "0.1.60",
        NOW,
      ),
    ).toBe(true);
  });

  test("an in-flight update is the runner's; only an unanswered request is re-sent", () => {
    for (const status of ["accepted", "waiting_for_idle", "downloading", "restarting"] as const) {
      expect(
        automaticAgentUpdateDue(
          machine("0.1.55", { status, updatedAt: minutesAgo(600) }),
          "0.1.60",
          NOW,
        ),
      ).toBe(false);
    }
    const requested = { status: "requested" as const };
    expect(
      automaticAgentUpdateDue(
        machine("0.1.55", { ...requested, updatedAt: minutesAgo(5) }),
        "0.1.60",
        NOW,
      ),
    ).toBe(false);
    expect(
      automaticAgentUpdateDue(
        machine("0.1.55", { ...requested, updatedAt: minutesAgo(10) }),
        "0.1.60",
        NOW,
      ),
    ).toBe(true);
    // A request owned by a replaced process is settled by the successor's Hello.
    expect(
      automaticAgentUpdateDue(
        machine("0.1.55", { ...requested, connectionInstanceId: "old", updatedAt: minutesAgo(60) }),
        "0.1.60",
        NOW,
      ),
    ).toBe(false);
  });

  test("a completed update to an older target does not block the next one", () => {
    expect(
      automaticAgentUpdateDue(
        machine("0.1.55", { status: "succeeded", targetVersion: "0.1.55" }),
        "0.1.60",
        NOW,
      ),
    ).toBe(true);
  });
});

describe("retrying a failed download", () => {
  const download = {
    status: "failed" as const,
    errorCode: "manifest_download_failed",
    retryable: true,
  };

  test("the first retry comes soon, and each later one waits twice as long", () => {
    // The first attempt failed a minute after it was requested.
    const first = machine(
      "0.1.150",
      {
        ...download,
        targetVersion: "0.1.152",
        requestedAt: minutesAgo(11),
        updatedAt: minutesAgo(10),
      },
      { agentUpdatePendingSince: minutesAgo(11) },
    );
    expect(retryableAgentUpdateBackoffMs(first)).toBe(10 * 60_000);
    expect(automaticAgentUpdateDue(first, "0.1.152", NOW)).toBe(true);
    // Failing for 40 minutes so far: wait 40 more.
    const later = machine(
      "0.1.150",
      {
        ...download,
        targetVersion: "0.1.152",
        requestedAt: minutesAgo(31),
        updatedAt: minutesAgo(30),
      },
      { agentUpdatePendingSince: minutesAgo(70) },
    );
    expect(retryableAgentUpdateBackoffMs(later)).toBe(40 * 60_000);
    expect(automaticAgentUpdateDue(later, "0.1.152", NOW)).toBe(false);
    expect(automaticAgentUpdateDue(later, "0.1.152", NOW + 10 * 60_000)).toBe(true);
  });

  test("the wait stops growing at six hours", () => {
    const stuck = machine(
      "0.1.150",
      { ...download, targetVersion: "0.1.152", updatedAt: minutesAgo(5 * 60) },
      { agentUpdatePendingSince: minutesAgo(3 * 24 * 60) },
    );
    expect(retryableAgentUpdateBackoffMs(stuck)).toBe(6 * 60 * 60_000);
    expect(automaticAgentUpdateDue(stuck, "0.1.152", NOW)).toBe(false);
    expect(automaticAgentUpdateDue(stuck, "0.1.152", NOW + 60 * 60_000)).toBe(true);
  });
});

describe("an older agent's open browsers", () => {
  const browsers = (update: Partial<NonNullable<EnrollmentRecord["agentUpdate"]>>, since: number) =>
    machine(
      "0.1.55",
      {
        status: "failed",
        errorCode: "update_busy_browsers",
        retryable: true,
        ...update,
      },
      { agentUpdatePendingSince: minutesAgo(since) },
    );

  test("do not hold an update while no working session is using them", () => {
    const waiting = browsers({ requestedAt: minutesAgo(30), updatedAt: minutesAgo(30) }, 30);
    expect(browserUpdateDecision(waiting, { live: 3, inUse: 0 }, NOW)).toBe("update");
    expect(browserUpdateDecision(waiting, { live: 0, inUse: 0 }, NOW)).toBe("update");
    expect(browserUpdateDecision(waiting, { live: 3, inUse: 1 }, NOW)).toBe("postpone");
    // A browser-preserving agent is updated whatever its browsers do.
    expect(
      browserUpdateDecision(
        machine("0.1.58", { status: "failed", errorCode: "update_busy_browsers" }),
        { live: 3, inUse: 3 },
        NOW,
      ),
    ).toBe("update");
  });

  test("browsers always in use postpone an update for a bounded time, then it is announced", () => {
    // Under a day of waiting: an ordinary postponement, looked at again soon.
    const recent = browsers({ requestedAt: minutesAgo(11), updatedAt: minutesAgo(11) }, 23 * 60);
    expect(browserClosingUpdateAt(recent)).toBeNull();
    expect(agentUpdateBrowserClosingNotice(recent, NOW)).toBeNull();
    expect(automaticAgentUpdateDue(recent, "0.1.60", NOW)).toBe(true);
    expect(browserUpdateDecision(recent, { live: 1, inUse: 1 }, NOW)).toBe("postpone");

    // The first postponement recorded after a day announces a closing time
    // thirty minutes later, and agents using the browsers are told.
    const announced = browsers(
      { requestedAt: minutesAgo(5), updatedAt: minutesAgo(5) },
      24 * 60 + 5,
    );
    expect(browserClosingUpdateAt(announced)).toBe(NOW + 25 * 60_000);
    expect(agentUpdateBrowserClosingNotice(announced, NOW)).toBe(
      "This Connected Machine's agent updates at 12:25 UTC (in 25 min), and the update closes this browser. Finish or save your browser work before then; open a new browser afterwards if you still need one.",
    );
    // Until then nothing is recorded or requested, even for a newer release.
    expect(automaticAgentUpdateDue(announced, "0.1.60", NOW + 20 * 60_000)).toBe(false);
    expect(automaticAgentUpdateDue(announced, "0.1.61", NOW + 20 * 60_000)).toBe(false);
    expect(browserUpdateDecision(announced, { live: 1, inUse: 1 }, NOW)).toBe("wait");
    // Then the update goes ahead though the browsers are still in use.
    expect(automaticAgentUpdateDue(announced, "0.1.60", NOW + 25 * 60_000)).toBe(true);
    expect(browserUpdateDecision(announced, { live: 1, inUse: 1 }, NOW + 25 * 60_000)).toBe(
      "update",
    );
    expect(agentUpdateBrowserClosingNotice(announced, NOW + 25 * 60_000)).toBeNull();
  });

  test("only a postponement for browsers announces a closing time", () => {
    const busyWork = browsers(
      { errorCode: "update_busy_work", requestedAt: minutesAgo(5), updatedAt: minutesAgo(5) },
      2 * 24 * 60,
    );
    expect(browserClosingUpdateAt(busyWork)).toBeNull();
    const preserving = machine(
      "0.1.58",
      { status: "failed", errorCode: "update_busy_browsers", requestedAt: minutesAgo(5) },
      { agentUpdatePendingSince: minutesAgo(2 * 24 * 60) },
    );
    expect(browserClosingUpdateAt(preserving)).toBeNull();
  });

  test("the notice is added to the observation's own notice", () => {
    expect(withBrowserClosingNotice({ id: 1 }, null)).toEqual({ id: 1 });
    expect(withBrowserClosingNotice({ id: 1 }, "Closing.")).toEqual({ id: 1, notice: "Closing." });
    expect(withBrowserClosingNotice({ id: 1, notice: "Reloaded." }, "Closing.")).toEqual({
      id: 1,
      notice: "Reloaded.\nClosing.",
    });
    expect(withBrowserClosingNotice({ notice: "x".repeat(1_020) }, "Closing.")).toEqual({
      notice: "Closing.",
    });
  });
});
