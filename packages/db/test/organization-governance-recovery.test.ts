import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { eq } from "drizzle-orm";
import {
  approveOrganizationRecovery,
  createDb,
  createOrganizationRecoveryOperation,
  finalizeOrganizationRecovery,
  getOrganizationGovernance,
  ensureManagedAccessForUser,
  listWorkspacesForSubject,
  lockOrganizationGovernance,
  OrganizationGovernanceError,
  revokeOrganizationRecoveryApproval,
  setOrganizationRecoveryPolicy,
  withAccountRls,
  type Database,
  type DbClient,
} from "../src/index";
import * as schema from "../src/schema";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let db: Database;
let accountId = "";
let otherAccountId = "";
let workspaceId = "";
const keyA = new Uint8Array(32).fill(3);
const keyB = new Uint8Array(32).fill(4);

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("organization-governance-recovery");
  if (!shared) return;
  const [account] = await shared.admin<Array<{ id: string }>>`
    insert into managed_accounts (
      name, organization_kind, governance_authority_subject_id
    ) values ('team', 'team', 'user:owner') returning id`;
  const [other] = await shared.admin<Array<{ id: string }>>`
    insert into managed_accounts (
      name, organization_kind, governance_authority_subject_id
    ) values ('other', 'team', 'user:other-owner') returning id`;
  accountId = account!.id;
  otherAccountId = other!.id;
  const [workspace] = await shared.admin<Array<{ id: string }>>`
    insert into workspaces (account_id, name) values (${accountId}, 'team workspace') returning id`;
  workspaceId = workspace!.id;
  await shared.admin`
    insert into workspace_memberships (
      account_id, workspace_id, subject_id, role, permissions
    ) values
      (
        ${accountId}, ${workspaceId}, 'user:old-owner', 'owner',
        '["workspace:admin"]'::jsonb
      ),
      (
        ${accountId}, ${workspaceId}, 'service:old-automation', 'member',
        '["sessions:create"]'::jsonb
      )`;
  await shared.admin`
    insert into api_keys (
      account_id, workspace_id, name, prefix, key_hash, permissions
    ) values (
      ${accountId}, ${workspaceId}, 'old key', 'og_test', 'old-governance-key',
      '["workspace:admin"]'::jsonb
    )`;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
});

