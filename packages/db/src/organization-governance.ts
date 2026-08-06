import { createHash } from "node:crypto";
import {
  OrganizationGovernance as OrganizationGovernanceContract,
  OrganizationRecoveryOperation as OrganizationRecoveryOperationContract,
  type OrganizationGovernance,
  type OrganizationRecoveryOperation,
} from "@opengeni/contracts";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Database } from "./index";
import { databaseTargetSchemaFor, rawRows } from "./database";
import * as schema from "./schema";
import {
  decryptIdentityEvidence,
  encryptIdentityEvidence,
  IDENTITY_EVIDENCE_AUDIENCE,
  IDENTITY_EVIDENCE_MAX_TTL_MS,
  IDENTITY_EVIDENCE_PURPOSE,
  identityEvidenceReceiptIdentityHash,
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

export type OrganizationGovernanceStatus = {
  accountId: string;
  kind: OrganizationGovernance["kind"];
  state: OrganizationGovernance["state"];
  governanceRevision: number;
  /** Internal-only authority pointer; never included in public projections. */
  authoritySubjectId: string | null;
  authorizationInvalidatedAt: string | null;
};

interface DirectManagedSessionEvidence {
  userId: string;
  sessionId: string;
}

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
    actorUserId: string;
    directSessionEvidence: DirectManagedSessionEvidence;
    expectedGovernanceRevision: number;
    quorum: number;
    custodians: Array<{ subjectId: string; subjectLabel?: string }>;
    idempotencyKey: string;
  },
): Promise<OrganizationGovernance> {
  return await withGovernanceTx(
    db,
    input.accountId,
    async (tx) => {
      const account = await lockAccount(tx, input.accountId);
      await lockGovernanceBoundary(
        tx,
        account,
        input.actorUserId,
        input.directSessionEvidence,
        undefined,
        databaseTargetSchemaFor(db),
      );
      const request = {
        expectedGovernanceRevision: input.expectedGovernanceRevision,
        quorum: input.quorum,
        custodians: input.custodians.map((custodian) => custodian.subjectId),
      };
      const replay = await commandReplay<OrganizationGovernance>(tx, input, "policy.set", request);
      if (replay) return OrganizationGovernanceContract.parse(replay);
      if (account.governanceState !== "active") fail("active_required");
      if (account.governanceRevision !== input.expectedGovernanceRevision) {
        fail("revision_conflict");
      }
      const resolvedCustodians = await resolveRequestedCustodians(
        tx,
        input.custodians,
        databaseTargetSchemaFor(db),
      );
      validatePolicy(account, input.custodians, input.quorum, resolvedCustodians);

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
          subjectLabel: resolvedCustodians.get(custodian.subjectId)?.label ?? null,
          canonicalUserId: resolvedCustodians.get(custodian.subjectId)?.userId ?? null,
          enrollmentState: "pending",
          acceptedAt: null,
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
    },
    input.directSessionEvidence,
  );
}

export async function acceptOrganizationRecoveryCustodian(
  db: Database,
  input: {
    accountId: string;
    actorSubjectId: string;
    actorUserId: string;
    directSessionEvidence: DirectManagedSessionEvidence;
    idempotencyKey: string;
  },
): Promise<OrganizationGovernance> {
  return await withGovernanceTx(
    db,
    input.accountId,
    async (tx) => {
      const account = await lockAccount(tx, input.accountId);
      await lockGovernanceBoundary(
        tx,
        account,
        input.actorUserId,
        input.directSessionEvidence,
        undefined,
        databaseTargetSchemaFor(db),
      );
      const request = { policyRevision: account.recoveryPolicyRevision };
      const replay = await commandReplay<OrganizationGovernance>(
        tx,
        input,
        "custodian.accept",
        request,
      );
      if (replay) return OrganizationGovernanceContract.parse(replay);
      if (account.governanceState !== "active") fail("active_required");
      const [custodian] = await tx
        .update(schema.organizationRecoveryCustodians)
        .set({ enrollmentState: "accepted", acceptedAt: new Date() })
        .where(
          and(
            eq(schema.organizationRecoveryCustodians.accountId, input.accountId),
            eq(
              schema.organizationRecoveryCustodians.policyRevision,
              account.recoveryPolicyRevision,
            ),
            eq(schema.organizationRecoveryCustodians.canonicalUserId, input.actorUserId),
            eq(schema.organizationRecoveryCustodians.enrollmentState, "pending"),
          ),
        )
        .returning();
      if (!custodian) {
        const [alreadyAccepted] = await tx
          .select({ id: schema.organizationRecoveryCustodians.id })
          .from(schema.organizationRecoveryCustodians)
          .where(
            and(
              eq(schema.organizationRecoveryCustodians.accountId, input.accountId),
              eq(
                schema.organizationRecoveryCustodians.policyRevision,
                account.recoveryPolicyRevision,
              ),
              eq(schema.organizationRecoveryCustodians.canonicalUserId, input.actorUserId),
              eq(schema.organizationRecoveryCustodians.enrollmentState, "accepted"),
            ),
          )
          .limit(1);
        if (!alreadyAccepted) fail("forbidden");
      }
      await appendAudit(tx, {
        accountId: input.accountId,
        subjectId: input.actorSubjectId,
        action: "recovery_custodian.accepted",
        metadata: { policyRevision: account.recoveryPolicyRevision },
      });
      const result = await governanceProjection(tx, account);
      await recordCommand(tx, input, "custodian.accept", request, result);
      return result;
    },
    input.directSessionEvidence,
  );
}

