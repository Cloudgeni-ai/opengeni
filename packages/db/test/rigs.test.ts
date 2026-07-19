import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  activateRigVersion,
  countRigs,
  countSessionsUsingRig,
  createDb,
  createRig,
  createRigChange,
  createRigChangeWithIdempotencyKey,
  createRigVersion,
  createRigVersionForChangePromotion,
  deleteRig,
  deleteRigIfNoActiveSessions,
  getRig,
  getRigByName,
  getRigChange,
  getRigVersion,
  listRigChanges,
  listRigVersions,
  listRigs,
  RigActiveVersionChangedError,
  RigChangeTransitionError,
  RigChangeIdempotencyConflictError,
  RigVerificationAttemptChangedError,
  beginRigChangeVerificationAttempt,
  settleRigChangeVerificationAttempt,
  updateRig,
  updateRigChangeStatus,
  type Database,
  type DbClient,
} from "../src/index";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let db: Database;

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
  const [row] = await shared!.admin<{ id: string }[]>`
    insert into sessions (account_id, workspace_id, initial_message, model, sandbox_backend, sandbox_group_id, rig_id)
    values (${ws.accountId}, ${ws.workspaceId}, 'hello', 'gpt-5.6-sol', 'none', gen_random_uuid(), ${rigId})
    returning id`;
  return row!.id;
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("rigs");
  if (!shared) {
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
        image: "ubuntu:24.04",
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
    expect(rig.activeVersion?.image).toBe("ubuntu:24.04");
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
    expect(listed[0]!.activeVersionHealth?.checkHealth).toBe("unknown");

    expect(await countRigs(db, ws.workspaceId)).toBe(1);
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
        image: "img:1",
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
      { image: "img:2", setupScript: "setup-two" },
      { activate: true },
    );

    // v1 is now inactive but its CONTENT is byte-identical to before.
    const afterV1 = await getRigVersion(db, ws.workspaceId, rig.id, v1Id);
    expect(afterV1?.active).toBe(false);
    expect(afterV1?.image).toBe(before!.image);
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
    await updateRigChangeStatus(db, ws.workspaceId, change.id, {
      status: "proposed",
      verification: { passed: true },
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
    await updateRigChangeStatus(db, ws.workspaceId, change.id, {
      status: "proposed",
      verification: { passed: true },
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
    await updateRigChangeStatus(db, ws.workspaceId, change.id, {
      status: "proposed",
      verification: { passed: true },
    });

    const promote = () =>
      createRigVersionForChangePromotion(db, ws.workspaceId, rig.id, change.id, {
        expectedActiveVersionId: baseVersionId,
        setupScript: "echo v2",
        changelog: "verified edit",
      });
    const results = await Promise.all([promote(), promote()]);
    expect(results.filter((result) => result.promoted)).toHaveLength(1);
    expect(results.filter((result) => !result.promoted)).toHaveLength(1);

    const versions = await listRigVersions(db, ws.workspaceId, rig.id);
    expect(versions).toHaveLength(2);
    const stored = await getRigChange(db, ws.workspaceId, change.id);
    expect(stored?.status).toBe("merged");
    expect(stored?.resultVersionId).toBe(results[0]!.version.id);
  });

  test("proposal idempotency returns one row and rejects key reuse for different content", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const rig = await createRig(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      name: "proposal-idempotency",
    });
    const input = {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      rigId: rig.id,
      baseVersionId: rig.activeVersion!.id,
      kind: "setup_append" as const,
      payload: { command: "true" },
      proposedBy: "session:s1",
      idempotencyKey: "proposal-retry-1",
    };
    const [first, retry] = await Promise.all([
      createRigChangeWithIdempotencyKey(db, input),
      createRigChangeWithIdempotencyKey(db, input),
    ]);
    expect(first.change.id).toBe(retry.change.id);
    expect([first.created, retry.created].sort()).toEqual([false, true]);
    expect(await listRigChanges(db, ws.workspaceId, rig.id)).toHaveLength(1);
    await expect(
      createRigChangeWithIdempotencyKey(db, {
        ...input,
        payload: { command: "false" },
      }),
    ).rejects.toBeInstanceOf(RigChangeIdempotencyConflictError);
  });

  test("verification settlement is fenced to the current attempt", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const rig = await createRig(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      name: "attempt-fence",
    });
    const change = await createRigChange(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      rigId: rig.id,
      baseVersionId: rig.activeVersion!.id,
      kind: "setup_append",
      payload: { command: "true" },
    });
    const attempt1 = await beginRigChangeVerificationAttempt(db, ws.workspaceId, change.id, {
      startedAt: "2026-07-10T00:00:00.000Z",
    });
    expect(attempt1.verification?.attempt).toBe(1);
    await settleRigChangeVerificationAttempt(db, ws.workspaceId, change.id, 1, {
      status: "failed",
      verification: { passed: false, error: "cancelled" },
    });
    const attempt2 = await beginRigChangeVerificationAttempt(db, ws.workspaceId, change.id, {
      startedAt: "2026-07-10T00:01:00.000Z",
    });
    expect(attempt2.verification?.attempt).toBe(2);
    await expect(
      settleRigChangeVerificationAttempt(db, ws.workspaceId, change.id, 1, {
        status: "proposed",
        verification: { passed: true },
      }),
    ).rejects.toBeInstanceOf(RigVerificationAttemptChangedError);
    expect((await getRigChange(db, ws.workspaceId, change.id))?.status).toBe("verifying");
    expect((await getRig(db, ws.workspaceId, rig.id))?.activeVersion?.id).toBe(
      rig.activeVersion!.id,
    );

    await shared!.admin`
      update rig_changes
      set status = 'verifying', verification = '{}'::jsonb
      where id = ${change.id}`;
    const repaired = await beginRigChangeVerificationAttempt(db, ws.workspaceId, change.id, {
      startedAt: "2026-07-10T00:02:00.000Z",
      allowAlreadyVerifying: true,
    });
    expect(repaired.verification?.attempt).toBe(1);
    const ensuredAgain = await beginRigChangeVerificationAttempt(db, ws.workspaceId, change.id, {
      startedAt: "2026-07-10T00:03:00.000Z",
      allowAlreadyVerifying: true,
    });
    expect(ensuredAgain.verification?.attempt).toBe(1);
    expect(ensuredAgain.verification?.startedAt).toBe("2026-07-10T00:02:00.000Z");
  });

  test("list/get expose active version verification health", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const neverVerified = await createRig(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      name: "health-unknown",
      initialVersion: { checks: [{ name: "ready", command: "true" }] },
    });
    const noChecks = await createRig(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      name: "health-not-configured",
    });
    const verifiedRig = await createRig(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      name: "health-passing",
      initialVersion: {
        setupScript: "mkdir -p /opt/health",
        checks: [{ name: "tool", command: "test -f /opt/health/tool" }],
      },
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
    await updateRigChangeStatus(db, ws.workspaceId, change.id, {
      status: "proposed",
      verification: {
        startedAt: "2026-07-08T00:00:00.000Z",
        finishedAt: "2026-07-08T00:01:00.000Z",
        passed: true,
        checksConfigured: true,
        checkResults: [
          {
            name: "tool",
            command: "test -f /opt/health/tool",
            exitCode: 0,
            status: "passed",
            durationMs: 1,
          },
        ],
      },
    });
    const promoted = await createRigVersionForChangePromotion(
      db,
      ws.workspaceId,
      verifiedRig.id,
      change.id,
      {
        expectedActiveVersionId: verifiedRig.activeVersion!.id,
        setupScript: "mkdir -p /opt/health\ntouch /opt/health/tool",
        checks: [{ name: "tool", command: "test -f /opt/health/tool" }],
      },
    );

    const listed = await listRigs(db, ws.workspaceId);
    expect(listed.find((rig) => rig.id === neverVerified.id)?.activeVersionHealth).toEqual({
      checkHealth: "unknown",
      lastVerifiedAt: null,
    });
    expect(listed.find((rig) => rig.id === noChecks.id)?.activeVersionHealth).toEqual({
      checkHealth: "not_configured",
      lastVerifiedAt: null,
    });
    expect(listed.find((rig) => rig.id === verifiedRig.id)?.activeVersion?.id).toBe(
      promoted.version.id,
    );
    expect(listed.find((rig) => rig.id === verifiedRig.id)?.activeVersionHealth).toEqual({
      checkHealth: "passing",
      lastVerifiedAt: "2026-07-08T00:01:00.000Z",
    });
    expect(
      (await getRig(db, ws.workspaceId, verifiedRig.id))?.activeVersionHealth?.checkHealth,
    ).toBe("passing");
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

    await shared!.admin`update sessions set status = 'cancelled' where id = ${sessionId}`;
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
