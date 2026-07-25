import { createHash } from "node:crypto";
import {
  OrganizationGovernance as OrganizationGovernanceContract,
  OrganizationRecoveryOperation as OrganizationRecoveryOperationContract,
  type OrganizationGovernance,
  type OrganizationRecoveryOperation,
} from "@opengeni/contracts";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Database } from "./index";
import * as schema from "./schema";
import {
  decryptIdentityEvidence,
  encryptIdentityEvidence,
  IDENTITY_EVIDENCE_AUDIENCE,
  IDENTITY_EVIDENCE_MAX_TTL_MS,
  IDENTITY_EVIDENCE_PURPOSE,
  identityEvidenceIdempotencyDigest,
  identityEvidenceKeyVersion,
} from "./identity-evidence-crypto";

const RECOVERY_OPERATION_TTL_MS = 24 * 60 * 60 * 1_000;
const DESTROYED_IDENTITY_EVIDENCE = "destroyed";

// Recovery intentionally invalidates every ordinary workspace grant, then
// restores exactly one explicit human authority. This mirrors the canonical
// owner permission set without importing index.ts at runtime (which would make
// this focused module cyclic).
const RECOVERED_WORKSPACE_PERMISSIONS = [
  "workspace:read",
  "workspace:admin",
  "members:manage",
  "sessions:create",
  "sessions:read",
  "sessions:control",
  "files:upload",
  "files:read",
  "documents:manage",
  "documents:search",
  "scheduled_tasks:manage",
  "scheduled_tasks:run",
  "github:manage",
  "github:use",
  "api_keys:manage",
  "connections:read",
  "connections:write",
  "variable-sets:manage",
  "variable-sets:use",
  "mcp_servers:attach",
  "goals:manage",
  "enrollments:read",
  "enrollments:manage",
] as const;

export type OrganizationGovernanceErrorCode =
  | "not_found"
  | "forbidden"
  | "active_required"
  | "locked_required"
  | "revision_conflict"
  | "policy_required"
  | "operation_conflict"
  | "operation_expired"
  | "quorum_not_met"
  | "evidence_invalid"
  | "idempotency_conflict";

export class OrganizationGovernanceError extends Error {
  constructor(readonly code: OrganizationGovernanceErrorCode) {
    super(`organization governance command failed: ${code}`);
    this.name = "OrganizationGovernanceError";
  }
}

type AccountRow = typeof schema.managedAccounts.$inferSelect;
type GovernanceTx = Database;

export type OrganizationGovernanceStatus = Pick<
  OrganizationGovernance,
  | "accountId"
  | "kind"
  | "state"
  | "governanceRevision"
  | "authoritySubjectId"
  | "authorizationInvalidatedAt"
>;

export async function getOrganizationGovernanceStatus(
  db: Database,
  accountId: string,
): Promise<OrganizationGovernanceStatus | null> {
  const [account] = await db
    .select()
    .from(schema.managedAccounts)
    .where(eq(schema.managedAccounts.id, accountId))
    .limit(1);
  return account ? mapStatus(account) : null;
}

export async function listOrganizationAuthorityAccounts(
  db: Database,
  subjectId: string,
): Promise<OrganizationGovernanceStatus[]> {
  const rows = await db
    .select()
    .from(schema.managedAccounts)
    .where(eq(schema.managedAccounts.governanceAuthoritySubjectId, subjectId));
  return rows.map(mapStatus);
}

export async function getOrganizationGovernance(
  db: Database,
  accountId: string,
): Promise<OrganizationGovernance | null> {
  const account = await getOrganizationGovernanceStatus(db, accountId);
  if (!account) return null;
  return await withGovernanceTx(db, accountId, async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.managedAccounts)
      .where(eq(schema.managedAccounts.id, accountId))
      .limit(1);
    return row ? await governanceProjection(tx, row) : null;
  });
}

