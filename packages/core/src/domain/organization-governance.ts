import {
  environmentsEncryptionKeyBytes,
  organizationRecoveryReceiptIdentitySecretBytes,
  type Settings,
} from "@opengeni/config";
import type {
  AccessContext,
  ApproveOrganizationRecoveryRequest,
  CreateOrganizationRecoveryOperationRequest,
  LockOrganizationGovernanceRequest,
  OrganizationGovernance,
  OrganizationRecoveryCommandRequest,
  OrganizationRecoveryOperation,
  SetOrganizationRecoveryPolicyRequest,
} from "@opengeni/contracts";
import {
  approveOrganizationRecovery,
  cancelOrganizationRecoveryOperation,
  createOrganizationRecoveryOperation,
  finalizeOrganizationRecovery,
  getOrganizationGovernance,
  lockOrganizationGovernance,
  OrganizationGovernanceError,
  revokeOrganizationRecoveryApproval,
  setOrganizationRecoveryPolicy,
  type Database,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";

type GovernanceDeps = { db: Database; settings: Settings };

export async function requireOrganizationGovernanceAdmin(
  deps: GovernanceDeps,
  context: AccessContext,
  accountId: string,
): Promise<OrganizationGovernance> {
  requireManagedGovernanceMode(context);
  const grant = context.accountGrants.find((candidate) => candidate.accountId === accountId);
  if (!grant?.permissions.includes("account:admin")) {
    throw new HTTPException(403, { message: "organization access denied" });
  }
  const governance = await getOrganizationGovernance(deps.db, accountId);
  if (!governance) throw new HTTPException(404, { message: "organization not found" });
  if (governance.state !== "active") {
    throw new HTTPException(423, { message: "organization governance is locked" });
  }
  return governance;
}

/**
 * Authorize a new governance lock while active, or let a previously scoped
 * actor reach the database's actor-bound idempotency receipt after the lock
 * committed. In the locked state the database can only replay the same
 * subject/key/request; its active-state precondition rejects every fresh lock.
 */
export async function requireOrganizationGovernanceAdminOrLockedReplay(
  deps: GovernanceDeps,
  context: AccessContext,
  accountId: string,
): Promise<OrganizationGovernance> {
  requireManagedGovernanceMode(context);
  const governance = await getOrganizationGovernance(deps.db, accountId);
  if (!governance) throw new HTTPException(404, { message: "organization not found" });
  if (governance.state === "active") {
    return await requireOrganizationGovernanceAdmin(deps, context, accountId);
  }
  const previouslyScoped = [...context.accountGrants, ...context.workspaceGrants].some(
    (grant) => grant.accountId === accountId,
  );
  if (!previouslyScoped) {
    throw new HTTPException(403, { message: "organization access denied" });
  }
  return governance;
}

export async function requireOrganizationRecoveryCustodian(
  deps: GovernanceDeps,
  context: AccessContext,
  accountId: string,
): Promise<OrganizationGovernance> {
  const governance = await requireOrganizationRecoveryCustodianIdentity(deps, context, accountId);
  if (governance.state !== "governance_locked") {
    throw new HTTPException(409, { message: "organization is not governance locked" });
  }
  return governance;
}

/**
 * Recovery commands use this gate so an enrolled direct human can reach an
 * existing actor-scoped receipt after successful finalization made the account
 * active. The persistence transaction rejects every fresh command while active.
 */
export async function requireOrganizationRecoveryCustodianOrReplay(
  deps: GovernanceDeps,
  context: AccessContext,
  accountId: string,
): Promise<OrganizationGovernance> {
  return await requireOrganizationRecoveryCustodianIdentity(deps, context, accountId);
}

async function requireOrganizationRecoveryCustodianIdentity(
  deps: GovernanceDeps,
  context: AccessContext,
  accountId: string,
): Promise<OrganizationGovernance> {
  // A user-shaped delegated bearer is still a non-human credential and may be
  // held by an agent. Exceptional recovery therefore requires a direct
  // managed-auth session, not merely a user:* subject string.
  const directlyAuthenticatedHuman =
    context.mode === "managed" &&
    context.subjectId.startsWith("user:") &&
    context.accountGrants.some(
      (grant) => grant.subjectId === context.subjectId && grant.metadata?.authType === "managed",
    );
  if (!directlyAuthenticatedHuman) {
    throw new HTTPException(403, { message: "human recovery custodian required" });
  }
  const governance = await getOrganizationGovernance(deps.db, accountId);
  if (!governance) throw new HTTPException(404, { message: "organization not found" });
  if (
    !governance.recoveryPolicy?.custodians.some(
      (custodian) => custodian.subjectId === context.subjectId,
    )
  ) {
    throw new HTTPException(403, { message: "organization recovery access denied" });
  }
  return governance;
}

export async function readOrganizationGovernance(
  deps: GovernanceDeps,
  context: AccessContext,
  accountId: string,
): Promise<OrganizationGovernance> {
  const governance = await getOrganizationGovernance(deps.db, accountId);
  if (!governance) throw new HTTPException(404, { message: "organization not found" });
  if (governance.state === "governance_locked") {
    await requireOrganizationRecoveryCustodian(deps, context, accountId);
  } else {
    await requireOrganizationGovernanceAdmin(deps, context, accountId);
  }
  return governance;
}

export async function enrollOrganizationRecoveryPolicy(
  deps: GovernanceDeps,
  context: AccessContext,
  accountId: string,
  request: SetOrganizationRecoveryPolicyRequest,
): Promise<OrganizationGovernance> {
  await requireOrganizationGovernanceAdmin(deps, context, accountId);
  return await mapGovernanceError(() =>
    setOrganizationRecoveryPolicy(deps.db, {
      accountId,
      actorSubjectId: context.subjectId,
      expectedGovernanceRevision: request.expectedGovernanceRevision,
      quorum: request.quorum,
      custodians: request.custodians.map((custodian) => ({
        subjectId: custodian.subjectId,
        ...(custodian.subjectLabel ? { subjectLabel: custodian.subjectLabel } : {}),
      })),
      idempotencyKey: request.idempotencyKey,
    }),
  );
}

export async function lockOrganizationForRecovery(
  deps: GovernanceDeps,
  context: AccessContext,
  accountId: string,
  request: LockOrganizationGovernanceRequest,
): Promise<OrganizationGovernance> {
  await requireOrganizationGovernanceAdminOrLockedReplay(deps, context, accountId);
  return await mapGovernanceError(() =>
    lockOrganizationGovernance(deps.db, {
      accountId,
      actorSubjectId: context.subjectId,
      ...request,
    }),
  );
}

export async function beginOrganizationRecovery(
  deps: GovernanceDeps,
  context: AccessContext,
  accountId: string,
  request: CreateOrganizationRecoveryOperationRequest,
): Promise<OrganizationRecoveryOperation> {
  await requireOrganizationRecoveryCustodianOrReplay(deps, context, accountId);
  return await mapGovernanceError(() =>
    createOrganizationRecoveryOperation(deps.db, {
      accountId,
      actorSubjectId: context.subjectId,
      idempotencyKey: request.idempotencyKey,
    }),
  );
}

export async function approveOrganizationRecoveryForRequest(
  deps: GovernanceDeps,
  context: AccessContext,
  accountId: string,
  operationId: string,
  request: ApproveOrganizationRecoveryRequest,
): Promise<OrganizationRecoveryOperation> {
  await requireOrganizationRecoveryCustodianOrReplay(deps, context, accountId);
  const encryptionKey = requireOrganizationEvidenceEncryption(deps.settings);
  const receiptIdentitySecret = requireOrganizationReceiptIdentitySecret(deps.settings);
  return await mapGovernanceError(() =>
    approveOrganizationRecovery(deps.db, {
      accountId,
      operationId,
      actorSubjectId: context.subjectId,
      evidence: request.evidence,
      encryptionKey,
      receiptIdentitySecret,
      idempotencyKey: request.idempotencyKey,
    }),
  );
}

export async function revokeOrganizationRecoveryForRequest(
  deps: GovernanceDeps,
  context: AccessContext,
  accountId: string,
  operationId: string,
  request: OrganizationRecoveryCommandRequest,
): Promise<OrganizationRecoveryOperation> {
  await requireOrganizationRecoveryCustodianOrReplay(deps, context, accountId);
  return await mapGovernanceError(() =>
    revokeOrganizationRecoveryApproval(deps.db, {
      accountId,
      operationId,
      actorSubjectId: context.subjectId,
      idempotencyKey: request.idempotencyKey,
    }),
  );
}

export async function cancelOrganizationRecoveryForRequest(
  deps: GovernanceDeps,
  context: AccessContext,
  accountId: string,
  operationId: string,
  request: OrganizationRecoveryCommandRequest,
): Promise<OrganizationRecoveryOperation> {
  await requireOrganizationRecoveryCustodianOrReplay(deps, context, accountId);
  return await mapGovernanceError(() =>
    cancelOrganizationRecoveryOperation(deps.db, {
      accountId,
      operationId,
      actorSubjectId: context.subjectId,
      idempotencyKey: request.idempotencyKey,
    }),
  );
}

export async function finalizeOrganizationRecoveryForRequest(
  deps: GovernanceDeps,
  context: AccessContext,
  accountId: string,
  operationId: string,
  request: OrganizationRecoveryCommandRequest,
): Promise<OrganizationRecoveryOperation> {
  await requireOrganizationRecoveryCustodianOrReplay(deps, context, accountId);
  const encryptionKey = requireOrganizationEvidenceEncryption(deps.settings);
  return await mapGovernanceError(() =>
    finalizeOrganizationRecovery(deps.db, {
      accountId,
      operationId,
      actorSubjectId: context.subjectId,
      encryptionKey,
      idempotencyKey: request.idempotencyKey,
    }),
  );
}

export function requireOrganizationEvidenceEncryption(settings: Settings): Uint8Array {
  const key = environmentsEncryptionKeyBytes(settings);
  if (!key) {
    throw new HTTPException(503, { message: "organization recovery is unavailable" });
  }
  return key;
}

export function requireOrganizationReceiptIdentitySecret(settings: Settings): Uint8Array {
  const secret = organizationRecoveryReceiptIdentitySecretBytes(settings);
  if (!secret) {
    throw new HTTPException(503, { message: "organization recovery is unavailable" });
  }
  return secret;
}

function requireManagedGovernanceMode(context: AccessContext): void {
  if (context.mode !== "managed") {
    throw new HTTPException(403, { message: "organization governance requires managed access" });
  }
}

async function mapGovernanceError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (!(error instanceof OrganizationGovernanceError)) throw error;
    switch (error.code) {
      case "not_found":
        throw new HTTPException(404, { message: "organization recovery operation not found" });
      case "forbidden":
        throw new HTTPException(403, { message: "organization recovery access denied" });
      case "operation_expired":
        throw new HTTPException(410, { message: "organization recovery operation expired" });
      case "policy_required":
        throw new HTTPException(422, { message: "invalid organization recovery policy" });
      case "evidence_invalid":
        throw new HTTPException(409, { message: "fresh recovery approval evidence required" });
      case "quorum_not_met":
        throw new HTTPException(409, { message: "organization recovery quorum not met" });
      case "active_required":
      case "locked_required":
      case "revision_conflict":
      case "operation_conflict":
      case "idempotency_conflict":
        throw new HTTPException(409, { message: "organization recovery state conflict" });
    }
  }
}