export async function lockOrganizationGovernance(
  db: Database,
  input: {
    accountId: string;
    actorSubjectId: string;
    actorUserId: string;
    directSessionEvidence: DirectManagedSessionEvidence;
    expectedGovernanceRevision: number;
    reason: string;
    idempotencyKey: string;
  },
): Promise<OrganizationGovernance> {
  return await withGovernanceTx(
    db,
    input.accountId,
    async (tx) => {
      const account = await lockAccount(tx, input.accountId);
      await lockGovernanceBoundary(
        tx,
        account,
        input.actorUserId,
        input.directSessionEvidence,
        undefined,
        databaseTargetSchemaFor(db),
      );
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
            eq(
              schema.organizationRecoveryCustodians.policyRevision,
              account.recoveryPolicyRevision,
            ),
            eq(schema.organizationRecoveryCustodians.enrollmentState, "accepted"),
            sql`${schema.organizationRecoveryCustodians.canonicalUserId} is not null`,
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
    },
    input.directSessionEvidence,
  );
}

export async function createOrganizationRecoveryOperation(
  db: Database,
  input: {
    accountId: string;
    actorSubjectId: string;
    actorUserId: string;
    directSessionEvidence: DirectManagedSessionEvidence;
    idempotencyKey: string;
  },
): Promise<OrganizationRecoveryOperation> {
  return await withGovernanceTx(
    db,
    input.accountId,
    async (tx) => {
      const account = await lockAccount(tx, input.accountId);
      await lockGovernanceBoundary(
        tx,
        account,
        input.actorUserId,
        input.directSessionEvidence,
        undefined,
        databaseTargetSchemaFor(db),
      );
      const request = {};
      const replay = await commandReplay<OrganizationRecoveryOperation>(
        tx,
        input,
        "recovery.create",
        request,
      );
      if (replay) return OrganizationRecoveryOperationContract.parse(replay);
      await requireLockedCustodian(tx, account, input.actorUserId);

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
    },
    input.directSessionEvidence,
  );
}

export async function approveOrganizationRecovery(
  db: Database,
  input: {
    accountId: string;
    operationId: string;
    actorSubjectId: string;
    actorUserId: string;
    directSessionEvidence: DirectManagedSessionEvidence;
    evidence: string;
    encryptionKey: Uint8Array;
    receiptIdentitySecret: Uint8Array;
    idempotencyKey: string;
  },
): Promise<OrganizationRecoveryOperation> {
  return await withGovernanceTx(
    db,
    input.accountId,
    async (tx) => {
      const account = await lockAccount(tx, input.accountId);
      await lockGovernanceBoundary(
        tx,
        account,
        input.actorUserId,
        input.directSessionEvidence,
        input.operationId,
        databaseTargetSchemaFor(db),
      );
      const request = {
        operationId: input.operationId,
        evidenceReceiptIdentity: identityEvidenceReceiptIdentityHash(
          input.receiptIdentitySecret,
          input.evidence,
        ),
      };
      const replay = await commandReplay<OrganizationRecoveryOperation>(
        tx,
        input,
        "recovery.approve",
        request,
      );
      if (replay) return OrganizationRecoveryOperationContract.parse(replay);
      await requireLockedCustodian(tx, account, input.actorUserId);
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
          canonicalUserId: input.actorUserId,
          authSessionId: input.directSessionEvidence?.sessionId ?? null,
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
            canonicalUserId: input.actorUserId,
            authSessionId: input.directSessionEvidence?.sessionId ?? null,
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
    },
    input.directSessionEvidence,
  );
}

