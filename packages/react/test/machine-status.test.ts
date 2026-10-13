import { describe, expect, test } from "bun:test";
import {
  describeAgentConnection,
  describeAgentRuntime,
  runnerConflict,
  RUNNER_CONFLICT_ACTIVE_MS,
} from "../src/components/machines/machine-status";
import type { MachineView } from "../src/types/machines";

type Runtime = NonNullable<MachineView["runtime"]>;
type Update = NonNullable<Runtime["update"]>;

const NOW = new Date("2026-10-13T12:00:00.000Z").getTime();

function runtime(overrides: Partial<Runtime>): Runtime {
  return {
    installedVersion: "0.1.53",
    binarySha256: null,
    updateChannel: "stable",
    desiredVersion: "0.1.54",
    versionState: "outdated",
    capabilities: {
      exec: true,
      filesystem: true,
      git: true,
      pty: true,
      desktop: false,
      opStream: true,
      browserBridge: false,
      operationResourcePolicy: false,
      operationCpuQuota: false,
      transactionalFsWrite: false,
      credentialRenew: false,
      screenControl: null,
    },
    update: null,
    macPermissions: null,
    ...overrides,
  };
}

function update(overrides: Partial<Update>): Update {
  return {
    operationId: "00000000-0000-4000-8000-000000000003",
    status: "failed",
    targetVersion: "0.1.54",
    expectedBinarySha256: null,
    errorCode: null,
    retryable: true,
    rolledBack: false,
    requestedAt: "2026-10-13T11:59:00.000Z",
    updatedAt: "2026-10-13T11:59:30.000Z",
    completedAt: null,
    ...overrides,
  };
}

describe("describeAgentRuntime", () => {
  test("waiting for idle promises the update truthfully, with no action", () => {
    const status = describeAgentRuntime(
      runtime({ versionState: "updating", update: update({ status: "waiting_for_idle" }) }),
      NOW,
    );
    expect(status.status).toBe("Updates to v0.1.54 when current work finishes");
    expect(status.action).toBeNull();
  });

  test("a rolled-back update says the current version was kept", () => {
    const status = describeAgentRuntime(
      runtime({
        versionState: "update_failed",
        update: update({ rolledBack: true, errorCode: "health_check_failed" }),
      }),
      NOW,
    );
    expect(status.status).toContain("so the current version was kept");
    expect(status.note).toBe("Reason: health check failed.");
    expect(status.tone).toBe("attention");
  });

  test("a blocked update explains why and offers nothing it cannot do", () => {
    const status = describeAgentRuntime(
      runtime({
        updateBlockedReason: "Use the installer first.",
        update: update({ errorCode: "update_busy_work" }),
      }),
      NOW,
    );
    expect(status.note).toBe("Use the installer first.");
    expect(status.action).toBeNull();
  });

  test("a beta agent on the latest build is up to date", () => {
    const status = describeAgentRuntime(
      runtime({ installedVersion: "0.1.54", versionState: "current", updateChannel: "beta" }),
      NOW,
    );
    expect(status.status).toBe("Up to date · beta");
    expect(status.tone).toBe("ok");
  });
});

describe("runnerConflict and describeAgentConnection", () => {
  const authority = {
    state: "active" as const,
    generation: 4,
    supersededCount: 3,
    leaseExpiresAt: null,
    duplicateRunnerDeniedCount: 8,
    duplicateRunnerDeniedAt: new Date(NOW - RUNNER_CONFLICT_ACTIVE_MS - 1).toISOString(),
  };

  test("a refusal older than the retry window is history", () => {
    expect(runnerConflict(authority, NOW)?.active).toBe(false);
    expect(
      runnerConflict(
        { ...authority, duplicateRunnerDeniedAt: new Date(NOW - 5_000).toISOString() },
        NOW,
      )?.active,
    ).toBe(true);
    expect(runnerConflict({ ...authority, duplicateRunnerDeniedCount: 0 }, NOW)).toBeNull();
  });

  test("the connection reads in plain words", () => {
    expect(describeAgentConnection(authority)).toEqual({
      label: "Agent connected",
      detail: "Reconnected 3 times since setup",
    });
    expect(describeAgentConnection({ ...authority, state: "expired", supersededCount: 0 })).toEqual(
      {
        label: "Agent connection lapsed",
        detail: null,
      },
    );
  });
});
