import { describe, expect, test } from "bun:test";
import type { RigChange, RigVersion, ScheduledTask } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import {
  appendRigSetupCommand,
  candidateRigVersionForChange,
  classifyRigVerificationOutcome,
  createRigForApi,
  promoteVerifiedRigChangeForApi,
} from "../src/rigs";
import { validatedScheduledTaskUpdate as updateScheduledTask } from "../src/domain/scheduled-tasks";

describe("rig CI promotion decisions", () => {
  test.each([
    ["setup_append", true, false, "proposed", "await_manage_promote"],
    ["definition_edit", true, false, "proposed", "await_manage_promote"],
    ["setup_append", false, false, "rejected", "reject"],
    ["definition_edit", false, false, "rejected", "reject"],
    ["setup_append", true, true, "failed", "retryable_failure"],
    ["definition_edit", false, true, "failed", "retryable_failure"],
  ] as const)("%s passed=%p infra=%p -> %s/%s", (kind, passed, infraError, status, action) => {
    expect(classifyRigVerificationOutcome({ kind, passed, infraError })).toEqual({
      status,
      action,
    });
  });

  test("setup_append version composition appends the verified command", () => {
    expect(appendRigSetupCommand("mkdir -p /opt/x\n", "touch /opt/x/tool")).toBe(
      "mkdir -p /opt/x\ntouch /opt/x/tool",
    );
    expect(appendRigSetupCommand(null, "touch /opt/x/tool")).toBe("touch /opt/x/tool");
  });

  test("verification and promotion share the exact setup_append candidate artifact", () => {
    const base = {
      id: "11111111-1111-4111-8111-111111111111",
      rigId: "22222222-2222-4222-8222-222222222222",
      version: 1,
      image: null,
      setupScript: 'cd /tmp\nexport FLAG=ok\nhelper() { test "$FLAG" = ok; }\n',
      checks: [{ name: "helper", command: "command -v bash" }],
      credentialHooks: [],
      defaultVariableSetIds: [],
      changelog: null,
      createdBy: null,
      active: true,
      createdAt: "2026-07-10T00:00:00.000Z",
    } satisfies RigVersion;
    const change = {
      id: "33333333-3333-4333-8333-333333333333",
      rigId: base.rigId,
      baseVersionId: base.id,
      kind: "setup_append",
      payload: { command: 'helper && test "$PWD" = /tmp', note: "stateful append" },
      status: "proposed",
      proposedBy: "session:test",
      idempotencyKey: null,
      verification: null,
      resultVersionId: null,
      createdAt: base.createdAt,
      updatedAt: base.createdAt,
    } satisfies RigChange;
    expect(candidateRigVersionForChange(base, change).setupScript).toBe(
      'cd /tmp\nexport FLAG=ok\nhelper() { test "$FLAG" = ok; }\nhelper && test "$PWD" = /tmp',
    );
  });

  test("rigs:use is rejected before any durable mint or activation dependency is touched", async () => {
    const useGrant = {
      accountId: "44444444-4444-4444-8444-444444444444",
      workspaceId: "55555555-5555-4555-8555-555555555555",
      subjectId: "session:test",
      permissions: ["rigs:use" as const],
    };
    const rig = {
      id: "22222222-2222-4222-8222-222222222222",
      accountId: useGrant.accountId,
      workspaceId: useGrant.workspaceId,
      name: "security-rig",
      description: null,
      activeVersion: baseVersion(),
      activeVersionHealth: null,
      versionCount: 1,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    };
    const change = changeFor(rig.activeVersion);
    change.verification = { passed: true };

    await expect(
      promoteVerifiedRigChangeForApi({ db: {} as never }, useGrant, rig, change),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      createRigForApi({ db: {} as never }, useGrant, { name: "forbidden" }),
    ).rejects.toMatchObject({ status: 403 });
  });

  test("a live reusable task cannot swap or detach its frozen rig authorization", async () => {
    const existing = {
      id: "66666666-6666-4666-8666-666666666666",
      accountId: "44444444-4444-4444-8444-444444444444",
      workspaceId: "55555555-5555-4555-8555-555555555555",
      name: "reusable rig task",
      status: "paused",
      schedule: { type: "interval", everySeconds: 3600 },
      temporalScheduleId: "scheduled-task-reusable-rig",
      runMode: "reusable_session",
      overlapPolicy: "skip",
      agentConfig: { prompt: "run", resources: [], tools: [], metadata: {} },
      reusableSessionId: "77777777-7777-4777-8777-777777777777",
      variableSetId: null,
      environmentId: null,
      rigId: "22222222-2222-4222-8222-222222222222",
      rigDefaultVariableSetsAuthorized: true,
      metadata: {},
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    } satisfies ScheduledTask;
    const grant = {
      accountId: existing.accountId,
      workspaceId: existing.workspaceId,
      subjectId: "user:task-manager",
      permissions: ["scheduled_tasks:manage" as const],
    };

    await expect(
      updateScheduledTask({
        settings: testSettings({}),
        db: {} as never,
        objectStorage: null,
        grant,
        existing,
        payload: { rigId: null },
      }),
    ).rejects.toMatchObject({ status: 409 });

    // Repeating the same rig id is a no-op and must not clear the provenance
    // merely because the task editor lacks variable-sets:use.
    expect(
      await updateScheduledTask({
        settings: testSettings({}),
        db: {} as never,
        objectStorage: null,
        grant,
        existing,
        payload: { rigId: existing.rigId },
      }),
    ).toEqual({});

    await expect(
      updateScheduledTask({
        settings: testSettings({}),
        db: {} as never,
        objectStorage: null,
        grant,
        existing,
        payload: {
          rigId: existing.rigId,
          agentConfig: { ...existing.agentConfig, prompt: "new secret-consuming instructions" },
        },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

function baseVersion(): RigVersion {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    rigId: "22222222-2222-4222-8222-222222222222",
    version: 1,
    image: null,
    setupScript: "true",
    checks: [],
    credentialHooks: [],
    defaultVariableSetIds: [],
    changelog: null,
    createdBy: null,
    active: true,
    createdAt: "2026-07-10T00:00:00.000Z",
  };
}

function changeFor(base: RigVersion): RigChange {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    rigId: base.rigId,
    baseVersionId: base.id,
    kind: "setup_append",
    payload: { command: "true" },
    status: "proposed",
    proposedBy: "session:test",
    idempotencyKey: null,
    verification: null,
    resultVersionId: null,
    createdAt: base.createdAt,
    updatedAt: base.createdAt,
  };
}