export async function setOrganizationRecoveryPolicy(
  db: Database,
  input: {
    accountId: string;
    actorSubjectId: string;
    expectedGovernanceRevision: number;
    quorum: number;
    custodians: Array<{ subjectId: string; subjectLabel?: string }>;
    idempotencyKey: string;
  },
): Promise<OrganizationGovernance> {
  return await withGovernanceTx(db, input.accountId, async (tx) => {
    const account = await lockAccount(tx, input.accountId);
    const request = {
      expectedGovernanceRevision: input.expectedGovernanceRevision,
      quorum: input.quorum,
      custodians: input.custodians.map((custodian) => ({
        subjectId: custodian.subjectId,
        subjectLabel: custodian.subjectLabel ?? null,
      })),
    };
    const replay = await commandReplay<OrganizationGovernance>(tx, input, "policy.set", request);
    if (replay) return OrganizationGovernanceContract.parse(replay);
    if (account.governanceState !== "active") fail("active_required");
    if (account.governanceRevision !== input.expectedGovernanceRevision) {
      fail("revision_conflict");
    }
    validatePolicy(account, input.custodians, input.quorum);

    const now = new Date();
    const policyRevision = account.recoveryPolicyRevision + 1;
    const governanceRevision = account.governanceRevision + 1;
    await tx
      .delete(schema.organizationRecoveryCustodians)
      .where(eq(schema.organizationRecoveryCustodians.accountId, input.accountId));
    await tx.insert(schema.organizationRecoveryCustodians).values(
      input.custodians.map((custodian) => ({
        accountId: input.accountId,
        subjectId: custodian.subjectId,
        subjectLabel: custodian.subjectLabel ?? null,
        policyRevision,
        enrolledAt: now,
      })),
    );
    const [updated] = await tx
      .update(schema.managedAccounts)
      .set({
        recoveryPolicyRevision: policyRevision,
        recoveryQuorum: input.quorum,
        governanceRevision,
        updatedAt: now,
      })
      .where(eq(schema.managedAccounts.id, input.accountId))
      .returning();
    if (!updated) fail("not_found");
    await appendAudit(tx, {
      accountId: input.accountId,
      subjectId: input.actorSubjectId,
      action: "recovery_policy.enrolled",
      metadata: {
        policyRevision,
        governanceRevision,
        quorum: input.quorum,
        custodianCount: input.custodians.length,
      },
    });
    const result = await governanceProjection(tx, updated!);
    await recordCommand(tx, input, "policy.set", request, result);
    return result;
  });
}

export async function lockOrganizationGovernance(
  db: Database,
  input: {
    accountId: string;
    actorSubjectId: string;
    expectedGovernanceRevision: number;
    reason: string;
    idempotencyKey: string;
  },
): Promise<OrganizationGovernance> {
  return await withGovernanceTx(db, input.accountId, async (tx) => {
    const account = await lockAccount(tx, input.accountId);
    const request = {
      expectedGovernanceRevision: input.expectedGovernanceRevision,
      reason: input.reason,
    };
    const replay = await commandReplay<OrganizationGovernance>(
      tx,
      input,
      "governance.lock",
      request,
    );
    if (replay) return OrganizationGovernanceContract.parse(replay);
    if (account.governanceState !== "active") fail("active_required");
    if (account.governanceRevision !== input.expectedGovernanceRevision) {
      fail("revision_conflict");
    }
    if (account.recoveryPolicyRevision <= 0 || account.recoveryQuorum === null) {
      fail("policy_required");
    }
    const [custodianCount] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.organizationRecoveryCustodians)
      .where(
        and(
          eq(schema.organizationRecoveryCustodians.accountId, input.accountId),
          eq(schema.organizationRecoveryCustodians.policyRevision, account.recoveryPolicyRevision),
        ),
      );
    if ((custodianCount?.count ?? 0) < account.recoveryQuorum) fail("policy_required");
    const now = new Date();
    const governanceRevision = account.governanceRevision + 1;
    const [updated] = await tx
      .update(schema.managedAccounts)
      .set({
        governanceState: "governance_locked",
        governanceRevision,
        updatedAt: now,
      })
      .where(eq(schema.managedAccounts.id, input.accountId))
      .returning();
    if (!updated) fail("not_found");
    await appendAudit(tx, {
      accountId: input.accountId,
      subjectId: input.actorSubjectId,
      action: "governance.locked",
      metadata: { governanceRevision, reason: input.reason },
    });
    const result = await governanceProjection(tx, updated!);
    await recordCommand(tx, input, "governance.lock", request, result);
    return result;
  });
}

