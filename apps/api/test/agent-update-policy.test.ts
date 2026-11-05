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
    // The third failure of the run waits 40 minutes.
    const third = { agentUpdateFailedAttempts: 2 };
    expect(
      automaticAgentUpdateDue(
        machine("0.1.55", { ...retryable, updatedAt: minutesAgo(30) }, third),
        "0.1.60",
        NOW,
      ),
    ).toBe(false);
    expect(
      automaticAgentUpdateDue(
        machine("0.1.55", { ...retryable, updatedAt: minutesAgo(60) }, third),
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
    targetVersion: "0.1.152",
  };

  test("the first retry comes soon, and each later one waits twice as long", () => {
    const first = machine("0.1.150", { ...download, updatedAt: minutesAgo(10) });
    expect(retryableAgentUpdateBackoffMs(first)).toBe(10 * 60_000);
    expect(automaticAgentUpdateDue(first, "0.1.152", NOW)).toBe(true);
    // The fourth failure of the run, ten minutes ago: wait 80 minutes.
    const fourth = machine(
      "0.1.150",
      { ...download, updatedAt: minutesAgo(10) },
      { agentUpdateFailedAttempts: 3 },
    );
    expect(retryableAgentUpdateBackoffMs(fourth)).toBe(80 * 60_000);
    expect(automaticAgentUpdateDue(fourth, "0.1.152", NOW)).toBe(false);
    expect(automaticAgentUpdateDue(fourth, "0.1.152", NOW + 70 * 60_000)).toBe(true);
  });

  test("the wait stops growing at six hours", () => {
    const stuck = machine(
      "0.1.150",
      { ...download, updatedAt: minutesAgo(5 * 60) },
      { agentUpdateFailedAttempts: 12 },
    );
    expect(retryableAgentUpdateBackoffMs(stuck)).toBe(6 * 60 * 60_000);
    expect(automaticAgentUpdateDue(stuck, "0.1.152", NOW)).toBe(false);
    expect(automaticAgentUpdateDue(stuck, "0.1.152", NOW + 60 * 60_000)).toBe(true);
  });

  test("a newer target is asked for at once; an older one waits like a retry", () => {
    const failed = machine(
      "0.1.150",
      { ...download, updatedAt: minutesAgo(1) },
      { agentUpdateFailedAttempts: 3 },
    );
    expect(automaticAgentUpdateDue(failed, "0.1.153", NOW)).toBe(true);
    // Another replica that has not yet seen 0.1.152 published.
    const behind = machine(
      "0.1.149",
      { ...download, updatedAt: minutesAgo(1) },
      { agentUpdateFailedAttempts: 3 },
    );
    expect(automaticAgentUpdateDue(behind, "0.1.150", NOW)).toBe(false);
    expect(automaticAgentUpdateDue(behind, "0.1.150", NOW + 80 * 60_000)).toBe(true);
  });
});