export async function revokeOrganizationRecoveryApproval(
  db: Database,
  input: {
    accountId: string;
    operationId: string;
    actorSubjectId: string;
    actorUserId: string;
    directSessionEvidence: DirectManagedSessionEvidence;
    idempotencyKey: string;
  },
): Promise<OrganizationRecoveryOperation> {
  return await withGovernanceTx(
    db,
    input.accountId,
    async (tx) => {
      const account = await lockAccount(tx, input.accountId);
      await lockGovernanceBoundary(
        tx,
        account,
        input.actorUserId,
        input.directSessionEvidence,
        input.operationId,
        databaseTargetSchemaFor(db),
      );
      const request = { operationId: input.operationId };
      const replay = await commandReplay<OrganizationRecoveryOperation>(
        tx,
        input,
        "recovery.approval.revoke",
        request,
      );
      if (replay) return OrganizationRecoveryOperationContract.parse(replay);
      await requireLockedCustodian(tx, account, input.actorUserId);
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
    },
    input.directSessionEvidence,
  );
}

export async function cancelOrganizationRecoveryOperation(
  db: Database,
  input: {
    accountId: string;
    operationId: string;
    actorSubjectId: string;
    actorUserId: string;
    directSessionEvidence: DirectManagedSessionEvidence;
    idempotencyKey: string;
  },
): Promise<OrganizationRecoveryOperation> {
  return await withGovernanceTx(
    db,
    input.accountId,
    async (tx) => {
      const account = await lockAccount(tx, input.accountId);
      await lockGovernanceBoundary(
        tx,
        account,
        input.actorUserId,
        input.directSessionEvidence,
        input.operationId,
        databaseTargetSchemaFor(db),
      );
      const request = { operationId: input.operationId };
      const replay = await commandReplay<OrganizationRecoveryOperation>(
        tx,
        input,
        "recovery.cancel",
        request,
      );
      if (replay) return OrganizationRecoveryOperationContract.parse(replay);
      await requireLockedCustodian(tx, account, input.actorUserId);
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
    },
    input.directSessionEvidence,
  );
}