export async function createOrganizationRecoveryOperation(
  db: Database,
  input: { accountId: string; actorSubjectId: string; idempotencyKey: string },
): Promise<OrganizationRecoveryOperation> {
  return await withGovernanceTx(db, input.accountId, async (tx) => {
    const account = await lockAccount(tx, input.accountId);
    const request = {};
    const replay = await commandReplay<OrganizationRecoveryOperation>(
      tx,
      input,
      "recovery.create",
      request,
    );
    if (replay) return OrganizationRecoveryOperationContract.parse(replay);
    await requireLockedCustodian(tx, account, input.actorSubjectId);

    const now = new Date();
    const [pending] = await tx
      .select()
      .from(schema.organizationRecoveryOperations)
      .where(
        and(
          eq(schema.organizationRecoveryOperations.accountId, input.accountId),
          eq(schema.organizationRecoveryOperations.state, "pending"),
        ),
      )
      .for("update")
      .limit(1);
    if (pending && pending.expiresAt.getTime() > now.getTime()) fail("operation_conflict");
    if (pending) {
      await tx
        .update(schema.organizationRecoveryOperations)
        .set({ state: "cancelled", cancelledAt: now })
        .where(eq(schema.organizationRecoveryOperations.id, pending.id));
      await destroyOrganizationRecoveryEvidence(tx, pending.id, now, "revoked");
      await appendAudit(tx, {
        accountId: input.accountId,
        operationId: pending.id,
        subjectId: input.actorSubjectId,
        action: "recovery.expired",
        metadata: {},
      });
    }
    const [operation] = await tx
      .insert(schema.organizationRecoveryOperations)
      .values({
        accountId: input.accountId,
        governanceRevision: account.governanceRevision,
        policyRevision: account.recoveryPolicyRevision,
        quorum: account.recoveryQuorum!,
        requestedBySubjectId: input.actorSubjectId,
        expiresAt: new Date(now.getTime() + RECOVERY_OPERATION_TTL_MS),
        createdAt: now,
      })
      .returning();
    if (!operation) fail("operation_conflict");
    await appendAudit(tx, {
      accountId: input.accountId,
      operationId: operation!.id,
      subjectId: input.actorSubjectId,
      action: "recovery.created",
      metadata: {
        governanceRevision: account.governanceRevision,
        policyRevision: account.recoveryPolicyRevision,
        quorum: account.recoveryQuorum,
      },
    });
    const result = await operationProjection(tx, operation!);
    await recordCommand(tx, input, "recovery.create", request, result);
    return result;
  });
}

export async function approveOrganizationRecovery(
  db: Database,
  input: {
    accountId: string;
    operationId: string;
    actorSubjectId: string;
    evidence: string;
    encryptionKey: Uint8Array;
    idempotencyKey: string;
  },
): Promise<OrganizationRecoveryOperation> {
  return await withGovernanceTx(db, input.accountId, async (tx) => {
    const account = await lockAccount(tx, input.accountId);
    const request = {
      operationId: input.operationId,
      evidenceDigest: identityEvidenceIdempotencyDigest(input.encryptionKey, input.evidence),
    };
    const replay = await commandReplay<OrganizationRecoveryOperation>(
      tx,
      input,
      "recovery.approve",
      request,
    );
    if (replay) return OrganizationRecoveryOperationContract.parse(replay);
    await requireLockedCustodian(tx, account, input.actorSubjectId);
    const operation = await lockPendingOperation(tx, account, input.operationId);
    const now = new Date();
    const evidenceExpiresAt = new Date(
      Math.min(operation.expiresAt.getTime(), now.getTime() + IDENTITY_EVIDENCE_MAX_TTL_MS),
    );
    if (evidenceExpiresAt.getTime() <= now.getTime()) fail("operation_expired");
    const encrypted = encryptIdentityEvidence(
      input.encryptionKey,
      {
        accountId: input.accountId,
        operationId: input.operationId,
        subjectId: input.actorSubjectId,
        audience: IDENTITY_EVIDENCE_AUDIENCE,
        purpose: IDENTITY_EVIDENCE_PURPOSE,
        expiresAt: evidenceExpiresAt,
      },
      input.evidence,
    );
    await tx
      .insert(schema.organizationRecoveryApprovals)
      .values({
        accountId: input.accountId,
        operationId: input.operationId,
        subjectId: input.actorSubjectId,
        evidenceCiphertext: encrypted.ciphertext,
        evidenceKeyVersion: encrypted.keyVersion,
        evidenceExpiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.organizationRecoveryApprovals.operationId,
          schema.organizationRecoveryApprovals.subjectId,
        ],
        set: {
          evidenceCiphertext: encrypted.ciphertext,
          evidenceKeyVersion: encrypted.keyVersion,
          evidenceExpiresAt,
          revokedAt: null,
          consumedAt: null,
          createdAt: now,
          updatedAt: now,
        },
      });
    await appendAudit(tx, {
      accountId: input.accountId,
      operationId: input.operationId,
      subjectId: input.actorSubjectId,
      action: "recovery.approved",
      metadata: { evidenceExpiresAt: evidenceExpiresAt.toISOString() },
    });
    const result = await operationProjection(tx, operation);
    await recordCommand(tx, input, "recovery.approve", request, result);
    return result;
  });
}