describe("an older agent's open browsers", () => {
  const CLOSING =
    "This Connected Machine's agent restarts to update at about 12:25 UTC (in 25 min).";
  const LOSS =
    " The restart closes this browser: the next browser action reopens it with its pages, but unsaved page state, such as form input or downloads in progress, is lost. Finish or save that work first.";
  const postponed = (
    update: Partial<NonNullable<EnrollmentRecord["agentUpdate"]>>,
    overrides: Partial<EnrollmentRecord> = {},
  ) =>
    machine(
      "0.1.55",
      { status: "failed", errorCode: "update_busy_browsers", retryable: true, ...update },
      overrides,
    );

  test("do not hold an update while no working session is using them", () => {
    const waiting = postponed(
      { requestedAt: minutesAgo(30), updatedAt: minutesAgo(30) },
      { agentUpdateBrowsersWaitSince: minutesAgo(30) },
    );
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

  test("browsers always in use hold an update for a bounded time, then a closing time is announced", () => {
    const recent = postponed(
      { requestedAt: minutesAgo(11), updatedAt: minutesAgo(11) },
      { agentUpdateBrowsersWaitSince: minutesAgo(23 * 60) },
    );
    expect(automaticAgentUpdateDue(recent, "0.1.60", NOW)).toBe(true);
    expect(browserUpdateDecision(recent, { live: 1, inUse: 1 }, NOW)).toBe("postpone");
    // Trying for a day, whatever else held it (here a busy agent): announce.
    const day = postponed(
      { errorCode: "update_busy_work", requestedAt: minutesAgo(11), updatedAt: minutesAgo(11) },
      { agentUpdateBrowsersWaitSince: minutesAgo(24 * 60) },
    );
    expect(browserUpdateDecision(day, { live: 1, inUse: 1 }, NOW)).toBe("announce");
    // A new run (after a success, or the first attempt) has not waited.
    const fresh = machine(
      "0.1.55",
      { status: "succeeded", targetVersion: "0.1.55" },
      { agentUpdateBrowsersWaitSince: minutesAgo(3 * 24 * 60) },
    );
    expect(browserUpdateDecision(fresh, { live: 1, inUse: 1 }, NOW)).toBe("postpone");
    // Nor has one after a non-retryable failure, however long ago it began.
    const ended = machine(
      "0.1.55",
      { status: "failed", errorCode: "signature_invalid", retryable: false },
      { agentUpdateBrowsersWaitSince: minutesAgo(3 * 7 * 24 * 60) },
    );
    expect(browserUpdateDecision(ended, { live: 1, inUse: 1 }, NOW)).toBe("postpone");
  });

  test("an announced closing time: told until then, held, then updated", () => {
    const announced = postponed(
      { requestedAt: minutesAgo(5), updatedAt: minutesAgo(5) },
      {
        agentUpdateBrowsersWaitSince: minutesAgo(24 * 60 + 5),
        agentUpdateBrowsersCloseAt: new Date(NOW + 25 * 60_000).toISOString(),
      },
    );
    expect(browserClosingUpdateAt(announced)).toBe(NOW + 25 * 60_000);
    expect(agentUpdateBrowserClosingNotice(announced, NOW)).toBe(CLOSING + LOSS);
    // Until then nothing is recorded or requested, even for a newer release.
    expect(automaticAgentUpdateDue(announced, "0.1.60", NOW + 20 * 60_000)).toBe(false);
    expect(automaticAgentUpdateDue(announced, "0.1.61", NOW + 20 * 60_000)).toBe(false);
    // Then the update goes ahead though the browsers are still in use.
    const at = NOW + 25 * 60_000;
    expect(automaticAgentUpdateDue(announced, "0.1.60", at)).toBe(true);
    expect(browserUpdateDecision(announced, { live: 1, inUse: 1 }, at)).toBe("update");
    // Once the agent has accepted the update, it is restarting.
    const accepted = {
      ...announced,
      agentUpdate: { ...announced.agentUpdate!, status: "accepted" as const },
    };
    expect(agentUpdateBrowserClosingNotice(accepted, at)).toBe(
      `This Connected Machine's agent is restarting to update now.${LOSS}`,
    );
  });

  test("a busy refusal at the closing time keeps the announcement", () => {
    // The agent refused the update at 12:25 because it had work running.
    const refused = postponed(
      { errorCode: "update_busy_work", requestedAt: minutesAgo(-25), updatedAt: minutesAgo(-25) },
      {
        agentUpdateBrowsersWaitSince: minutesAgo(24 * 60 + 5),
        agentUpdateBrowsersCloseAt: new Date(NOW + 25 * 60_000).toISOString(),
      },
    );
    const retry = NOW + 35 * 60_000;
    expect(automaticAgentUpdateDue(refused, "0.1.60", retry)).toBe(true);
    expect(browserUpdateDecision(refused, { live: 1, inUse: 1 }, retry)).toBe("update");
    expect(agentUpdateBrowserClosingNotice(refused, retry)).toBe(
      `This Connected Machine's agent restarts to update as soon as its running work finishes.${LOSS}`,
    );
  });

  test("a closing time that passed without the update ends the announcement, and the wait starts over", () => {
    // The agent stayed busy through the grace period, or the machine was away.
    const stale = postponed(
      { errorCode: "update_busy_work", requestedAt: minutesAgo(70), updatedAt: minutesAgo(70) },
      {
        agentUpdateBrowsersWaitSince: minutesAgo(26 * 60),
        agentUpdateBrowsersCloseAt: minutesAgo(61),
      },
    );
    expect(agentUpdateBrowserClosingNotice(stale, NOW)).toBeNull();
    expect(automaticAgentUpdateDue(stale, "0.1.60", NOW)).toBe(true);
    expect(browserUpdateDecision(stale, { live: 1, inUse: 1 }, NOW)).toBe("postpone_again");
    // Idle browsers do not hold it.
    expect(browserUpdateDecision(stale, { live: 1, inUse: 0 }, NOW)).toBe("update");
  });

  test("an agent that is always busy is told of a closing at most once per wait", () => {
    // Four hours of an agent refusing every update while its browsers are in
    // use: after the first announcement and its grace period, no notice.
    let record = postponed(
      { errorCode: "update_busy_browsers", requestedAt: minutesAgo(1), updatedAt: minutesAgo(1) },
      { agentUpdateBrowsersWaitSince: minutesAgo(24 * 60 + 1) },
    );
    let noticed = 0;
    for (let minute = 0; minute < 4 * 60; minute += 5) {
      const at = NOW + minute * 60_000;
      if (agentUpdateBrowserClosingNotice(record, at)) noticed += 1;
      if (!automaticAgentUpdateDue(record, "0.1.60", at)) continue;
      const decision = browserUpdateDecision(record, { live: 1, inUse: 1 }, at);
      const stamp = new Date(at).toISOString();
      const closeAt =
        decision === "announce"
          ? new Date(at + 30 * 60_000).toISOString()
          : decision === "postpone_again"
            ? null
            : record.agentUpdateBrowsersCloseAt;
      record = postponed(
        {
          errorCode: decision === "update" ? "update_busy_work" : "update_busy_browsers",
          requestedAt: stamp,
          updatedAt: stamp,
        },
        {
          agentUpdateBrowsersWaitSince:
            decision === "postpone_again" ? stamp : record.agentUpdateBrowsersWaitSince,
          agentUpdateBrowsersCloseAt: closeAt,
        },
      );
    }
    // 30 minutes of notice and 30 minutes of grace, sampled every 5 minutes.
    expect(noticed).toBeLessThanOrEqual(13);
    expect(noticed).toBeGreaterThan(0);
    expect(record.agentUpdateBrowsersCloseAt).toBeNull();
  });

  test("no closing time once the agent keeps its browsers or the update succeeded", () => {
    const closeAt = { agentUpdateBrowsersCloseAt: new Date(NOW + 60_000).toISOString() };
    expect(
      browserClosingUpdateAt(
        machine("0.1.58", { status: "failed", errorCode: "update_busy_browsers" }, closeAt),
      ),
    ).toBeNull();
    expect(browserClosingUpdateAt(machine("0.1.55", { status: "succeeded" }, closeAt))).toBeNull();
    expect(browserClosingUpdateAt(postponed({}))).toBeNull();
  });

  test("the notice is added to the observation's own notice, which is shortened to fit", () => {
    expect(withBrowserClosingNotice({ id: 1 }, null)).toEqual({ id: 1 });
    expect(withBrowserClosingNotice({ id: 1 }, "Closing.")).toEqual({ id: 1, notice: "Closing." });
    expect(withBrowserClosingNotice({ id: 1, notice: "Reloaded." }, "Closing.")).toEqual({
      id: 1,
      notice: "Reloaded.\nClosing.",
    });
    const long = withBrowserClosingNotice({ notice: "x".repeat(1_020) }, "Closing.");
    expect(long.notice).toHaveLength(1_024);
    expect(long.notice).toEndWith("x\u2026\nClosing.");
  });
});
