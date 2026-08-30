import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  canonicalModalCheckpointProviderBinding,
  encodeNativeSnapshotRef,
  type NativeSnapshotDescriptor,
  type RigProviderImage,
} from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  activateRigVersion,
  beginRigVersionVerificationAttempt,
  claimRigVersionProviderImageBuild,
  claimSandboxCheckpointArtifactsForGc,
  countRigs,
  countSessionsUsingRig,
  completeRigVersionVerification,
  createDb,
  createRig,
  createRigChange,
  createRigVersion,
  createRigVersionForChangePromotion,
  createSession,
  deleteRig,
  deleteRigIfNoActiveSessions,
  finalizeRigVersionProviderImageBuild,
  failRigVersionVerification,
  getRig,
  getRigByName,
  getRigChange,
  getRigVersion,
  getRigVersionById,
  getRigVersionHealth,
  listRigChanges,
  listRigVersions,
  listRigs,
  markSandboxCheckpointArtifactDeletePending,
  nestedPostgresSqlState,
  registerSandboxCheckpointArtifact,
  RigActiveVersionChangedError,
  RigChangeTransitionError,
  RigImageOverrideUnsupportedError,
  RigVersionVerificationRequiredError,
  updateRig,
  updateRigChangeStatus,
  withWorkspaceSessionActivityRls,
  type Database,
  type DbClient,
} from "../src/index";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let db: Database;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

// This file verifies serialized rig invariants against real PostgreSQL. Parallel
// repository runs can queue those transactions behind other database suites, so
// use a finite file-scoped ceiling instead of canceling live transactions at
// Bun's five-second unit default.
setDefaultTimeout(30_000);

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [account] = await shared!.admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('acct') returning id`;
  const [workspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'ws') returning id`;
  await shared!
    .admin`insert into workspace_inference_controls (workspace_id, account_id) values (${workspace!.id}, ${account!.id})`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