export async function revokeOrganizationRecoveryApproval(
  db: Database,
  input: {
    accountId: string;
    operationId: string;
    actorSubjectId: string;
    idempotencyKey: string;
  },
): Promise<OrganizationRecoveryOperation> {
  return await withGovernanceTx(db, input.accountId, async (tx) => {
    const account = await lockAccount(tx, input.accountId);
    const request = { operationId: input.operationId };
    const replay = await commandReplay<OrganizationRecoveryOperation>(
      tx,
      input,
      "recovery.approval.revoke",
      request,
    );
    if (replay) return OrganizationRecoveryOperationContract.parse(replay);
    await requireLockedCustodian(tx, account, input.actorSubjectId);
    const operation = await lockPendingOperation(tx, account, input.operationId);
    const now = new Date();
    const [approval] = await tx
      .update(schema.organizationRecoveryApprovals)
      .set({
        evidenceCiphertext: DESTROYED_IDENTITY_EVIDENCE,
        evidenceKeyVersion: DESTROYED_IDENTITY_EVIDENCE,
        revokedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.organizationRecoveryApprovals.accountId, input.accountId),
          eq(schema.organizationRecoveryApprovals.operationId, input.operationId),
          eq(schema.organizationRecoveryApprovals.subjectId, input.actorSubjectId),
          sql`${schema.organizationRecoveryApprovals.revokedAt} is null`,
          sql`${schema.organizationRecoveryApprovals.consumedAt} is null`,
        ),
      )
      .returning();
    if (!approval) fail("evidence_invalid");
    await appendAudit(tx, {
      accountId: input.accountId,
      operationId: input.operationId,
      subjectId: input.actorSubjectId,
      action: "recovery.approval_revoked",
      metadata: {},
    });
    const result = await operationProjection(tx, operation);
    await recordCommand(tx, input, "recovery.approval.revoke", request, result);
    return result;
  });
}

export async function cancelOrganizationRecoveryOperation(
  db: Database,
  input: {
    accountId: string;
    operationId: string;
    actorSubjectId: string;
    idempotencyKey: string;
  },
): Promise<OrganizationRecoveryOperation> {
  return await withGovernanceTx(db, input.accountId, async (tx) => {
    const account = await lockAccount(tx, input.accountId);
    const request = { operationId: input.operationId };
    const replay = await commandReplay<OrganizationRecoveryOperation>(
      tx,
      input,
      "recovery.cancel",
      request,
    );
    if (replay) return OrganizationRecoveryOperationContract.parse(replay);
    await requireLockedCustodian(tx, account, input.actorSubjectId);
    const operation = await lockPendingOperation(tx, account, input.operationId);
    const now = new Date();
    const [cancelled] = await tx
      .update(schema.organizationRecoveryOperations)
      .set({ state: "cancelled", cancelledAt: now })
      .where(eq(schema.organizationRecoveryOperations.id, operation.id))
      .returning();
    await destroyOrganizationRecoveryEvidence(tx, operation.id, now, "revoked");
    await appendAudit(tx, {
      accountId: input.accountId,
      operationId: operation.id,
      subjectId: input.actorSubjectId,
      action: "recovery.cancelled",
      metadata: {},
    });
    const result = await operationProjection(tx, cancelled!);
    await recordCommand(tx, input, "recovery.cancel", request, result);
    return result;
  });
}