export async function finalizeOrganizationRecovery(
  db: Database,
  input: {
    accountId: string;
    operationId: string;
    actorSubjectId: string;
    actorUserId: string;
    directSessionEvidence: DirectManagedSessionEvidence;
    encryptionKey: Uint8Array;
    idempotencyKey: string;
  },
): Promise<OrganizationRecoveryOperation> {
  return await withGovernanceTx(
    db,
    input.accountId,
    async (tx) => {
      const account = await lockAccount(tx, input.accountId);
      await lockGovernanceBoundary(
        tx,
        account,
        input.actorUserId,
        input.directSessionEvidence,
        input.operationId,
        databaseTargetSchemaFor(db),
      );
      const request = { operationId: input.operationId };
      const replay = await commandReplay<OrganizationRecoveryOperation>(
        tx,
        input,
        "recovery.finalize",
        request,
      );
      if (replay) return OrganizationRecoveryOperationContract.parse(replay);
      await requireLockedCustodian(tx, account, input.actorUserId);
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
      const currentCustodians = await tx
        .select({ canonicalUserId: schema.organizationRecoveryCustodians.canonicalUserId })
        .from(schema.organizationRecoveryCustodians)
        .where(
          and(
            eq(schema.organizationRecoveryCustodians.accountId, account.id),
            eq(
              schema.organizationRecoveryCustodians.policyRevision,
              account.recoveryPolicyRevision,
            ),
            eq(schema.organizationRecoveryCustodians.enrollmentState, "accepted"),
            sql`${schema.organizationRecoveryCustodians.canonicalUserId} is not null`,
          ),
        )
        .orderBy(asc(schema.organizationRecoveryCustodians.id));
      const currentCustodianUsers = new Set(
        currentCustodians
          .map((custodian) => custodian.canonicalUserId)
          .filter((userId): userId is string => Boolean(userId)),
      );
      const approvalSessionIds = approvals
        .map((approval) => approval.authSessionId)
        .filter((sessionId): sessionId is string => Boolean(sessionId));
      const liveApprovalSessions = await liveAuthSessions(
        tx,
        databaseTargetSchemaFor(db),
        approvalSessionIds,
      );
      const activeKeyVersion = identityEvidenceKeyVersion(input.encryptionKey);
      const authenticatedUsers = new Set<string>();
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
          if (
            !approval.canonicalUserId ||
            !approval.authSessionId ||
            !currentCustodianUsers.has(approval.canonicalUserId) ||
            liveApprovalSessions.get(approval.authSessionId) !== approval.canonicalUserId
          ) {
            rejectedEvidence = true;
            continue;
          }
          authenticatedUsers.add(approval.canonicalUserId);
        } catch {
          rejectedEvidence = true;
        }
      }
      const liveCanonicalUsers = await canonicalUsersPresent(
        tx,
        databaseTargetSchemaFor(db),
        authenticatedUsers,
      );
      for (const userId of authenticatedUsers) {
        if (!liveCanonicalUsers.has(userId)) {
          authenticatedUsers.delete(userId);
          rejectedEvidence = true;
        }
      }
      if (authenticatedUsers.size < operation.quorum) {
        fail(rejectedEvidence ? "evidence_invalid" : "quorum_not_met");
      }
      // The human receiving restored team authority must have supplied one of
      // the fresh, authenticated approvals. Custodian enrollment alone cannot
      // let a non-approving finalizer take ownership from an approved quorum.
      if (!authenticatedUsers.has(input.actorUserId)) fail("quorum_not_met");
      if (account.organizationKind === "personal") {
        const authorityUserId = approvals.find(
          (approval) =>
            approval.subjectId === account.governanceAuthoritySubjectId &&
            approval.canonicalUserId !== null &&
            authenticatedUsers.has(approval.canonicalUserId),
        )?.canonicalUserId;
        if (!authorityUserId || !authenticatedUsers.has(authorityUserId)) {
          fail("quorum_not_met");
        }
      }

      const governanceRevision = account.governanceRevision + 1;
      const invalidatedAt = new Date();
      const recoveredAuthority =
        account.organizationKind === "personal"
          ? account.governanceAuthoritySubjectId!
          : `user:${input.actorUserId}`;

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
          approvalCount: authenticatedUsers.size,
          authorityRestored: true,
          authorizationInvalidated: true,
        },
      });
      const result = await operationProjection(tx, finalized!);
      await recordCommand(tx, input, "recovery.finalize", request, result);
      return result;
    },
    input.directSessionEvidence,
  );
}

async function withGovernanceTx<T>(
  db: Database,
  accountId: string,
  fn: (tx: GovernanceTx) => Promise<T>,
  directSessionEvidence?: DirectManagedSessionEvidence,
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
    // Actor/session evidence is deliberately checked only after the account,
    // active policy/custodian, canonical-user, and live-session locks have
    // been acquired by lockGovernanceBoundary inside the command callback.
    void directSessionEvidence;
    return await fn(tx);
  });
}

/**
 * One lock order for every governance command:
 * account -> active policy/custodians -> canonical auth users -> exact live
 * auth sessions -> operation -> approvals. The reads that discover operation
 * approval session ids are non-locking; the authoritative locks follow in the
 * fixed order, and every row is rejoined/validated while those locks are held.
 */
