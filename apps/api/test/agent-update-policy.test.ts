import { describe, expect, test } from "bun:test";
import type { EnrollmentRecord } from "@opengeni/db";
import { automaticAgentUpdateDue } from "../src/sandbox/agent-update";

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
