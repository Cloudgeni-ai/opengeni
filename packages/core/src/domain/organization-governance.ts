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
  acceptOrganizationRecoveryCustodian,
  approveOrganizationRecovery,
  cancelOrganizationRecoveryOperation,
  createOrganizationRecoveryOperation,
  finalizeOrganizationRecovery,
  getOrganizationGovernance,
  isAcceptedOrganizationRecoveryCustodian,
  lockOrganizationGovernance,
  OrganizationGovernanceError,
  revokeOrganizationRecoveryApproval,
  setOrganizationRecoveryPolicy,
  type Database,
} from "@opengeni/db";
import { directManagedSessionEvidenceFor, type DirectManagedSessionEvidence } from "../access";
import { HTTPException } from "hono/http-exception";

type GovernanceDeps = { db: Database; governanceDb?: Database; settings: Settings };

function governanceDatabase(deps: GovernanceDeps): Database {
  return deps.governanceDb ?? deps.db;
}

export async function requireOrganizationGovernanceAdmin(
  deps: GovernanceDeps,
  context: AccessContext,
  accountId: string,
): Promise<OrganizationGovernance> {
  requireOrganizationGovernanceEnabled(deps.settings);
  requireManagedGovernanceMode(context);
  const grant = context.accountGrants.find((candidate) => candidate.accountId === accountId);
  if (!grant?.permissions.includes("account:admin")) {
    throw new HTTPException(403, { message: "organization access denied" });
  }
  const governance = await getOrganizationGovernance(governanceDatabase(deps), accountId);
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
  requireOrganizationGovernanceEnabled(deps.settings);
  requireManagedGovernanceMode(context);
  const governance = await getOrganizationGovernance(governanceDatabase(deps), accountId);
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
  requireOrganizationGovernanceEnabled(deps.settings);
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
  requireOrganizationGovernanceEnabled(deps.settings);
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
  requireOrganizationGovernanceEnabled(deps.settings);
  const evidence = directManagedSessionEvidenceFor(context);
  const directlyAuthenticatedHuman =
    context.mode === "managed" &&
    evidence !== null &&
    context.subjectId === `user:${evidence.userId}`;
  if (!directlyAuthenticatedHuman || !evidence) {
    throw new HTTPException(403, { message: "human recovery custodian required" });
  }
  if (
    !(await isAcceptedOrganizationRecoveryCustodian(
      governanceDatabase(deps),
      accountId,
      evidence.userId,
    ))
  ) {
    throw new HTTPException(403, { message: "organization recovery access denied" });
  }
  const governance = await getOrganizationGovernance(governanceDatabase(deps), accountId);
  if (!governance) throw new HTTPException(404, { message: "organization not found" });
  return governance;
}