async function lockGovernanceBoundary(
  tx: GovernanceTx,
  account: AccountRow,
  actorUserId: string,
  directSessionEvidence?: DirectManagedSessionEvidence,
  operationId?: string,
  targetSchema = "public",
): Promise<void> {
  const custodians = await tx
    .select({
      id: schema.organizationRecoveryCustodians.id,
      canonicalUserId: schema.organizationRecoveryCustodians.canonicalUserId,
    })
    .from(schema.organizationRecoveryCustodians)
    .where(
      and(
        eq(schema.organizationRecoveryCustodians.accountId, account.id),
        eq(schema.organizationRecoveryCustodians.policyRevision, account.recoveryPolicyRevision),
      ),
    )
    .orderBy(asc(schema.organizationRecoveryCustodians.id))
    .for("update");

  const approvalSessionRows = operationId
    ? await tx
        .select({ authSessionId: schema.organizationRecoveryApprovals.authSessionId })
        .from(schema.organizationRecoveryApprovals)
        .where(
          and(
            eq(schema.organizationRecoveryApprovals.accountId, account.id),
            eq(schema.organizationRecoveryApprovals.operationId, operationId),
          ),
        )
        .orderBy(asc(schema.organizationRecoveryApprovals.id))
    : [];
  const userIds = new Set(
    [actorUserId, ...custodians.map((custodian) => custodian.canonicalUserId)].filter(
      (userId): userId is string => Boolean(userId?.trim()),
    ),
  );
  const authUsers = qualifiedTable(targetSchema, "auth_users");
  if (userIds.size > 0) {
    const rows = await rawRows<{ id: string }>(
      tx,
      sql`select u.id
            from ${authUsers} u
           where u.id in (${sql.join(
             [...userIds].map((userId) => sql`${userId}`),
             sql`,`,
           )})
           order by u.id
           for key share`,
    );
    if (rows.length !== userIds.size) fail("forbidden");
  }

  const sessionIds = new Set(
    [
      directSessionEvidence?.sessionId,
      ...approvalSessionRows.map((row) => row.authSessionId),
    ].filter((sessionId): sessionId is string => Boolean(sessionId?.trim())),
  );
  if (sessionIds.size > 0) {
    const authSessions = qualifiedTable(targetSchema, "auth_sessions");
    const rows = await rawRows<{ id: string }>(
      tx,
      sql`select s.id
            from ${authSessions} s
           where s.id in (${sql.join(
             [...sessionIds].map((sessionId) => sql`${sessionId}`),
             sql`,`,
           )})
             and s.expires_at > now()
           order by s.id
           for key share`,
    );
    if (rows.length !== sessionIds.size) fail("forbidden");
  }
  if (directSessionEvidence) {
    await assertDirectManagedSession(tx, directSessionEvidence, targetSchema);
  }
}