export async function finalizeOrganizationRecovery(
  db: Database,
  input: {
    accountId: string;
    operationId: string;
    actorSubjectId: string;
    encryptionKey: Uint8Array;
    idempotencyKey: string;
  },
): Promise<OrganizationRecoveryOperation> {
  return await withGovernanceTx(db, input.accountId, async (tx) => {
    const account = await lockAccount(tx, input.accountId);
    const request = { operationId: input.operationId };
    const replay = await commandReplay<OrganizationRecoveryOperation>(
      tx,
      input,
      "recovery.finalize",
      request,
    );
    if (replay) return OrganizationRecoveryOperationContract.parse(replay);
    await requireLockedCustodian(tx, account, input.actorSubjectId);
    const operation = await lockPendingOperation(tx, account, input.operationId);
    const now = new Date();
    const approvals = await tx
      .select()
      .from(schema.organizationRecoveryApprovals)
      .where(
        and(
          eq(schema.organizationRecoveryApprovals.accountId, input.accountId),
          eq(schema.organizationRecoveryApprovals.operationId, operation.id),
          sql`${schema.organizationRecoveryApprovals.revokedAt} is null`,
          sql`${schema.organizationRecoveryApprovals.consumedAt} is null`,
          gt(schema.organizationRecoveryApprovals.evidenceExpiresAt, now),
        ),
      )
      .orderBy(asc(schema.organizationRecoveryApprovals.createdAt));
    const activeKeyVersion = identityEvidenceKeyVersion(input.encryptionKey);
    const authenticatedSubjects = new Set<string>();
    let rejectedEvidence = false;
    for (const approval of approvals) {
      if (approval.evidenceKeyVersion !== activeKeyVersion) {
        rejectedEvidence = true;
        continue;
      }
      try {
        const plaintext = decryptIdentityEvidence(
          input.encryptionKey,
          {
            accountId: input.accountId,
            operationId: operation.id,
            subjectId: approval.subjectId,
            audience: IDENTITY_EVIDENCE_AUDIENCE,
            purpose: IDENTITY_EVIDENCE_PURPOSE,
            expiresAt: approval.evidenceExpiresAt,
          },
          approval.evidenceCiphertext,
          approval.evidenceKeyVersion,
        );
        if (plaintext.length === 0) {
          rejectedEvidence = true;
          continue;
        }
        authenticatedSubjects.add(approval.subjectId);
      } catch {
        rejectedEvidence = true;
      }
    }
    if (authenticatedSubjects.size < operation.quorum) {
      fail(rejectedEvidence ? "evidence_invalid" : "quorum_not_met");
    }
    // The human receiving restored team authority must have supplied one of
    // the fresh, authenticated approvals. Custodian enrollment alone cannot
    // let a non-approving finalizer take ownership from an approved quorum.
    if (!authenticatedSubjects.has(input.actorSubjectId)) fail("quorum_not_met");
    if (
      account.organizationKind === "personal" &&
      (!account.governanceAuthoritySubjectId ||
        !authenticatedSubjects.has(account.governanceAuthoritySubjectId))
    ) {
      fail("quorum_not_met");
    }

    const governanceRevision = account.governanceRevision + 1;
    const invalidatedAt = new Date();
    const recoveredAuthority =
      account.organizationKind === "personal"
        ? account.governanceAuthoritySubjectId!
        : input.actorSubjectId;

    // Same-transaction recovery: restore active state and explicit human
    // authority, consume evidence, revoke machine/API credentials, replace all
    // workspace memberships, and append invalidation + audit evidence.
    await tx
      .update(schema.organizationRecoveryApprovals)
      .set({
        evidenceCiphertext: DESTROYED_IDENTITY_EVIDENCE,
        evidenceKeyVersion: DESTROYED_IDENTITY_EVIDENCE,
        consumedAt: invalidatedAt,
        updatedAt: invalidatedAt,
      })
      .where(
        and(
          eq(schema.organizationRecoveryApprovals.accountId, input.accountId),
          eq(schema.organizationRecoveryApprovals.operationId, operation.id),
          sql`${schema.organizationRecoveryApprovals.revokedAt} is null`,
          sql`${schema.organizationRecoveryApprovals.consumedAt} is null`,
        ),
      );
    await tx
      .update(schema.apiKeys)
      .set({ revokedAt: invalidatedAt, updatedAt: invalidatedAt })
      .where(
        and(
          eq(schema.apiKeys.accountId, input.accountId),
          sql`${schema.apiKeys.revokedAt} is null`,
        ),
      );
    await tx
      .delete(schema.workspaceMemberships)
      .where(eq(schema.workspaceMemberships.accountId, input.accountId));
    const workspaces = await tx
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.accountId, input.accountId));
    if (workspaces.length > 0) {
      await tx.insert(schema.workspaceMemberships).values(
        workspaces.map((workspace) => ({
          accountId: input.accountId,
          workspaceId: workspace.id,
          subjectId: recoveredAuthority,
          role: "owner",
          permissions: [...RECOVERED_WORKSPACE_PERMISSIONS],
          createdAt: invalidatedAt,
          updatedAt: invalidatedAt,
        })),
      );
    }
    const [finalized] = await tx
      .update(schema.organizationRecoveryOperations)
      .set({ state: "finalized", finalizedAt: invalidatedAt })
      .where(eq(schema.organizationRecoveryOperations.id, operation.id))
      .returning();
    const [restored] = await tx
      .update(schema.managedAccounts)
      .set({
        governanceState: "active",
        governanceRevision,
        governanceAuthoritySubjectId: recoveredAuthority,
        authorizationInvalidatedAt: invalidatedAt,
        updatedAt: invalidatedAt,
      })
      .where(eq(schema.managedAccounts.id, input.accountId))
      .returning();
    if (!finalized || !restored) fail("operation_conflict");
    await tx.insert(schema.organizationAuthorizationInvalidations).values({
      accountId: input.accountId,
      operationId: operation.id,
      governanceRevision,
      reason: "governance_recovery",
      invalidatedAt,
    });
    await appendAudit(tx, {
      accountId: input.accountId,
      operationId: operation.id,
      subjectId: input.actorSubjectId,
      action: "recovery.finalized",
      metadata: {
        governanceRevision,
        policyRevision: operation.policyRevision,
        quorum: operation.quorum,
        approvalCount: authenticatedSubjects.size,
        authorityRestored: true,
        authorizationInvalidated: true,
      },
    });
    const result = await operationProjection(tx, finalized!);
    await recordCommand(tx, input, "recovery.finalize", request, result);
    return result;
  });
}

