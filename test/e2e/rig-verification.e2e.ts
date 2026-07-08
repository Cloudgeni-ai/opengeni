import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import { bootstrapWorkspace, createDb, createRig, createRigChange, getRig, getRigChange, type DbClient } from "@opengeni/db";
import {
  establishSandboxSessionFromEnvelope,
  runRigSetupHook,
  sandboxCommandExitCode,
  sandboxCommandOutput,
  type EstablishedSandboxSession,
} from "@opengeni/runtime";
import { buildSandboxImage, startTestServices, testSettings, type TestServices } from "@opengeni/testing";
import { createRigVerificationActivities } from "../../apps/worker/src/activities/rig-verification";
import { settingsWithRigImage } from "../../apps/worker/src/activities/packs";
import type { ActivityServices } from "../../apps/worker/src/activities/types";

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

  test("A10 setup_append verifies in a clean Docker box and auto-merges into the next active version", async () => {
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
    if (verified.status !== "merged") {
      console.error("A10 verification payload", JSON.stringify(verified.verification, null, 2));
    }
    expect(verified.status).toBe("merged");
    expect(verified.verification?.passed).toBe(true);
    expect(verified.resultVersionId).toBeString();

    const promotedRig = await getRig(db.db, workspaceId, rig.id);
    expect(promotedRig?.activeVersion?.id).toBe(verified.resultVersionId);
    expect(promotedRig?.activeVersion?.version).toBe(2);
    expect(promotedRig?.activeVersion?.setupScript).toContain("mkdir -p /opt/rigtest");
    expect(promotedRig?.activeVersion?.setupScript).toContain("touch /opt/rigtest/tool");

    await expectFreshMaterializationHasTool(promotedRig!.activeVersion!);
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
    expect((verified.verification as { commandResult?: { exitCode?: number | null; output?: string } }).commandResult?.exitCode).toBe(1);

    const stored = await getRigChange(db.db, workspaceId, change.id);
    expect(stored?.status).toBe("rejected");
    expect((stored?.verification as { commandResult?: { exitCode?: number | null; output?: string } }).commandResult?.exitCode).toBe(1);
  }, 300_000);
});

function verifier() {
  return createRigVerificationActivities(async () => ({
    settings,
    db: db.db,
  } as ActivityServices));
}

async function expectFreshMaterializationHasTool(version: NonNullable<NonNullable<Awaited<ReturnType<typeof getRig>>>["activeVersion"]>): Promise<void> {
  const runSettings = settingsWithRigImage(settings, version.image);
  let established: EstablishedSandboxSession | null = null;
  try {
    established = await establishSandboxSessionFromEnvelope(runSettings, null, {
      sessionId: `rig-verification-materialize-${crypto.randomUUID()}`,
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
    const result = await (established.session as { exec: (args: Record<string, unknown>) => Promise<unknown> }).exec({
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
  const session = established.session as { terminate?: () => Promise<unknown>; kill?: () => Promise<unknown>; close?: () => Promise<unknown> };
  await (session.terminate ?? session.kill ?? session.close)?.call(session).catch(() => undefined);
}