// Two workspaces under ONE account — the strict workspace-level isolation case
// (RLS is keyed on account_id AND workspace_id).
async function twoWorkspacesOneAccount(): Promise<{ accountId: string; a: string; b: string }> {
  const [account] = await shared!.admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('acct') returning id`;
  const [a] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'ws-a') returning id`;
  const [b] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'ws-b') returning id`;
  await shared!
    .admin`insert into workspace_inference_controls (workspace_id, account_id) values (${a!.id}, ${account!.id}), (${b!.id}, ${account!.id})`;
  return { accountId: account!.id, a: a!.id, b: b!.id };
}

async function insertSessionForRig(
  ws: { accountId: string; workspaceId: string },
  rigId: string,
): Promise<string> {
  const session = await createSession(db, {
    accountId: ws.accountId,
    workspaceId: ws.workspaceId,
    initialMessage: "hello",
    resources: [],
    metadata: {},
    model: "gpt-5.6-sol",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
    rigId,
  });
  return session.id;
}

function rigProviderImage(overrides: Partial<RigProviderImage> = {}): RigProviderImage {
  const status = overrides.status ?? "building";
  return {
    backend: "modal",
    provider: "modal",
    status,
    contentHash: `sha256:${"a".repeat(64)}`,
    setupHash: `sha256:${"b".repeat(64)}`,
    sourceImage: "ubuntu:24.04",
    buildRequestId: "77777777-7777-4777-8777-777777777777",
    imageId: status === "ready" ? "im-rig-version" : null,
    imageDigest: null,
    artifactId: status === "ready" ? "66666666-6666-4666-8666-666666666666" : null,
    providerBindingKeyHash: status === "ready" ? `sha256:${"c".repeat(64)}` : null,
    ...(status === "ready"
      ? {
          coldBootValidation: {
            version: 2 as const,
            checkedAt: new Date().toISOString(),
          },
        }
      : {}),
    provenance: {
      kind: "rig_verification",
      targetKind: "version",
      targetId: "88888888-8888-4888-8888-888888888888",
    },
    startedAt: new Date().toISOString(),
    finishedAt: status === "building" ? null : new Date().toISOString(),
    error:
      status === "failed" || status === "unsupported"
        ? {
            code: `provider_image_build_${status}`,
            message: `provider image ${status}`,
            retryable: status === "failed",
          }
        : null,
    ...overrides,
  };
}

function surfaceReceipt(versionId: string, sandboxGroupId = versionId) {
  return {
    version: 1 as const,
    checkedAt: "2026-08-30T12:00:00.000Z",
    binding: {
      leaseId: "11111111-2222-4333-8444-555555555555",
      sandboxGroupId,
      leaseEpoch: 2,
      workspaceGeneration: 1,
      instanceId: "sandbox-test",
      backendId: "modal",
      rigVersionId: versionId,
    },
    terminal: {
      status: "passed" as const,
      cwd: "/workspace" as const,
      uid: 0 as const,
      bunVersion: "1.4.0" as const,
      interactive: true as const,
    },
    browser: {
      status: "passed" as const,
      browserSessionId: "22222222-3333-4444-8555-666666666666",
      controllerGeneration: "rig-test",
      targetId: "page-1",
      observedTargetGeneration: "page-generation-1",
    },
    computer: { status: "disabled" as const },
  };
}

async function passingChangePromotionVerification(input: {
  workspaceId: string;
  changeId: string;
  baseVersionId: string;
}) {
  const receipt = surfaceReceipt(input.baseVersionId, input.changeId);
  await updateRigChangeStatus(db, input.workspaceId, input.changeId, {
    status: "proposed",
    verification: {
      finishedAt: receipt.checkedAt,
      passed: true,
      platformSurfaceValidation: receipt,
    },
  });
  return {
    status: "passed" as const,
    expectedActiveVersionId: input.baseVersionId,
    verifiedAt: receipt.checkedAt,
    receipt,
    source: {
      kind: "change" as const,
      changeId: input.changeId,
      baseVersionId: input.baseVersionId,
    },
  };
}

async function registerRigProviderImageArtifact(
  ws: { accountId: string; workspaceId: string },
  versionId: string,
  imageId: string,
): Promise<{ artifactId: string; providerBindingKeyHash: string }> {
  const providerBinding = canonicalModalCheckpointProviderBinding({
    version: 1,
    serverUrl: "https://api.modal.com",
    workspaceName: "rig-provider-image-test",
    environment: "main",
  })!;
  const archive = encodeNativeSnapshotRef({
    provider: "modal_snapshot_filesystem",
    snapshotId: imageId,
    workspacePersistence: "snapshot_filesystem",
  });
  const archiveSha256 = createHash("sha256").update(archive).digest("hex");
  const capturedAt = new Date();
  const descriptor: NativeSnapshotDescriptor = {
    version: 2,
    kind: "provider_snapshot",
    revision: `wa2:${capturedAt.getTime()}:${archiveSha256}`,
    archiveSha256,
    archiveBytes: archive.length,
    capturedAt: capturedAt.toISOString(),
    provider: "modal_snapshot_filesystem",
    snapshotId: imageId,
    workspacePersistence: "snapshot_filesystem",
  };
  const artifact = await registerSandboxCheckpointArtifact(db, {
    accountId: ws.accountId,
    workspaceId: ws.workspaceId,
    sandboxGroupId: versionId,
    sourceLeaseId: randomUUID(),
    sourceLeaseEpoch: 1,
    sourceInstanceId: "sb-rig-provider-image-test",
    sourceWorkspaceGeneration: 1,
    providerBindingKey: providerBinding.key,
    providerBinding: providerBinding.binding,
    workspaceArchive: Buffer.from(archive).toString("base64"),
    workspaceArchiveMeta: descriptor,
  });
  return {
    artifactId: artifact.id,
    providerBindingKeyHash: `sha256:${createHash("sha256")
      .update(providerBinding.key, "utf8")
      .digest("hex")}`,
  };
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("rigs");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("OPENGENI_REQUIRE_REAL_DB=1 but the rig PostgreSQL harness is unavailable");
    }
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[rigs] docker unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  try {
    await client?.close();
  } catch {
    /* noop */
  }
  await shared?.release();
}, 180_000);

describe("rig CRUD lifecycle", () => {
  test("create seeds version 1 active; get/list expose active version + count", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const rig = await createRig(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      name: "dev-machine",
      description: "the stress rig",
      createdBy: "user:alice",
      initialVersion: {
        setupScript: "apt-get install -y ripgrep",
        checks: [{ name: "rg", command: "rg --version" }],
        credentialHooks: ["azure-cli-login"],
        defaultVariableSetIds: [],
        changelog: "Initial version",
        createdBy: "user:alice",
      },
    });
    expect(rig.name).toBe("dev-machine");
    expect(rig.versionCount).toBe(1);
    expect(rig.activeVersion?.version).toBe(1);
    expect(rig.activeVersion?.active).toBe(true);
    expect(rig.activeVersion?.image).toBeNull();
    expect(rig.activeVersion?.checks).toEqual([{ name: "rg", command: "rg --version" }]);

    const fetched = await getRig(db, ws.workspaceId, rig.id);
    expect(fetched?.id).toBe(rig.id);
    expect(fetched?.activeVersion?.version).toBe(1);

    const byName = await getRigByName(db, ws.workspaceId, "dev-machine");
    expect(byName?.id).toBe(rig.id);

    const listed = await listRigs(db, ws.workspaceId);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.activeVersion?.version).toBe(1);
    expect(listed[0]!.versionCount).toBe(1);

    expect(await countRigs(db, ws.workspaceId)).toBe(1);
  });

  test("rejects explicit Rig images before database access", async () => {
    const unreachableDb = undefined as unknown as Database;
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const rigId = randomUUID();
    await expect(
      createRig(unreachableDb, {
        accountId,
        workspaceId,
        name: "custom-base",
        initialVersion: { image: "ubuntu:24.04" },
      }),
    ).rejects.toBeInstanceOf(RigImageOverrideUnsupportedError);

    await expect(
      createRigVersion(unreachableDb, workspaceId, rigId, { image: "ubuntu:24.04" }),
    ).rejects.toBeInstanceOf(RigImageOverrideUnsupportedError);
  });

  test("rejects explicit Rig images at the storage boundary", async () => {
    if (!available) return;
    let rejection: unknown;
    try {
      await shared!.admin.begin(async (transaction) => {
        await transaction`select set_config('statement_timeout', '5s', true)`;
        await transaction`
          insert into rig_versions(account_id, workspace_id, rig_id, version, image)
          values (${randomUUID()}, ${randomUUID()}, ${randomUUID()}, 1, 'ubuntu:24.04')
        `;
      });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toMatchObject({
      code: "23514",
      constraint_name: "rig_versions_platform_base_only",
    });
    expect((rejection as Error).message).toContain("Rig image overrides are unsupported");
  });

  test("update touches name/description only; delete removes the rig + versions", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const rig = await createRig(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      name: "r1",
    });
    const updated = await updateRig(db, ws.workspaceId, rig.id, {
      name: "r1-renamed",
      description: "now described",
    });
    expect(updated.name).toBe("r1-renamed");
    expect(updated.description).toBe("now described");
    // The active version is untouched by an update.
    expect(updated.activeVersion?.version).toBe(1);

    expect(await deleteRig(db, ws.workspaceId, rig.id)).toBe(true);
    expect(await getRig(db, ws.workspaceId, rig.id)).toBeNull();
    // Versions cascade with the rig.
    const [{ count } = { count: 0 }] = await shared!.admin<{ count: number }[]>`
      select count(*)::int as count from rig_versions where rig_id = ${rig.id}`;
    expect(Number(count)).toBe(0);
  });
});

describe("rig version invariants", () => {
  test("pending initial/direct versions activate only after an exact receipt", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const rig = await createRig(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      name: "verified-activation",
      initialVerification: {
        status: "pending",
        expectedActiveVersionId: null,
        requestedAt: "2026-08-30T12:00:00.000Z",
      },
      activateInitialVersion: false,
    });
    expect(rig.activeVersion).toBeNull();
    const [v1] = await listRigVersions(db, ws.workspaceId, rig.id);
    expect(v1?.active).toBe(false);

    const initial = await completeRigVersionVerification(db, {
      workspaceId: ws.workspaceId,
      rigId: rig.id,
      versionId: v1!.id,
      receipt: surfaceReceipt(v1!.id),
    });
    expect(initial).toMatchObject({ activated: true, stale: false });
    expect((await getRig(db, ws.workspaceId, rig.id))?.activeVersion?.id).toBe(v1!.id);

    const v2 = await createRigVersion(
      db,
      ws.workspaceId,
      rig.id,
      { setupScript: "echo v2" },
      {
        verification: {
          status: "pending",
          expectedActiveVersionId: v1!.id,
          requestedAt: "2026-08-30T12:01:00.000Z",
        },
      },
    );
    await failRigVersionVerification(db, {
      workspaceId: ws.workspaceId,
      rigId: rig.id,
      versionId: v2.id,
      error: "browser unsupported",
    });
    expect((await getRigVersionById(db, ws.workspaceId, v2.id))?.active).toBe(false);
    expect((await getRig(db, ws.workspaceId, rig.id))?.activeVersion?.id).toBe(v1!.id);

    const direct = await completeRigVersionVerification(db, {
      workspaceId: ws.workspaceId,
      rigId: rig.id,
      versionId: v2.id,
      receipt: surfaceReceipt(v2.id),
    });
    expect(direct).toMatchObject({ activated: true, stale: false });
    expect((await getRig(db, ws.workspaceId, rig.id))?.activeVersion?.id).toBe(v2.id);
  });

  test("a passing receipt stays inactive when the active-version CAS is stale", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const rig = await createRig(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      name: "stale-verified-activation",
    });
    const v1 = rig.activeVersion!;
    const pending = await createRigVersion(
      db,
      ws.workspaceId,
      rig.id,
      { setupScript: "echo pending" },
      {
        verification: {
          status: "pending",
          expectedActiveVersionId: v1.id,
          requestedAt: "2026-08-30T12:00:00.000Z",
        },
      },
    );
    const newer = await createRigVersion(
      db,
      ws.workspaceId,
      rig.id,
      { setupScript: "echo newer" },
      { activate: true },
    );
    const completed = await completeRigVersionVerification(db, {
      workspaceId: ws.workspaceId,
      rigId: rig.id,
      versionId: pending.id,
      receipt: surfaceReceipt(pending.id),
    });
    expect(completed).toMatchObject({ activated: false, stale: true });
    expect((await getRigVersionById(db, ws.workspaceId, pending.id))?.active).toBe(false);
    expect((await getRig(db, ws.workspaceId, rig.id))?.activeVersion?.id).toBe(newer.id);
  });

  test("version verification attempts are single-flight and fence late terminal writes", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const rig = await createRig(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      name: "verification-attempt-fence",
    });
    const versionId = rig.activeVersion!.id;

    const first = await beginRigVersionVerificationAttempt(db, {
      workspaceId: ws.workspaceId,
      versionId,
      requestedAt: "2026-08-30T12:10:00.000Z",
    });
    const duplicate = await beginRigVersionVerificationAttempt(db, {
      workspaceId: ws.workspaceId,
      versionId,
      requestedAt: "2026-08-30T12:11:00.000Z",
    });
    expect(first).toMatchObject({ attempt: 1, alreadyPending: false });
    expect(duplicate).toMatchObject({ attempt: 1, alreadyPending: true });

    expect(
      await failRigVersionVerification(db, {
        workspaceId: ws.workspaceId,
        rigId: rig.id,
        versionId,
        attempt: first.attempt,
        verifiedAt: "2026-08-30T12:12:00.000Z",
        error: "first attempt failed",
      }),
    ).toBe(true);
    const retry = await beginRigVersionVerificationAttempt(db, {
      workspaceId: ws.workspaceId,
      versionId,
      requestedAt: "2026-08-30T12:13:00.000Z",
    });
    expect(retry).toMatchObject({ attempt: 2, alreadyPending: false });

    const completed = await completeRigVersionVerification(db, {
      workspaceId: ws.workspaceId,
      rigId: rig.id,
      versionId,
      attempt: retry.attempt,
      verifiedAt: "2026-08-30T12:14:00.000Z",
      receipt: surfaceReceipt(versionId),
    });
    expect(completed).toMatchObject({ activated: true, stale: false, superseded: false });

    expect(
      await failRigVersionVerification(db, {
        workspaceId: ws.workspaceId,
        rigId: rig.id,
        versionId,
        attempt: first.attempt,
        verifiedAt: "2026-08-30T12:15:00.000Z",
        error: "late first-attempt failure",
      }),
    ).toBe(false);
    expect(
      await completeRigVersionVerification(db, {
        workspaceId: ws.workspaceId,
        rigId: rig.id,
        versionId,
        attempt: first.attempt,
        verifiedAt: "2026-08-30T12:16:00.000Z",
        receipt: surfaceReceipt(versionId),
      }),
    ).toMatchObject({ activated: false, superseded: true });

    const [stored] = await shared!.admin<
      { verification: { status: string; attempt?: number }; active: boolean }[]
    >`select verification, active from rig_versions where id = ${versionId}`;
    expect(stored).toMatchObject({
      verification: { status: "passed", attempt: 2 },
      active: true,
    });
  });

  test("verification state and activation roll back when the passing audit cannot commit", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const rig = await createRig(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      name: "verification-audit-atomicity",
    });
    const originalActiveId = rig.activeVersion!.id;
    const candidate = await createRigVersion(
      db,
      ws.workspaceId,
      rig.id,
      { setupScript: "echo candidate" },
      {
        verification: {
          status: "pending",
          attempt: 1,
          expectedActiveVersionId: originalActiveId,
          requestedAt: "2026-08-30T12:20:00.000Z",
        },
      },
    );

    await shared!.admin.unsafe(`
      create or replace function opengeni_test_fail_rig_verification_audit()
      returns trigger language plpgsql as $$
      begin
        if new.action = 'rig.verification.passed' then
          raise exception 'synthetic Rig verification audit failure';
        end if;
        return new;
      end
      $$;
      create trigger opengeni_test_fail_rig_verification_audit
      before insert on audit_events
      for each row execute function opengeni_test_fail_rig_verification_audit();
    `);
    try {
      let completionFailure: unknown;
      try {
        await completeRigVersionVerification(db, {
          workspaceId: ws.workspaceId,
          rigId: rig.id,
          versionId: candidate.id,
          attempt: 1,
          verifiedAt: "2026-08-30T12:21:00.000Z",
          receipt: surfaceReceipt(candidate.id),
          audit: {
            subjectId: "system:rig-verification",
            metadata: {
              versionId: candidate.id,
              passed: true,
            },
          },
        });
      } catch (error) {
        completionFailure = error;
      }
      expect(completionFailure).toBeInstanceOf(Error);
      expect(nestedPostgresSqlState(completionFailure)).toBe("P0001");

      expect((await getRig(db, ws.workspaceId, rig.id))?.activeVersion?.id).toBe(originalActiveId);
      const afterRollback = await shared!.admin<
        { verification: { status: string; attempt?: number }; active: boolean }[]
      >`select verification, active from rig_versions where id = ${candidate.id}`;
      expect(afterRollback[0]).toMatchObject({
        verification: { status: "pending", attempt: 1 },
        active: false,
      });

      expect(
        await failRigVersionVerification(db, {
          workspaceId: ws.workspaceId,
          rigId: rig.id,
          versionId: candidate.id,
          attempt: 1,
          verifiedAt: "2026-08-30T12:22:00.000Z",
          error: "passing audit did not commit",
          audit: {
            subjectId: "system:rig-verification",
            metadata: {
              versionId: candidate.id,
              passed: false,
            },
          },
        }),
      ).toBe(true);
      expect((await getRig(db, ws.workspaceId, rig.id))?.activeVersion?.id).toBe(originalActiveId);
      const afterFailure = await shared!.admin<
        { verification: { status: string; attempt?: number }; active: boolean }[]
      >`select verification, active from rig_versions where id = ${candidate.id}`;
      expect(afterFailure[0]).toMatchObject({
        verification: { status: "failed", attempt: 1 },
        active: false,
      });
    } finally {
      await shared!.admin.unsafe(`
        drop trigger if exists opengeni_test_fail_rig_verification_audit on audit_events;
        drop function if exists opengeni_test_fail_rig_verification_audit();
      `);
    }
  });

  test("createRigVersion mints strictly-monotonic versions under concurrency", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const rig = await createRig(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      name: "monotonic",
    });
    // 8 concurrent mints. The per-rig row lock must serialize numbering.
    const results = await Promise.all(
      Array.from({ length: 8 }, (_unused, i) =>
        createRigVersion(db, ws.workspaceId, rig.id, { setupScript: `echo ${i}` }),
      ),
    );
    const versions = results.map((v) => v.version).sort((a, b) => a - b);
    // Version 1 was minted by createRig; the 8 new ones are 2..9, all distinct.
    expect(versions).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(new Set(versions).size).toBe(8);
  });

  test("concurrent activation ends with EXACTLY one active version", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const rig = await createRig(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      name: "single-active",
    });
    const v2 = await createRigVersion(db, ws.workspaceId, rig.id, { setupScript: "echo 2" });
    const v3 = await createRigVersion(db, ws.workspaceId, rig.id, { setupScript: "echo 3" });
    const v1 = (await listRigVersions(db, ws.workspaceId, rig.id)).find((v) => v.version === 1)!;

    // Race three activations. The per-rig lock + partial unique index guarantee
    // a single active winner, never a violation.
    await Promise.all([
      activateRigVersion(db, ws.workspaceId, rig.id, v1.id),
      activateRigVersion(db, ws.workspaceId, rig.id, v2.id),
      activateRigVersion(db, ws.workspaceId, rig.id, v3.id),
    ]);

    const [{ count } = { count: 0 }] = await shared!.admin<{ count: number }[]>`
      select count(*)::int as count from rig_versions where rig_id = ${rig.id} and active`;
    expect(Number(count)).toBe(1);

    const refreshed = await getRig(db, ws.workspaceId, rig.id);
    expect(refreshed?.activeVersion).not.toBeNull();
    expect(refreshed?.versionCount).toBe(3);
  });

  test("activation flips only `active` — version content is immutable", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const rig = await createRig(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      name: "immutable",
      initialVersion: {
        setupScript: "setup-one",
        checks: [{ name: "c", command: "true" }],
      },
    });
    const v1Id = rig.activeVersion!.id;
    const before = await getRigVersion(db, ws.workspaceId, rig.id, v1Id);
    const v2 = await createRigVersion(
      db,
      ws.workspaceId,
      rig.id,
      { setupScript: "setup-two" },
      { activate: true },
    );

    // v1 is now inactive but its CONTENT is byte-identical to before.
    const afterV1 = await getRigVersion(db, ws.workspaceId, rig.id, v1Id);
    expect(afterV1?.active).toBe(false);
    expect(afterV1?.image).toBeNull();
    expect(afterV1?.setupScript).toBe(before!.setupScript);
    expect(afterV1?.checks).toEqual(before!.checks);
    expect(afterV1?.version).toBe(before!.version);

    // Re-activating v1 (rollback) still never mutates content.
    await activateRigVersion(db, ws.workspaceId, rig.id, v1Id);
    const rolledBack = await getRigVersion(db, ws.workspaceId, rig.id, v1Id);
    expect(rolledBack?.active).toBe(true);
    expect(rolledBack?.setupScript).toBe("setup-one");
    const v2After = await getRigVersion(db, ws.workspaceId, rig.id, v2.id);
    expect(v2After?.active).toBe(false);
    expect(v2After?.setupScript).toBe("setup-two");

    // Proof the immutability is a domain property, not a DB constraint: a raw
    // admin (RLS-bypassing) UPDATE CAN change content — nothing in the domain
    // layer ever issues such a write.
    await shared!.admin`update rig_versions set setup_script = 'tampered' where id = ${v1Id}`;
    const tampered = await getRigVersion(db, ws.workspaceId, rig.id, v1Id);
    expect(tampered?.setupScript).toBe("tampered");
  });
});

describe("rig provider image build ledger", () => {
  test("claims one build, reuses one finalized image, and rejects planted setup drift", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const rig = await createRig(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      name: "provider-image-ledger",
      initialVersion: { setupScript: "echo ready" },
    });
    const versionId = rig.activeVersion!.id;
    const building = rigProviderImage({
      provenance: {
        kind: "rig_verification",
        targetKind: "version",
        targetId: versionId,
      },
    });

    const first = await claimRigVersionProviderImageBuild(db, {
      workspaceId: ws.workspaceId,
      versionId,
      image: building,
      staleAfterMs: 60_000,
    });
    expect(first.status).toBe("claimed");
    const duplicate = await claimRigVersionProviderImageBuild(db, {
      workspaceId: ws.workspaceId,
      versionId,
      image: building,
      staleAfterMs: 60_000,
    });
    expect(duplicate.status).toBe("in_progress");

    const artifact = await registerRigProviderImageArtifact(ws, versionId, "im-rig-version");
    const ready = rigProviderImage({
      ...first.image,
      status: "ready",
      imageId: "im-rig-version",
      artifactId: artifact.artifactId,
      providerBindingKeyHash: artifact.providerBindingKeyHash,
      finishedAt: new Date().toISOString(),
      error: null,
    });
    expect(
      await finalizeRigVersionProviderImageBuild(db, {
        workspaceId: ws.workspaceId,
        versionId,
        image: ready,
      }),
    ).toBe(true);

    const stored = await getRigVersionById(db, ws.workspaceId, versionId);
    expect(stored?.providerImages.modal).toEqual(ready);
    const reuse = await claimRigVersionProviderImageBuild(db, {
      workspaceId: ws.workspaceId,
      versionId,
      image: building,
      staleAfterMs: 60_000,
    });
    expect(reuse).toEqual({ status: "ready", image: ready });

    const plantedDrift = rigProviderImage({
      ...building,
      contentHash: `sha256:${"d".repeat(64)}`,
      setupHash: `sha256:${"e".repeat(64)}`,
      buildRequestId: "99999999-9999-4999-8999-999999999999",
    });
    const conflict = await claimRigVersionProviderImageBuild(db, {
      workspaceId: ws.workspaceId,
      versionId,
      image: plantedDrift,
      staleAfterMs: 60_000,
    });
    expect(conflict).toEqual({ status: "conflict", image: ready });
    expect(
      await finalizeRigVersionProviderImageBuild(db, {
        workspaceId: ws.workspaceId,
        versionId,
        image: rigProviderImage({
          ...plantedDrift,
          status: "ready",
          imageId: "im-planted",
          artifactId: randomUUID(),
          providerBindingKeyHash: `sha256:${"c".repeat(64)}`,
          finishedAt: new Date().toISOString(),
          error: null,
        }),
      }),
    ).toBe(false);
    expect((await getRigVersionById(db, ws.workspaceId, versionId))?.providerImages.modal).toEqual(
      ready,
    );

    expect(
      await markSandboxCheckpointArtifactDeletePending(db, {
        accountId: ws.accountId,
        workspaceId: ws.workspaceId,
        artifactId: artifact.artifactId,
        reason: "must remain protected while the rig version is ready",
      }),
    ).toBe(false);

    expect(await deleteRig(db, ws.workspaceId, rig.id)).toBe(true);
    expect(
      await markSandboxCheckpointArtifactDeletePending(db, {
        accountId: ws.accountId,
        workspaceId: ws.workspaceId,
        artifactId: artifact.artifactId,
        reason: "rig deleted",
      }),
    ).toBe(true);
    const orphanClaims = await claimSandboxCheckpointArtifactsForGc(db, {
      claimId: randomUUID(),
      limit: 10,
      claimTtlMs: 60_000,
    });
    expect(orphanClaims.some((claim) => claim.id === artifact.artifactId)).toBe(true);
  });

  test("rebuilds operational provider metadata when the deployment base rotates", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const rig = await createRig(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      name: "provider-image-base-rotation",
      initialVersion: { setupScript: "echo ready" },
    });
    const versionId = rig.activeVersion!.id;
    const firstBuild = rigProviderImage({
      provenance: {
        kind: "rig_verification",
        targetKind: "version",
        targetId: versionId,
      },
    });
    const firstClaim = await claimRigVersionProviderImageBuild(db, {
      workspaceId: ws.workspaceId,
      versionId,
      image: firstBuild,
      staleAfterMs: 60_000,
    });
    expect(firstClaim.status).toBe("claimed");
    const oldArtifact = await registerRigProviderImageArtifact(ws, versionId, "im-old-base");
    const oldReady = rigProviderImage({
      ...firstClaim.image,
      status: "ready",
      imageId: "im-old-base",
      artifactId: oldArtifact.artifactId,
      providerBindingKeyHash: oldArtifact.providerBindingKeyHash,
      finishedAt: new Date().toISOString(),
      error: null,
    });
    expect(
      await finalizeRigVersionProviderImageBuild(db, {
        workspaceId: ws.workspaceId,
        versionId,
        image: oldReady,
      }),
    ).toBe(true);

    const rotatedBuild = rigProviderImage({
      ...firstBuild,
      sourceImage: "ubuntu:24.04@sha256:new-base",
      contentHash: `sha256:${"d".repeat(64)}`,
      buildRequestId: "99999999-9999-4999-8999-999999999999",
      startedAt: new Date().toISOString(),
    });
    const rotation = await claimRigVersionProviderImageBuild(db, {
      workspaceId: ws.workspaceId,
      versionId,
      image: rotatedBuild,
      staleAfterMs: 60_000,
    });
    expect(rotation).toEqual({ status: "claimed", image: rotatedBuild });
    expect((await getRigVersionById(db, ws.workspaceId, versionId))?.providerImages.modal).toEqual(
      rotatedBuild,
    );
    expect(
      await finalizeRigVersionProviderImageBuild(db, {
        workspaceId: ws.workspaceId,
        versionId,
        image: oldReady,
      }),
    ).toBe(false);
    expect(
      await markSandboxCheckpointArtifactDeletePending(db, {
        accountId: ws.accountId,
        workspaceId: ws.workspaceId,
        artifactId: oldArtifact.artifactId,
        reason: "deployment base rotated",
      }),
    ).toBe(true);
  });

  test("rejects a ready image that has no exact artifact ownership row", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const rig = await createRig(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      name: "provider-image-missing-artifact",
      initialVersion: { setupScript: "echo ready" },
    });
    const versionId = rig.activeVersion!.id;
    const building = rigProviderImage({
      provenance: {
        kind: "rig_verification",
        targetKind: "version",
        targetId: versionId,
      },
    });
    const claim = await claimRigVersionProviderImageBuild(db, {
      workspaceId: ws.workspaceId,
      versionId,
      image: building,
      staleAfterMs: 60_000,
    });
    expect(claim.status).toBe("claimed");

    expect(
      await finalizeRigVersionProviderImageBuild(db, {
        workspaceId: ws.workspaceId,
        versionId,
        image: rigProviderImage({
          ...claim.image,
          status: "ready",
          imageId: "im-unowned",
          artifactId: randomUUID(),
          providerBindingKeyHash: `sha256:${"c".repeat(64)}`,
          finishedAt: new Date().toISOString(),
          error: null,
        }),
      }),
    ).toBe(false);
    expect((await getRigVersionById(db, ws.workspaceId, versionId))?.providerImages.modal).toEqual(
      claim.image,
    );
  });

  test("a legacy ready image is rebuilt under the current cold-boot protocol", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const rig = await createRig(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      name: "provider-image-cold-boot-upgrade",
    });
    const versionId = rig.activeVersion!.id;
    const legacyBuild = rigProviderImage({
      buildRequestId: "77777777-7777-4777-8777-777777777777",
      provenance: {
        kind: "rig_verification",
        targetKind: "version",
        targetId: versionId,
      },
    });
    const claim = await claimRigVersionProviderImageBuild(db, {
      workspaceId: ws.workspaceId,
      versionId,
      image: legacyBuild,
      staleAfterMs: 60_000,
    });
    expect(claim.status).toBe("claimed");
    const artifact = await registerRigProviderImageArtifact(ws, versionId, "im-legacy-rig");
    const legacyReady = rigProviderImage({
      ...claim.image,
      status: "ready",
      imageId: "im-legacy-rig",
      artifactId: artifact.artifactId,
      providerBindingKeyHash: artifact.providerBindingKeyHash,
      coldBootValidation: {
        version: 1,
        checkedAt: new Date().toISOString(),
      },
      finishedAt: new Date().toISOString(),
      error: null,
    });
    expect(
      await finalizeRigVersionProviderImageBuild(db, {
        workspaceId: ws.workspaceId,
        versionId,
        image: legacyReady,
      }),
    ).toBe(true);

    const currentBuild = rigProviderImage({
      ...legacyBuild,
      buildRequestId: "88888888-8888-4888-8888-888888888888",
      startedAt: new Date().toISOString(),
    });
    const upgrade = await claimRigVersionProviderImageBuild(db, {
      workspaceId: ws.workspaceId,
      versionId,
      image: currentBuild,
      staleAfterMs: 60_000,
    });
    expect(upgrade.status).toBe("claimed");
    expect(upgrade.image.buildRequestId).toBe(currentBuild.buildRequestId);
    expect(upgrade.image.coldBootValidation).toBeUndefined();
  });

  test("an unsupported record retries only after the caller proves provider support", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const rig = await createRig(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      name: "provider-image-capability-upgrade",
    });
    const versionId = rig.activeVersion!.id;
    const building = rigProviderImage({
      provenance: {
        kind: "rig_verification",
        targetKind: "version",
        targetId: versionId,
      },
    });
    const claim = await claimRigVersionProviderImageBuild(db, {
      workspaceId: ws.workspaceId,
      versionId,
      image: building,
      staleAfterMs: 60_000,
    });
    expect(claim.status).toBe("claimed");
    const unsupported = rigProviderImage({
      ...claim.image,
      status: "unsupported",
      finishedAt: new Date().toISOString(),
      error: {
        code: "provider_image_build_unsupported",
        message: "not supported yet",
        retryable: false,
      },
    });
    expect(
      await finalizeRigVersionProviderImageBuild(db, {
        workspaceId: ws.workspaceId,
        versionId,
        image: unsupported,
      }),
    ).toBe(true);

    const stillUnsupported = await claimRigVersionProviderImageBuild(db, {
      workspaceId: ws.workspaceId,
      versionId,
      image: building,
      staleAfterMs: 60_000,
    });
    expect(stillUnsupported).toEqual({ status: "unsupported", image: unsupported });

    const upgraded = await claimRigVersionProviderImageBuild(db, {
      workspaceId: ws.workspaceId,
      versionId,
      image: { ...building, startedAt: new Date().toISOString() },
      staleAfterMs: 60_000,
      retryUnsupported: true,
    });
    expect(upgraded.status).toBe("claimed");
    expect(upgraded.image.buildRequestId).toBe(unsupported.buildRequestId);
  });
});

describe("rig change lifecycle", () => {
  test("create + list + get + guarded status transitions", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const rig = await createRig(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      name: "changes",
    });
    const change = await createRigChange(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      rigId: rig.id,
      baseVersionId: rig.activeVersion!.id,
      kind: "setup_append",
      payload: { command: "apt-get install -y jq", note: "need jq" },
      proposedBy: "session:s1",
    });
    expect(change.status).toBe("proposed");
    expect(change.kind).toBe("setup_append");

    const listed = await listRigChanges(db, ws.workspaceId, rig.id);
    expect(listed).toHaveLength(1);
    const got = await getRigChange(db, ws.workspaceId, change.id);
    expect(got?.id).toBe(change.id);

    // proposed -> verifying -> merged, with verification merge.
    const verifying = await updateRigChangeStatus(db, ws.workspaceId, change.id, {
      status: "verifying",
      verification: { startedAt: "2026-07-08T00:00:00.000Z" },
    });
    expect(verifying.status).toBe("verifying");
    const merged = await updateRigChangeStatus(db, ws.workspaceId, change.id, {
      status: "merged",
      verification: { finishedAt: "2026-07-08T00:01:00.000Z" },
      resultVersionId: null,
    });
    expect(merged.status).toBe("merged");
    // Verification payloads are shallow-merged across bumps.
    expect(merged.verification).toMatchObject({
      startedAt: "2026-07-08T00:00:00.000Z",
      finishedAt: "2026-07-08T00:01:00.000Z",
    });

    // merged is terminal.
    await expect(
      updateRigChangeStatus(db, ws.workspaceId, change.id, { status: "rejected" }),
    ).rejects.toBeInstanceOf(RigChangeTransitionError);
    await expect(
      updateRigChangeStatus(db, ws.workspaceId, change.id, { status: "merged" }),
    ).rejects.toBeInstanceOf(RigChangeTransitionError);
  });

  test("change promotion rejects a stale active base without minting", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const rig = await createRig(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      name: "stale-base",
    });
    const baseVersionId = rig.activeVersion!.id;
    const change = await createRigChange(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      rigId: rig.id,
      baseVersionId,
      kind: "setup_append",
      payload: { command: "touch /opt/tool" },
      proposedBy: "session:s1",
    });
    const verification = await passingChangePromotionVerification({
      workspaceId: ws.workspaceId,
      changeId: change.id,
      baseVersionId,
    });
    await createRigVersion(
      db,
      ws.workspaceId,
      rig.id,
      { setupScript: "new active" },
      { activate: true },
    );

    await expect(
      createRigVersionForChangePromotion(db, ws.workspaceId, rig.id, change.id, {
        expectedActiveVersionId: baseVersionId,
        setupScript: "base plus append",
        verification,
      }),
    ).rejects.toBeInstanceOf(RigActiveVersionChangedError);

    const versions = await listRigVersions(db, ws.workspaceId, rig.id);
    expect(versions).toHaveLength(2);
    expect((await getRigChange(db, ws.workspaceId, change.id))?.status).toBe("proposed");
  });

  test("concurrent change promotion mints exactly one version", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const rig = await createRig(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      name: "one-promote",
    });
    const baseVersionId = rig.activeVersion!.id;
    const change = await createRigChange(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      rigId: rig.id,
      baseVersionId,
      kind: "definition_edit",
      payload: { setupScript: "echo v2" },
      proposedBy: "user:m",
    });
    const verification = await passingChangePromotionVerification({
      workspaceId: ws.workspaceId,
      changeId: change.id,
      baseVersionId,
    });

    const promote = () =>
      createRigVersionForChangePromotion(db, ws.workspaceId, rig.id, change.id, {
        expectedActiveVersionId: baseVersionId,
        setupScript: "echo v2",
        changelog: "verified edit",
        verification,
      });
    const results = await Promise.allSettled([promote(), promote()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

    const versions = await listRigVersions(db, ws.workspaceId, rig.id);
    expect(versions).toHaveLength(2);
    const stored = await getRigChange(db, ws.workspaceId, change.id);
    expect(stored?.status).toBe("merged");
    expect(stored?.resultVersionId).toBe(
      (
        results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<{
          version: { id: string };
        }>
      ).value.version.id,
    );
  });

  test("promoted versions retain truthful change receipts for rollback activation", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const rig = await createRig(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      name: "promotion-receipt-linkage",
    });
    const baseVersionId = rig.activeVersion!.id;
    const change = await createRigChange(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      rigId: rig.id,
      baseVersionId,
      kind: "definition_edit",
      payload: { setupScript: "echo promoted" },
      proposedBy: "user:m",
    });
    const verification = await passingChangePromotionVerification({
      workspaceId: ws.workspaceId,
      changeId: change.id,
      baseVersionId,
    });

    await expect(
      createRigVersionForChangePromotion(db, ws.workspaceId, rig.id, change.id, {
        expectedActiveVersionId: baseVersionId,
        setupScript: "echo promoted",
        verification: {
          ...verification,
          receipt: {
            ...verification.receipt,
            checkedAt: "2026-08-30T12:00:01.000Z",
          },
        },
      }),
    ).rejects.toThrow("Rig change promotion receipt no longer matches the verified change");

    const promoted = await createRigVersionForChangePromotion(
      db,
      ws.workspaceId,
      rig.id,
      change.id,
      {
        expectedActiveVersionId: baseVersionId,
        setupScript: "echo promoted",
        verification,
      },
    );
    const newer = await createRigVersion(
      db,
      ws.workspaceId,
      rig.id,
      { setupScript: "echo newer" },
      { activate: true },
    );

    await expect(
      activateRigVersion(db, ws.workspaceId, rig.id, promoted.version.id, {
        requireVerification: true,
      }),
    ).resolves.toMatchObject({ id: promoted.version.id, active: true });
    await activateRigVersion(db, ws.workspaceId, rig.id, newer.id);

    await shared!.admin`
      update rig_versions
      set verification = jsonb_set(
        verification,
        '{receipt,checkedAt}',
        to_jsonb(${"2026-08-30T12:00:02.000Z"}::text),
        false
      )
      where id = ${promoted.version.id}
    `;
    await expect(
      activateRigVersion(db, ws.workspaceId, rig.id, promoted.version.id, {
        requireVerification: true,
      }),
    ).rejects.toBeInstanceOf(RigVersionVerificationRequiredError);
    expect((await getRig(db, ws.workspaceId, rig.id))?.activeVersion?.id).toBe(newer.id);
  });

  test("list/get expose active version verification health", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const neverVerified = await createRig(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      name: "health-unknown",
    });
    const verifiedRig = await createRig(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      name: "health-passing",
      initialVersion: { setupScript: "mkdir -p /opt/health" },
    });
    const change = await createRigChange(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      rigId: verifiedRig.id,
      baseVersionId: verifiedRig.activeVersion!.id,
      kind: "setup_append",
      payload: { command: "touch /opt/health/tool" },
      proposedBy: "session:s1",
    });
    const verification = await passingChangePromotionVerification({
      workspaceId: ws.workspaceId,
      changeId: change.id,
      baseVersionId: verifiedRig.activeVersion!.id,
    });
    const promoted = await createRigVersionForChangePromotion(
      db,
      ws.workspaceId,
      verifiedRig.id,
      change.id,
      {
        expectedActiveVersionId: verifiedRig.activeVersion!.id,
        setupScript: "mkdir -p /opt/health\ntouch /opt/health/tool",
        verification,
      },
    );

    const listed = await listRigs(db, ws.workspaceId);
    expect(listed.find((rig) => rig.id === neverVerified.id)?.activeVersionHealth).toEqual({
      checkHealth: "unknown",
      lastVerifiedAt: null,
    });
    expect(listed.find((rig) => rig.id === verifiedRig.id)?.activeVersion?.id).toBe(
      promoted.version.id,
    );
    expect(listed.find((rig) => rig.id === verifiedRig.id)?.activeVersionHealth).toEqual({
      checkHealth: "passing",
      lastVerifiedAt: "2026-08-30T12:00:00.000Z",
    });
    expect(
      (await getRig(db, ws.workspaceId, verifiedRig.id))?.activeVersionHealth?.checkHealth,
    ).toBe("passing");
  });

  test("ordinary reads use the trusted audit occurrence time for rig health", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const rig = await createRig(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      name: "health-audit-occurrence",
    });
    const versionId = rig.activeVersion!.id;
    const occurredAt = "2026-08-29T18:16:47.181Z";
    await shared!.admin`
      insert into audit_events (
        account_id, workspace_id, subject_id, action, target_type, target_id,
        metadata, occurred_at
      ) values (
        ${ws.accountId}, ${ws.workspaceId}, 'system:rig-verification',
        'rig.verification.passed', 'rig', ${rig.id},
        ${shared!.admin.json({
          rigId: rig.id,
          versionId,
          finishedAt: "malformed-untrusted-audit-metadata",
          passed: true,
        })}::jsonb,
        ${occurredAt}::timestamptz
      )
    `;

    const expectedHealth = {
      checkHealth: "passing" as const,
      lastVerifiedAt: occurredAt,
    };
    expect(
      (await listRigs(db, ws.workspaceId)).find((listedRig) => listedRig.id === rig.id)
        ?.activeVersionHealth,
    ).toEqual(expectedHealth);
    expect((await getRig(db, ws.workspaceId, rig.id))?.activeVersionHealth).toEqual(expectedHealth);
    expect((await getRigByName(db, ws.workspaceId, rig.name))?.activeVersionHealth).toEqual(
      expectedHealth,
    );
    expect(await getRigVersionHealth(db, ws.workspaceId, rig.id, versionId)).toEqual(
      expectedHealth,
    );
  });
});

describe("rig delete guard", () => {
  test("countSessionsUsingRig reflects referencing sessions", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const rig = await createRig(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      name: "referenced",
    });
    expect(await countSessionsUsingRig(db, ws.workspaceId, rig.id)).toBe(0);
    await insertSessionForRig(ws, rig.id);
    expect(await countSessionsUsingRig(db, ws.workspaceId, rig.id)).toBe(1);
  });

  test("deleteRigIfNoActiveSessions refuses active sessions under the rig lock", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const rig = await createRig(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      name: "active-ref",
    });
    const sessionId = await insertSessionForRig(ws, rig.id);
    expect(await deleteRigIfNoActiveSessions(db, ws.workspaceId, rig.id)).toEqual({
      deleted: false,
      activeSessionCount: 1,
    });
    expect(await getRig(db, ws.workspaceId, rig.id)).not.toBeNull();

    await withWorkspaceSessionActivityRls(db, ws.workspaceId, async (tx) => {
      await tx.execute(
        sql`update sessions set status = 'cancelled', updated_at = now() where workspace_id = ${ws.workspaceId} and id = ${sessionId}`,
      );
    });
    expect(await deleteRigIfNoActiveSessions(db, ws.workspaceId, rig.id)).toEqual({
      deleted: true,
      activeSessionCount: 0,
    });
    expect(await getRig(db, ws.workspaceId, rig.id)).toBeNull();
  });
});

describe("rig RLS isolation", () => {
  test("workspace B cannot see or mutate workspace A's rig", async () => {
    if (!available) return;
    const { accountId, a, b } = await twoWorkspacesOneAccount();
    const rigA = await createRig(db, { accountId, workspaceId: a, name: "secret-rig" });

    // B sees none of A's rigs.
    expect(await listRigs(db, b)).toHaveLength(0);
    // Addressing A's rig id under B's scope is indistinguishable from missing.
    expect(await getRig(db, b, rigA.id)).toBeNull();
    expect(await getRigByName(db, b, "secret-rig")).toBeNull();
    // A mutation under B's scope hits zero RLS-visible rows -> not found.
    await expect(updateRig(db, b, rigA.id, { name: "hijacked" })).rejects.toThrow();
    await expect(activateRigVersion(db, b, rigA.id, rigA.activeVersion!.id)).rejects.toThrow();
    expect(await deleteRig(db, b, rigA.id)).toBe(false);

    // A still sees its rig, unchanged.
    const stillThere = await getRig(db, a, rigA.id);
    expect(stillThere?.name).toBe("secret-rig");
  });
});