async function withGovernanceTx<T>(
  db: Database,
  accountId: string,
  fn: (tx: GovernanceTx) => Promise<T>,
): Promise<T> {
  return await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as GovernanceTx;
    await tx.execute(sql`select set_config('opengeni.account_id', ${accountId}, true)`);
    await tx.execute(sql`select set_config('opengeni.workspace_id', '', true)`);
    const applied = await tx.execute<{ account_id: string | null }>(
      sql`select current_setting('opengeni.account_id', true) as account_id`,
    );
    const rows = Array.isArray(applied)
      ? applied
      : ((applied as unknown as { rows?: Array<{ account_id: string | null }> }).rows ?? []);
    if ((rows[0]?.account_id ?? "") !== accountId) {
      throw new Error("organization governance RLS context was not applied");
    }
    return await fn(tx);
  });
}

async function lockAccount(tx: GovernanceTx, accountId: string): Promise<AccountRow> {
  const [account] = await tx
    .select()
    .from(schema.managedAccounts)
    .where(eq(schema.managedAccounts.id, accountId))
    .for("update")
    .limit(1);
  if (!account) fail("not_found");
  return account!;
}

async function governanceProjection(tx: GovernanceTx, account: AccountRow) {
  const custodians =
    account.recoveryPolicyRevision > 0
      ? await tx
          .select()
          .from(schema.organizationRecoveryCustodians)
          .where(
            and(
              eq(schema.organizationRecoveryCustodians.accountId, account.id),
              eq(
                schema.organizationRecoveryCustodians.policyRevision,
                account.recoveryPolicyRevision,
              ),
            ),
          )
          .orderBy(asc(schema.organizationRecoveryCustodians.enrolledAt))
      : [];
  return OrganizationGovernanceContract.parse({
    ...mapStatus(account),
    recoveryPolicy:
      account.recoveryPolicyRevision > 0 && account.recoveryQuorum !== null
        ? {
            revision: account.recoveryPolicyRevision,
            quorum: account.recoveryQuorum,
            custodians: custodians.map((custodian) => ({
              subjectId: custodian.subjectId,
              subjectLabel: custodian.subjectLabel,
              policyRevision: custodian.policyRevision,
              enrolledAt: custodian.enrolledAt.toISOString(),
            })),
          }
        : null,
  });
}