describe("organization governance recovery persistence", () => {
  test("finalizes only after revision-fenced distinct fresh approvals", async () => {
    if (!shared) return;
    const policyInput = {
      accountId,
      actorSubjectId: "user:owner",
      expectedGovernanceRevision: 0,
      quorum: 2,
      custodians: [{ subjectId: "user:a" }, { subjectId: "user:b" }, { subjectId: "user:c" }],
      idempotencyKey: "policy-enrollment-1",
    };
    const policy = await setOrganizationRecoveryPolicy(db, policyInput);
    expect(policy).toMatchObject({
      state: "active",
      governanceRevision: 1,
      recoveryPolicy: { revision: 1, quorum: 2 },
    });
    expect(await setOrganizationRecoveryPolicy(db, policyInput)).toEqual(policy);
    await expect(
      setOrganizationRecoveryPolicy(db, {
        ...policyInput,
        quorum: 1,
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });

    const locked = await lockOrganizationGovernance(db, {
      accountId,
      actorSubjectId: "user:owner",
      expectedGovernanceRevision: 1,
      reason: "owner identity unavailable",
      idempotencyKey: "lock-1",
    });
    expect(locked).toMatchObject({
      state: "governance_locked",
      governanceRevision: 2,
    });
    expect(
      await lockOrganizationGovernance(db, {
        accountId,
        actorSubjectId: "user:owner",
        expectedGovernanceRevision: 1,
        reason: "owner identity unavailable",
        idempotencyKey: "lock-1",
      }),
    ).toEqual(locked);

    const operation = await createOrganizationRecoveryOperation(db, {
      accountId,
      actorSubjectId: "user:a",
      idempotencyKey: "operation-1",
    });
    expect(operation).toMatchObject({
      state: "pending",
      quorum: 2,
      approvalCount: 0,
    });

    let wrongTenantApprovalError: unknown;
    try {
      await shared.admin`
        insert into organization_recovery_approvals (
          account_id, operation_id, subject_id, evidence_ciphertext,
          evidence_key_version, evidence_expires_at
        ) values (
          ${otherAccountId}, ${operation.id}, 'user:other-owner', 'iev1:wrong-tenant',
          'wrong-tenant', now() + interval '1 minute'
        )`;
    } catch (error) {
      wrongTenantApprovalError = error;
    }
    expect(wrongTenantApprovalError).toBeInstanceOf(Error);
    expect((wrongTenantApprovalError as Error).message).toContain(
      "organization_recovery_approvals_operation_account_fk",
    );

    const approvedA = await approveOrganizationRecovery(db, {
      accountId,
      operationId: operation.id,
      actorSubjectId: "user:a",
      evidence: "identity-proof-a",
      encryptionKey: keyA,
      idempotencyKey: "approval-a-1",
    });
    expect(approvedA.approvalCount).toBe(1);
    const [encryptedEvidence] = await shared.admin<Array<{ ciphertext: string }>>`
      select evidence_ciphertext as ciphertext from organization_recovery_approvals
      where account_id = ${accountId} and subject_id = 'user:a'`;
    expect(encryptedEvidence?.ciphertext).toStartWith("iev1:");
    expect(encryptedEvidence?.ciphertext).not.toContain("identity-proof");
    const revoked = await revokeOrganizationRecoveryApproval(db, {
      accountId,
      operationId: operation.id,
      actorSubjectId: "user:a",
      idempotencyKey: "revoke-a-1",
    });
    expect(revoked.approvalCount).toBe(0);
    await approveOrganizationRecovery(db, {
      accountId,
      operationId: operation.id,
      actorSubjectId: "user:a",
      evidence: "identity-proof-a-fresh",
      encryptionKey: keyA,
      idempotencyKey: "approval-a-2",
    });
    await expect(
      finalizeOrganizationRecovery(db, {
        accountId,
        operationId: operation.id,
        actorSubjectId: "user:a",
        encryptionKey: keyA,
        idempotencyKey: "finalize-too-early",
      }),
    ).rejects.toMatchObject({ code: "quorum_not_met" });

    await approveOrganizationRecovery(db, {
      accountId,
      operationId: operation.id,
      actorSubjectId: "user:b",
      evidence: "identity-proof-b",
      encryptionKey: keyA,
      idempotencyKey: "approval-b-1",
    });
    await expect(
      finalizeOrganizationRecovery(db, {
        accountId,
        operationId: operation.id,
        actorSubjectId: "user:c",
        encryptionKey: keyA,
        idempotencyKey: "finalize-unapproved-custodian",
      }),
    ).rejects.toMatchObject({ code: "quorum_not_met" });
    await approveOrganizationRecovery(db, {
      accountId,
      operationId: operation.id,
      actorSubjectId: "user:c",
      evidence: "identity-proof-c-before-rotation",
      encryptionKey: keyA,
      idempotencyKey: "approval-c-1",
    });
    await expect(
      finalizeOrganizationRecovery(db, {
        accountId,
        operationId: operation.id,
        actorSubjectId: "user:a",
        encryptionKey: keyB,
        idempotencyKey: "finalize-rotated-key",
      }),
    ).rejects.toMatchObject({ code: "evidence_invalid" });

    // Rotation is revocation: a valid quorum must submit fresh evidence under
    // the active key. A stale optional approval is excluded rather than gaining
    // veto power over an otherwise valid 2-of-3 recovery.
    await approveOrganizationRecovery(db, {
      accountId,
      operationId: operation.id,
      actorSubjectId: "user:a",
      evidence: "identity-proof-a-after-rotation",
      encryptionKey: keyB,
      idempotencyKey: "approval-a-rotated",
    });
    await approveOrganizationRecovery(db, {
      accountId,
      operationId: operation.id,
      actorSubjectId: "user:b",
      evidence: "identity-proof-b-after-rotation",
      encryptionKey: keyB,
      idempotencyKey: "approval-b-rotated",
    });
    const finalized = await finalizeOrganizationRecovery(db, {
      accountId,
      operationId: operation.id,
      actorSubjectId: "user:a",
      encryptionKey: keyB,
      idempotencyKey: "finalize-success",
    });
    expect(finalized).toMatchObject({ state: "finalized", approvalCount: 0 });
    expect(
      await finalizeOrganizationRecovery(db, {
        accountId,
        operationId: operation.id,
        actorSubjectId: "user:a",
        encryptionKey: keyB,
        idempotencyKey: "finalize-success",
      }),
    ).toEqual(finalized);

    const restored = await getOrganizationGovernance(db, accountId);
    expect(restored).toMatchObject({
      state: "active",
      governanceRevision: 3,
      authoritySubjectId: "user:a",
    });
    expect(restored?.authorizationInvalidatedAt).not.toBeNull();

    const [apiKey] = await shared.admin<Array<{ revokedAt: Date | null }>>`
      select revoked_at as "revokedAt" from api_keys where key_hash = 'old-governance-key'`;
    expect(apiKey?.revokedAt).not.toBeNull();
    const memberships = await shared.admin<Array<{ subjectId: string; role: string }>>`
      select subject_id as "subjectId", role from workspace_memberships
      where account_id = ${accountId}`;
    expect([...memberships]).toEqual([{ subjectId: "user:a", role: "owner" }]);

    const storedEvidence = await shared.admin<
      Array<{ ciphertext: string; keyVersion: string; consumedAt: Date | null }>
    >`
      select evidence_ciphertext as ciphertext, evidence_key_version as "keyVersion",
             consumed_at as "consumedAt"
      from organization_recovery_approvals where account_id = ${accountId}`;
    expect(storedEvidence).not.toHaveLength(0);
    expect(storedEvidence.every((row) => row.ciphertext === "destroyed")).toBeTrue();
    expect(storedEvidence.every((row) => row.keyVersion === "destroyed")).toBeTrue();
    expect(storedEvidence.every((row) => row.consumedAt !== null)).toBeTrue();
  }, 60_000);

  test("FORCE RLS isolates recovery rows and audit history rejects mutation", async () => {
    if (!shared) return;
    await withAccountRls(db, otherAccountId, async (scoped) => {
      const rows = await scoped
        .select()
        .from(schema.organizationRecoveryCustodians)
        .where(eq(schema.organizationRecoveryCustodians.accountId, accountId));
      expect(rows).toEqual([]);
    });

    let updateError: unknown;
    try {
      await shared.admin`
        update organization_recovery_audit set action = 'tampered'
        where account_id = ${accountId}`;
    } catch (error) {
      updateError = error;
    }
    expect(updateError).toBeInstanceOf(Error);
    expect((updateError as Error).message).toContain("append-only");

    let deleteError: unknown;
    try {
      await shared.admin`
        delete from organization_authorization_invalidations where account_id = ${accountId}`;
    } catch (error) {
      deleteError = error;
    }
    expect(deleteError).toBeInstanceOf(Error);
    expect((deleteError as Error).message).toContain("append-only");
  });

  test("managed login cannot recreate authority while a personal organization is locked", async () => {
    if (!shared) return;
    const userId = crypto.randomUUID();
    const [personal] = await shared.admin<Array<{ id: string }>>`
      insert into managed_accounts (
        name, external_source, external_id, organization_kind, governance_state,
        governance_authority_subject_id
      ) values (
        'locked personal', 'better-auth:user', ${userId}, 'personal',
        'governance_locked', ${`user:${userId}`}
      ) returning id`;
    const [workspace] = await shared.admin<Array<{ id: string }>>`
      insert into workspaces (
        account_id, name, external_source, external_id
      ) values (
        ${personal!.id}, 'locked workspace', 'better-auth:user', ${`${userId}:default`}
      ) returning id`;
    await shared.admin`
      insert into workspace_memberships (
        account_id, workspace_id, subject_id, role, permissions
      ) values (
        ${personal!.id}, ${workspace!.id}, ${`user:${userId}`}, 'member', '[]'::jsonb
      )`;

    const access = await ensureManagedAccessForUser(db, {
      userId,
      email: "locked@example.test",
      name: "Locked User",
    });
    expect(access.accountGrants[0]?.permissions).toEqual([]);
    expect(access.workspaceGrants).toEqual([]);
    expect(access.defaultWorkspaceId).toBeNull();
    expect(await listWorkspacesForSubject(db, `user:${userId}`)).toEqual([]);
    const [membership] = await shared.admin<Array<{ role: string; permissions: string[] }>>`
      select role, permissions from workspace_memberships
      where workspace_id = ${workspace!.id} and subject_id = ${`user:${userId}`}`;
    expect(membership).toMatchObject({ role: "member", permissions: [] });
  });

  test("uses safe typed failures without evidence or tenant data", () => {
    const error = new OrganizationGovernanceError("evidence_invalid");
    expect(error.message).toBe("organization governance command failed: evidence_invalid");
    expect(error.message).not.toContain("00000000-0000-4000-8000-000000000001");
    expect(error.message).not.toContain("identity-proof");
  });
});