export async function readOrganizationGovernance(
  deps: GovernanceDeps,
  context: AccessContext,
  accountId: string,
): Promise<OrganizationGovernance> {
  requireOrganizationGovernanceEnabled(deps.settings);
  const governance = await getOrganizationGovernance(governanceDatabase(deps), accountId);
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
    setOrganizationRecoveryPolicy(governanceDatabase(deps), {
      accountId,
      actorSubjectId: context.subjectId,
      actorUserId: context.subjectId.slice("user:".length),
      ...(directManagedSessionEvidenceFor(context)
        ? { directSessionEvidence: directManagedSessionEvidenceFor(context)! }
        : {}),
      expectedGovernanceRevision: request.expectedGovernanceRevision,
      quorum: request.quorum,
      custodians: request.custodians.map((custodian) => ({
        subjectId: custodian.subjectId,
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
  requireOrganizationGovernanceEnabled(deps.settings);
  await requireOrganizationGovernanceAdminOrLockedReplay(deps, context, accountId);
  return await mapGovernanceError(() =>
    lockOrganizationGovernance(governanceDatabase(deps), {
      accountId,
      actorSubjectId: context.subjectId,
      actorUserId: requireDirectManagedUserId(context),
      directSessionEvidence: requireDirectManagedEvidence(context),
      ...request,
    }),
  );
}

export async function acceptOrganizationRecoveryCustodianForRequest(
  deps: GovernanceDeps,
  context: AccessContext,
  accountId: string,
): Promise<OrganizationGovernance> {
  requireOrganizationGovernanceEnabled(deps.settings);
  const evidence = requireDirectManagedEvidence(context);
  const userId = requireDirectManagedUserId(context);
  return await mapGovernanceError(() =>
    acceptOrganizationRecoveryCustodian(governanceDatabase(deps), {
      accountId,
      actorSubjectId: `user:${userId}`,
      actorUserId: userId,
      directSessionEvidence: evidence,
      idempotencyKey: `policy-${accountId}-accept-${userId}`,
    }),
  );
}

export async function beginOrganizationRecovery(
  deps: GovernanceDeps,
  context: AccessContext,
  accountId: string,
  request: CreateOrganizationRecoveryOperationRequest,
): Promise<OrganizationRecoveryOperation> {
  requireOrganizationGovernanceEnabled(deps.settings);
  const evidence = requireDirectManagedEvidence(context);
  const userId = requireDirectManagedUserId(context);
  await requireOrganizationRecoveryCustodianOrReplay(deps, context, accountId);
  return await mapGovernanceError(() =>
    createOrganizationRecoveryOperation(governanceDatabase(deps), {
      accountId,
      actorSubjectId: context.subjectId,
      actorUserId: userId,
      directSessionEvidence: evidence,
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
  requireOrganizationGovernanceEnabled(deps.settings);
  const evidence = requireDirectManagedEvidence(context);
  const userId = requireDirectManagedUserId(context);
  await requireOrganizationRecoveryCustodianOrReplay(deps, context, accountId);
  const encryptionKey = requireOrganizationEvidenceEncryption(deps.settings);
  const receiptIdentitySecret = requireOrganizationReceiptIdentitySecret(deps.settings);
  return await mapGovernanceError(() =>
    approveOrganizationRecovery(governanceDatabase(deps), {
      accountId,
      operationId,
      actorSubjectId: context.subjectId,
      actorUserId: userId,
      directSessionEvidence: evidence,
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
  requireOrganizationGovernanceEnabled(deps.settings);
  const evidence = requireDirectManagedEvidence(context);
  const userId = requireDirectManagedUserId(context);
  await requireOrganizationRecoveryCustodianOrReplay(deps, context, accountId);
  return await mapGovernanceError(() =>
    revokeOrganizationRecoveryApproval(governanceDatabase(deps), {
      accountId,
      operationId,
      actorSubjectId: context.subjectId,
      actorUserId: userId,
      directSessionEvidence: evidence,
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
  requireOrganizationGovernanceEnabled(deps.settings);
  const evidence = requireDirectManagedEvidence(context);
  const userId = requireDirectManagedUserId(context);
  await requireOrganizationRecoveryCustodianOrReplay(deps, context, accountId);
  return await mapGovernanceError(() =>
    cancelOrganizationRecoveryOperation(governanceDatabase(deps), {
      accountId,
      operationId,
      actorSubjectId: context.subjectId,
      actorUserId: userId,
      directSessionEvidence: evidence,
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
  requireOrganizationGovernanceEnabled(deps.settings);
  const evidence = requireDirectManagedEvidence(context);
  const userId = requireDirectManagedUserId(context);
  await requireOrganizationRecoveryCustodianOrReplay(deps, context, accountId);
  const encryptionKey = requireOrganizationEvidenceEncryption(deps.settings);
  return await mapGovernanceError(() =>
    finalizeOrganizationRecovery(governanceDatabase(deps), {
      accountId,
      operationId,
      actorSubjectId: context.subjectId,
      actorUserId: userId,
      directSessionEvidence: evidence,
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

function requireOrganizationGovernanceEnabled(settings: Settings): void {
  if (!settings.organizationGovernanceEnabled) {
    throw new HTTPException(404, { message: "organization governance is unavailable" });
  }
}

function requireDirectManagedEvidence(context: AccessContext): DirectManagedSessionEvidence {
  const evidence = directManagedSessionEvidenceFor(context);
  if (!evidence || context.mode !== "managed" || context.subjectId !== `user:${evidence.userId}`) {
    throw new HTTPException(403, { message: "human recovery custodian required" });
  }
  return evidence;
}

function requireDirectManagedUserId(context: AccessContext): string {
  return requireDirectManagedEvidence(context).userId;
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