function mapStatus(account: AccountRow): OrganizationGovernanceStatus {
  return {
    accountId: account.id,
    kind: account.organizationKind as OrganizationGovernance["kind"],
    state: account.governanceState as OrganizationGovernance["state"],
    governanceRevision: account.governanceRevision,
    authoritySubjectId: account.governanceAuthoritySubjectId,
    authorizationInvalidatedAt: account.authorizationInvalidatedAt?.toISOString() ?? null,
  };
}

async function operationProjection(
  tx: GovernanceTx,
  operation: typeof schema.organizationRecoveryOperations.$inferSelect,
): Promise<OrganizationRecoveryOperation> {
  const approvals = await tx
    .select()
    .from(schema.organizationRecoveryApprovals)
    .where(
      and(
        eq(schema.organizationRecoveryApprovals.accountId, operation.accountId),
        eq(schema.organizationRecoveryApprovals.operationId, operation.id),
      ),
    )
    .orderBy(asc(schema.organizationRecoveryApprovals.createdAt));
  const now = Date.now();
  const approvalCount = new Set(
    approvals
      .filter(
        (approval) =>
          !approval.revokedAt && !approval.consumedAt && approval.evidenceExpiresAt.getTime() > now,
      )
      .map((approval) => approval.subjectId),
  ).size;
  return OrganizationRecoveryOperationContract.parse({
    id: operation.id,
    accountId: operation.accountId,
    state: operation.state,
    governanceRevision: operation.governanceRevision,
    policyRevision: operation.policyRevision,
    quorum: operation.quorum,
    approvalCount,
    approvals: approvals.map((approval) => ({
      subjectId: approval.subjectId,
      evidenceExpiresAt: approval.evidenceExpiresAt.toISOString(),
      revokedAt: approval.revokedAt?.toISOString() ?? null,
      consumedAt: approval.consumedAt?.toISOString() ?? null,
      createdAt: approval.createdAt.toISOString(),
    })),
    expiresAt: operation.expiresAt.toISOString(),
    finalizedAt: operation.finalizedAt?.toISOString() ?? null,
    cancelledAt: operation.cancelledAt?.toISOString() ?? null,
    createdAt: operation.createdAt.toISOString(),
  });
}

function validatePolicy(
  account: AccountRow,
  custodians: Array<{ subjectId: string }>,
  quorum: number,
): void {
  const subjects = new Set(custodians.map((custodian) => custodian.subjectId));
  if (subjects.size !== custodians.length || quorum < 1 || quorum > subjects.size) {
    fail("policy_required");
  }
  for (const subject of subjects) {
    if (!subject.startsWith("user:")) fail("policy_required");
  }
  if (account.organizationKind === "personal") {
    if (
      !account.governanceAuthoritySubjectId ||
      quorum !== 1 ||
      subjects.size !== 1 ||
      !subjects.has(account.governanceAuthoritySubjectId)
    ) {
      fail("policy_required");
    }
    return;
  }
  if (subjects.size < 2 || quorum < 2) fail("policy_required");
}

