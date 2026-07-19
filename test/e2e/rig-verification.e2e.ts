import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import {
  beginRigChangeVerificationAttempt,
  bootstrapWorkspace,
  createDb,
  createRig,
  createRigChange,
  dbSql,
  getRig,
  getRigChange,
  setRlsContext,
  updateRigChangeStatus,
  type DbClient,
} from "@opengeni/db";
import {
  establishSandboxSessionFromEnvelope,
  runRigSetupHook,
  sandboxCommandExitCode,
  sandboxCommandOutput,
  type EstablishedSandboxSession,
} from "@opengeni/runtime";
import {
  buildSandboxImage,
  startTestServices,
  testSettings,
  type TestServices,
} from "@opengeni/testing";
import { createRigVerificationActivities } from "../../apps/worker/src/activities/rig-verification";
import { settingsWithRigImage } from "../../apps/worker/src/activities/packs";
import type { ActivityServices } from "../../apps/worker/src/activities/types";
import { promoteVerifiedRigChangeForApi } from "@opengeni/core";

const repoRoot = new URL("../..", import.meta.url).pathname;

let services: TestServices;
let db: DbClient;
let settings: Settings;
let accountId = "";
let workspaceId = "";

describe("real Docker rig verification e2e", () => {
  beforeAll(async () => {
    await buildSandboxImage("opengeni-sandbox:local", repoRoot);
    services = await startTestServices({ temporal: false, objectStorage: false });
    await services.migrate();
    db = createDb(services.databaseUrl);
    settings = testSettings({
      databaseUrl: services.databaseUrl,
      sandboxBackend: "docker",
      dockerImage: "opengeni-sandbox:local",
      dockerNetwork: services.dockerNetwork,
      sandboxPreparationProfiles: [],
      rigSetupTimeoutMs: 60_000,
    }) as Settings;
    const access = await bootstrapWorkspace(db.db, {
      accountExternalSource: "opengeni:local",
      accountExternalId: `rig-verification-${crypto.randomUUID()}`,
      accountName: "Rig verification e2e",
      workspaceExternalSource: "opengeni:e2e",
      workspaceExternalId: `rig-verification-${crypto.randomUUID()}`,
      workspaceName: "Rig verification e2e",
      subjectId: "user:e2e",
    });
    accountId = access.defaultAccountId!;
    workspaceId = access.defaultWorkspaceId!;
  }, 360_000);

  afterAll(async () => {
    await db?.close();
    await services?.down();
  }, 60_000);

  test("A10 setup_append verifies clean but activates only after manager promotion", async () => {
    const rig = await createRig(db.db, {
      accountId,
      workspaceId,
      name: "a10-rig",
      createdBy: "user:e2e",
      initialVersion: {
        setupScript: "mkdir -p /opt/rigtest",
        checks: [{ name: "tool-dir", command: "test -d /opt/rigtest" }],
        changelog: "v1",
      },
    });
    const change = await createRigChange(db.db, {
      accountId,
      workspaceId,
      rigId: rig.id,
      baseVersionId: rig.activeVersion!.id,
      kind: "setup_append",
      payload: { command: "touch /opt/rigtest/tool", note: "install test tool" },
      proposedBy: "session:e2e",
    });

    const verified = await verifier().verifyRigChange({ workspaceId, changeId: change.id });
    if (verified.status !== "proposed") {
      console.error("A10 verification payload", JSON.stringify(verified.verification, null, 2));
    }
    expect(verified.status).toBe("proposed");
    expect(verified.verification?.passed).toBe(true);
    expect(verified.resultVersionId).toBeNull();

    const stillV1 = await getRig(db.db, workspaceId, rig.id);
    expect(stillV1?.activeVersion?.id).toBe(rig.activeVersion!.id);
    expect(stillV1?.versionCount).toBe(1);

    const promoted = await promoteVerifiedRigChangeForApi(
      { db: db.db },
      {
        accountId,
        workspaceId,
        subjectId: "user:manager",
        permissions: ["rigs:manage"],
      },
      stillV1!,
      verified,
    );
    expect(promoted.promoted).toBe(true);
    const promotedRig = await getRig(db.db, workspaceId, rig.id);
    expect(promotedRig?.activeVersion?.id).toBe(promoted.version.id);
    expect(promotedRig?.activeVersion?.version).toBe(2);
    expect(promotedRig?.activeVersion?.setupScript).toContain("mkdir -p /opt/rigtest");
    expect(promotedRig?.activeVersion?.setupScript).toContain("touch /opt/rigtest/tool");

    await expectFreshMaterializationHasTool(promoted.version);
  }, 300_000);

  test("A11 poisoned setup_append is rejected because clean replay lacks proposer-local state", async () => {
    const rig = await createRig(db.db, {
      accountId,
      workspaceId,
      name: "a11-rig",
      createdBy: "user:e2e",
      initialVersion: {
        setupScript: "mkdir -p /opt/poison",
        checks: [{ name: "base-ok", command: "test -d /opt/poison" }],
        changelog: "v1",
      },
    });
    const change = await createRigChange(db.db, {
      accountId,
      workspaceId,
      rigId: rig.id,
      baseVersionId: rig.activeVersion!.id,
      kind: "setup_append",
      payload: { command: "test -f /tmp/only-in-proposer-box", note: "poisoned local dependency" },
      proposedBy: "session:dirty-proposer",
    });

    const verified = await verifier().verifyRigChange({ workspaceId, changeId: change.id });
    if (verified.status !== "rejected") {
      console.error("A11 verification payload", JSON.stringify(verified.verification, null, 2));
    }
    expect(verified.status).toBe("rejected");
    expect(verified.verification?.passed).toBe(false);
    expect(verified.verification?.setupResult?.exitCode).toBe(1);

    const stored = await getRigChange(db.db, workspaceId, change.id);
    expect(stored?.status).toBe("rejected");
    expect(
      (
        stored?.verification as
          | { commandResult?: { exitCode?: number | null; output?: string } }
          | undefined
      )?.commandResult?.exitCode,
    ).toBeUndefined();
    expect(stored?.verification?.setupResult?.exitCode).toBe(1);
    expect((await getRig(db.db, workspaceId, rig.id))?.activeVersion?.id).toBe(
      rig.activeVersion!.id,
    );
  }, 300_000);

  test("candidate setup preserves Bash state across base + append and leaves state for checks", async () => {
    const rig = await createRig(db.db, {
      accountId,
      workspaceId,
      name: "state-fidelity-rig",
      createdBy: "user:e2e",
      initialVersion: {
        setupScript: [
          "mkdir -p /opt/rig-state",
          "cd /opt/rig-state",
          "export RIG_STATE=preserved",
          'verify_state() { test "$RIG_STATE" = preserved && test "$PWD" = /opt/rig-state; }',
          "set -euo pipefail",
          "trap 'touch /opt/rig-state/trap-ran' EXIT",
        ].join("\n"),
        checks: [
          { name: "append-ran", command: "test -f /opt/rig-state/append-ran" },
          { name: "trap-ran", command: "test -f /opt/rig-state/trap-ran" },
        ],
      },
    });
    const change = await createRigChange(db.db, {
      accountId,
      workspaceId,
      rigId: rig.id,
      baseVersionId: rig.activeVersion!.id,
      kind: "setup_append",
      payload: { command: "verify_state && touch append-ran" },
    });
    const verified = await verifier().verifyRigChange({ workspaceId, changeId: change.id });
    expect(verified.status).toBe("proposed");
    expect(verified.verification?.passed).toBe(true);
    expect(verified.verification?.checkResults).toHaveLength(2);
    expect(verified.verification?.checkResults?.every((result) => result.status === "passed")).toBe(
      true,
    );
  }, 300_000);

  test("base pipefail applies to the appended command and rejects the exact candidate", async () => {
    const rig = await createRig(db.db, {
      accountId,
      workspaceId,
      name: "pipefail-fidelity-rig",
      initialVersion: {
        setupScript: "set -o pipefail",
        checks: [{ name: "not-run", command: "false" }],
      },
    });
    const change = await createRigChange(db.db, {
      accountId,
      workspaceId,
      rigId: rig.id,
      baseVersionId: rig.activeVersion!.id,
      kind: "setup_append",
      payload: { command: "false | true" },
    });
    const verified = await verifier().verifyRigChange({ workspaceId, changeId: change.id });
    expect(verified.status).toBe("rejected");
    expect(verified.verification?.setupResult).toMatchObject({ status: "failed" });
    expect(verified.verification?.checkResults).toEqual([
      expect.objectContaining({
        name: "not-run",
        status: "skipped",
        exitCode: null,
        skippedReason: expect.stringContaining("setup failed"),
      }),
    ]);
    expect((await getRig(db.db, workspaceId, rig.id))?.activeVersion?.id).toBe(
      rig.activeVersion!.id,
    );
  }, 300_000);

  test("candidate setup timeout is hard and leaves the prior active version unchanged", async () => {
    const rig = await createRig(db.db, {
      accountId,
      workspaceId,
      name: "timeout-rig",
      initialVersion: { setupScript: "true", checks: [] },
    });
    const change = await createRigChange(db.db, {
      accountId,
      workspaceId,
      rigId: rig.id,
      baseVersionId: rig.activeVersion!.id,
      kind: "setup_append",
      payload: { command: "sleep 30" },
    });
    const started = Date.now();
    const verified = await verifier({ rigSetupTimeoutMs: 250 }).verifyRigChange({
      workspaceId,
      changeId: change.id,
    });
    expect(verified.status).toBe("rejected");
    expect(verified.verification?.setupResult).toMatchObject({
      status: "failed",
      timedOut: true,
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect((await getRig(db.db, workspaceId, rig.id))?.activeVersion?.id).toBe(
      rig.activeVersion!.id,
    );
  }, 300_000);

  test("verification exception fails closed and preserves the prior active version", async () => {
    const rig = await createRig(db.db, {
      accountId,
      workspaceId,
      name: "exception-rig",
      // Direct DB callers can represent historical malformed records; the
      // verifier must still reject duplicate result names fail-closed.
      initialVersion: {
        setupScript: "true",
        checks: [
          { name: "duplicate", command: "true" },
          { name: "duplicate", command: "true" },
        ],
      },
    });
    const change = await createRigChange(db.db, {
      accountId,
      workspaceId,
      rigId: rig.id,
      baseVersionId: rig.activeVersion!.id,
      kind: "setup_append",
      payload: { command: "true" },
    });
    const verified = await verifier().verifyRigChange({ workspaceId, changeId: change.id });
    expect(verified.status).toBe("failed");
    expect(verified.verification?.error).toContain("duplicate rig check name");
    expect((await getRig(db.db, workspaceId, rig.id))?.activeVersion?.id).toBe(
      rig.activeVersion!.id,
    );
  }, 300_000);

  test("a stale workflow attempt cannot create a new verifying attempt", async () => {
    const rig = await createRig(db.db, {
      accountId,
      workspaceId,
      name: "stale-workflow-attempt-rig",
      initialVersion: { setupScript: "true" },
    });
    const change = await createRigChange(db.db, {
      accountId,
      workspaceId,
      rigId: rig.id,
      baseVersionId: rig.activeVersion!.id,
      kind: "setup_append",
      payload: { command: "true" },
    });
    const attempt = await beginRigChangeVerificationAttempt(db.db, workspaceId, change.id, {
      startedAt: new Date().toISOString(),
    });
    await updateRigChangeStatus(db.db, workspaceId, change.id, {
      status: "failed",
      verification: { ...attempt.verification, passed: false, error: "cancelled" },
    });

    await expect(
      verifier().verifyRigChange({ workspaceId, changeId: change.id, attempt: 1 }),
    ).rejects.toThrow(/verification attempt moved/);
    const stored = await getRigChange(db.db, workspaceId, change.id);
    expect(stored?.status).toBe("failed");
    expect(stored?.verification?.attempt).toBe(1);
    expect((await getRig(db.db, workspaceId, rig.id))?.activeVersion?.id).toBe(
      rig.activeVersion!.id,
    );
  }, 300_000);

  test("verification output is redacted before persistence and audit metadata", async () => {
    const secret = "rig-secret-token-123456";
    const rig = await createRig(db.db, {
      accountId,
      workspaceId,
      name: "redaction-rig",
      createdBy: "user:e2e",
      initialVersion: {
        setupScript: "true",
        checks: [{ name: "secret-echo", command: `printf 'API_KEY=${secret}\\n'` }],
        changelog: "v1",
      },
    });
    const change = await createRigChange(db.db, {
      accountId,
      workspaceId,
      rigId: rig.id,
      baseVersionId: rig.activeVersion!.id,
      kind: "definition_edit",
      payload: { checks: [{ name: "secret-echo", command: `printf 'API_KEY=${secret}\\n'` }] },
      proposedBy: "session:redaction",
    });

    const verified = await verifier().verifyRigChange({ workspaceId, changeId: change.id });
    const storedSerialized = JSON.stringify(verified.verification);
    expect(verified.status).toBe("proposed");
    expect(storedSerialized).not.toContain(secret);
    expect(storedSerialized).toContain("[REDACTED]");

    await verifier().verifyRigVersion({ workspaceId, versionId: rig.activeVersion!.id });
    const [audit] = await db.db.transaction(async (tx) => {
      await setRlsContext(tx as never, { accountId, workspaceId });
      return await tx.execute<{ metadata: unknown }>(dbSql`
        select metadata from audit_events
        where workspace_id = ${workspaceId}
          and target_type = 'rig'
          and target_id = ${rig.id}
          and action = 'rig.verification.passed'
          and metadata ? 'versionId'
        order by occurred_at desc
        limit 1`);
    });
    const auditSerialized = JSON.stringify(audit?.metadata);
    expect(auditSerialized).not.toContain(secret);
    expect(auditSerialized).toContain("[REDACTED]");
  }, 300_000);
});

function verifier(overrides: Partial<Settings> = {}) {
  return createRigVerificationActivities(
    async () =>
      ({
        settings: { ...settings, ...overrides },
        db: db.db,
      }) as ActivityServices,
  );
}

async function expectFreshMaterializationHasTool(
  version: NonNullable<NonNullable<Awaited<ReturnType<typeof getRig>>>["activeVersion"]>,
): Promise<void> {
  const runSettings = settingsWithRigImage(settings, version.image);
  let established: EstablishedSandboxSession | null = null;
  try {
    established = await establishSandboxSessionFromEnvelope(runSettings, null, {
      sessionId: `rig-verification-materialize-${crypto.randomUUID()}`,
      recovery: "create-or-restore",
      environment: {},
    });
    await runRigSetupHook(established.session as never, {
      environment: {},
      runAs: "root",
      rigSetup: {
        rigId: version.rigId,
        rigName: "a10-rig",
        versionId: version.id,
        script: version.setupScript ?? "",
        timeoutMs: settings.rigSetupTimeoutMs,
      },
    });
    const result = await (
      established.session as { exec: (args: Record<string, unknown>) => Promise<unknown> }
    ).exec({
      cmd: "test -f /opt/rigtest/tool",
      workdir: "/workspace",
      runAs: "root",
      yieldTimeMs: 10_000,
      maxOutputTokens: 1_000,
    });
    expect(sandboxCommandExitCode(result)).toBe(0);
    expect(sandboxCommandOutput(result)).toBeString();
  } finally {
    await terminate(established);
  }
}

async function terminate(established: EstablishedSandboxSession | null): Promise<void> {
  if (!established) {
    return;
  }
  const client = established.client as { delete?: (state: unknown) => Promise<unknown> };
  if (typeof client.delete === "function" && established.sessionState !== undefined) {
    await client.delete(established.sessionState).catch(() => undefined);
    return;
  }
  const session = established.session as {
    terminate?: () => Promise<unknown>;
    kill?: () => Promise<unknown>;
    close?: () => Promise<unknown>;
  };
  await (session.terminate ?? session.kill ?? session.close)?.call(session).catch(() => undefined);
}