async function assertDirectManagedSession(
  tx: GovernanceTx,
  evidence: DirectManagedSessionEvidence,
  targetSchema: string,
): Promise<void> {
  const authUsers = qualifiedTable(targetSchema, "auth_users");
  const authSessions = qualifiedTable(targetSchema, "auth_sessions");
  const rows = await rawRows<{ user_id: string; session_id: string }>(
    tx,
    sql`select u.id as user_id, s.id as session_id
        from ${authUsers} u
        inner join ${authSessions} s on s.user_id = u.id
        where u.id = ${evidence.userId}
          and s.id = ${evidence.sessionId}
          and s.expires_at > now()
        for key share`,
  );
  if (
    rows.length !== 1 ||
    rows[0]?.user_id !== evidence.userId ||
    rows[0]?.session_id !== evidence.sessionId
  ) {
    fail("forbidden");
  }
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
    accountId: account.id,
    kind: account.organizationKind,
    state: account.governanceState,
    governanceRevision: account.governanceRevision,
    authorizationInvalidatedAt: account.authorizationInvalidatedAt?.toISOString() ?? null,
    recoveryPolicy:
      account.recoveryPolicyRevision > 0 && account.recoveryQuorum !== null
        ? {
            revision: account.recoveryPolicyRevision,
            quorum: account.recoveryQuorum,
            custodians: custodians.map((custodian) => ({
              enrollmentState: custodian.enrollmentState as "pending" | "accepted",
              acceptedAt: custodian.acceptedAt?.toISOString() ?? null,
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
  resolvedCustodians: Map<string, { userId: string; label: string }>,
): void {
  const subjects = new Set(custodians.map((custodian) => custodian.subjectId));
  if (subjects.size !== custodians.length || quorum < 1 || quorum > subjects.size) {
    fail("policy_required");
  }
  for (const subject of subjects) {
    if (!resolvedCustodians.has(subject)) fail("policy_required");
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
  actorUserId: string,
): Promise<void> {
  if (!actorUserId.trim()) fail("forbidden");
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
        eq(schema.organizationRecoveryCustodians.canonicalUserId, actorUserId),
        eq(schema.organizationRecoveryCustodians.enrollmentState, "accepted"),
      ),
    )
    .limit(1);
  if (!custodian) fail("forbidden");
}

export async function isAcceptedOrganizationRecoveryCustodian(
  db: Database,
  accountId: string,
  userId: string,
): Promise<boolean> {
  return await withGovernanceTx(db, accountId, async (tx) => {
    const [custodian] = await tx
      .select({ id: schema.organizationRecoveryCustodians.id })
      .from(schema.organizationRecoveryCustodians)
      .innerJoin(
        schema.managedAccounts,
        eq(schema.organizationRecoveryCustodians.accountId, schema.managedAccounts.id),
      )
      .where(
        and(
          eq(schema.organizationRecoveryCustodians.accountId, accountId),
          eq(schema.organizationRecoveryCustodians.canonicalUserId, userId),
          eq(schema.organizationRecoveryCustodians.enrollmentState, "accepted"),
          eq(
            schema.organizationRecoveryCustodians.policyRevision,
            schema.managedAccounts.recoveryPolicyRevision,
          ),
        ),
      )
      .limit(1);
    return Boolean(custodian);
  });
}

async function resolveRequestedCustodians(
  tx: GovernanceTx,
  custodians: Array<{ subjectId: string }>,
  targetSchema: string,
): Promise<Map<string, { userId: string; label: string }>> {
  const subjects = custodians.map((custodian) => custodian.subjectId);
  if (new Set(subjects).size !== subjects.length || subjects.some((subject) => !subject.trim())) {
    fail("policy_required");
  }
  const predicates = subjects.map((subject) => sql`concat('user:', u.id) = ${subject}`);
  const authUsers = qualifiedTable(targetSchema, "auth_users");
  const rows = await rawRows<{ id: string; email: string; name: string; subject_id: string }>(
    tx,
    sql`select u.id, u.email, u.name
               , concat('user:', u.id) as subject_id
        from ${authUsers} u
        where ${sql.join(predicates, sql` or `)}
        for share`,
  );
  const byId = new Map(
    rows.map((row) => [row.subject_id, { userId: row.id, label: row.email || row.name }]),
  );
  if (byId.size !== subjects.length) fail("policy_required");
  return new Map(subjects.map((subjectId) => [subjectId, byId.get(subjectId)!]));
}

function qualifiedTable(targetSchema: string, table: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(targetSchema)) {
    throw new Error("organization governance target schema is invalid");
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new Error("organization governance table is invalid");
  }
  return sql.raw(`"${targetSchema}"."${table}"`);
}

async function canonicalUsersPresent(
  tx: GovernanceTx,
  targetSchema: string,
  userIds: Set<string>,
): Promise<Set<string>> {
  if (userIds.size === 0) return new Set();
  const predicates = [...userIds].map((userId) => sql`u.id = ${userId}`);
  const rows = await rawRows<{ id: string }>(
    tx,
    sql`select u.id
        from ${qualifiedTable(targetSchema, "auth_users")} u
        where ${sql.join(predicates, sql` or `)}
        for share`,
  );
  return new Set(rows.map((row) => row.id));
}

async function liveAuthSessions(
  tx: GovernanceTx,
  targetSchema: string,
  sessionIds: string[],
): Promise<Map<string, string>> {
  const uniqueIds = [...new Set(sessionIds.filter((sessionId) => sessionId.trim()))];
  if (uniqueIds.length === 0) return new Map();
  const rows = await rawRows<{ id: string; user_id: string }>(
    tx,
    sql`select s.id, s.user_id
          from ${qualifiedTable(targetSchema, "auth_sessions")} s
         where s.id in (${sql.join(
           uniqueIds.map((sessionId) => sql`${sessionId}`),
           sql`,`,
         )})
           and s.expires_at > now()
         order by s.id
         for key share`,
  );
  return new Map(rows.map((row) => [row.id, row.user_id]));
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
  // The operation is the fourth lock class; approvals are always locked only
  // after it, in deterministic UUID order.
  await tx
    .select({ id: schema.organizationRecoveryApprovals.id })
    .from(schema.organizationRecoveryApprovals)
    .where(
      and(
        eq(schema.organizationRecoveryApprovals.accountId, account.id),
        eq(schema.organizationRecoveryApprovals.operationId, operation.id),
      ),
    )
    .orderBy(asc(schema.organizationRecoveryApprovals.id))
    .for("update");
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