async function requireLockedCustodian(
  tx: GovernanceTx,
  account: AccountRow,
  subjectId: string,
): Promise<void> {
  if (!subjectId.startsWith("user:")) fail("forbidden");
  if (account.governanceState !== "governance_locked") fail("locked_required");
  if (account.recoveryPolicyRevision <= 0 || account.recoveryQuorum === null) {
    fail("policy_required");
  }
  const [custodian] = await tx
    .select({ id: schema.organizationRecoveryCustodians.id })
    .from(schema.organizationRecoveryCustodians)
    .where(
      and(
        eq(schema.organizationRecoveryCustodians.accountId, account.id),
        eq(schema.organizationRecoveryCustodians.policyRevision, account.recoveryPolicyRevision),
        eq(schema.organizationRecoveryCustodians.subjectId, subjectId),
      ),
    )
    .limit(1);
  if (!custodian) fail("forbidden");
}

async function lockPendingOperation(tx: GovernanceTx, account: AccountRow, operationId: string) {
  const [operation] = await tx
    .select()
    .from(schema.organizationRecoveryOperations)
    .where(
      and(
        eq(schema.organizationRecoveryOperations.id, operationId),
        eq(schema.organizationRecoveryOperations.accountId, account.id),
      ),
    )
    .for("update")
    .limit(1);
  if (!operation || operation.state !== "pending") fail("operation_conflict");
  if (operation.expiresAt.getTime() <= Date.now()) fail("operation_expired");
  if (
    operation.governanceRevision !== account.governanceRevision ||
    operation.policyRevision !== account.recoveryPolicyRevision ||
    operation.quorum !== account.recoveryQuorum
  ) {
    fail("revision_conflict");
  }
  return operation!;
}

async function appendAudit(
  tx: GovernanceTx,
  input: {
    accountId: string;
    operationId?: string;
    subjectId: string;
    action: string;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(schema.organizationRecoveryAudit).values({
    accountId: input.accountId,
    operationId: input.operationId ?? null,
    subjectId: input.subjectId,
    action: input.action,
    metadata: input.metadata,
  });
}

async function destroyOrganizationRecoveryEvidence(
  tx: GovernanceTx,
  operationId: string,
  at: Date,
  disposition: "revoked" | "consumed",
): Promise<void> {
  await tx
    .update(schema.organizationRecoveryApprovals)
    .set({
      evidenceCiphertext: DESTROYED_IDENTITY_EVIDENCE,
      evidenceKeyVersion: DESTROYED_IDENTITY_EVIDENCE,
      ...(disposition === "revoked" ? { revokedAt: at } : { consumedAt: at }),
      updatedAt: at,
    })
    .where(
      and(
        eq(schema.organizationRecoveryApprovals.operationId, operationId),
        sql`${schema.organizationRecoveryApprovals.revokedAt} is null`,
        sql`${schema.organizationRecoveryApprovals.consumedAt} is null`,
      ),
    );
}

type CommandIdentity = {
  accountId: string;
  actorSubjectId: string;
  idempotencyKey: string;
};

async function commandReplay<T>(
  tx: GovernanceTx,
  input: CommandIdentity,
  commandType: string,
  request: unknown,
): Promise<T | null> {
  const [receipt] = await tx
    .select()
    .from(schema.organizationGovernanceCommands)
    .where(
      and(
        eq(schema.organizationGovernanceCommands.accountId, input.accountId),
        eq(schema.organizationGovernanceCommands.subjectId, input.actorSubjectId),
        eq(schema.organizationGovernanceCommands.idempotencyKey, input.idempotencyKey),
      ),
    )
    .for("update")
    .limit(1);
  if (!receipt) return null;
  if (receipt.commandType !== commandType || receipt.requestHash !== stableHash(request)) {
    fail("idempotency_conflict");
  }
  return receipt.result as T;
}

async function recordCommand(
  tx: GovernanceTx,
  input: CommandIdentity,
  commandType: string,
  request: unknown,
  result: Record<string, unknown>,
): Promise<void> {
  await tx.insert(schema.organizationGovernanceCommands).values({
    accountId: input.accountId,
    subjectId: input.actorSubjectId,
    idempotencyKey: input.idempotencyKey,
    commandType,
    requestHash: stableHash(request),
    result,
  });
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function fail(code: OrganizationGovernanceErrorCode): never {
  throw new OrganizationGovernanceError(code);
}
