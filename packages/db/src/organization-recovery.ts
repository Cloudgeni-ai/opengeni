import { sql } from "drizzle-orm";
import type { Database } from "./database";
import { rawRows, setSubjectRlsContext, withRlsContext } from "./database";
import { nestedPostgresSqlState } from "./persistence-errors";

export type OrganizationRecoveryPolicyState =
  | "pending_acceptance"
  | "active"
  | "degraded"
  | "superseded"
  | "disabled";

export type OrganizationRecoveryOperationState =
  | "collecting"
  | "cooling"
  | "executed"
  | "cancelled"
  | "expired"
  | "superseded";

export type OrganizationRecoveryActorEvidence = {
  authorityHash: string;
  actorEpoch: string;
};

export type OrganizationRecoveryActorFence = OrganizationRecoveryActorEvidence & {
  requestId: string;
};

export type OrganizationRecoveryCapabilities = {
  configure: boolean;
  accept: boolean;
  disable: boolean;
  start: boolean;
  approve: boolean;
  cancel: boolean;
  execute: boolean;
};

export type OrganizationRecoveryMemberSummary = {
  membershipId: string;
  name: string | null;
  email: string | null;
};

export type OrganizationRecoveryOverview = {
  organizationId: string;
  availability: "available" | "recovery_unavailable";
  unavailableReason:
    | "no_policy"
    | "pending_acceptance"
    | "degraded"
    | "disabled"
    | "identity_unavailable"
    | null;
  recentReauthenticationAt: string | null;
  eligibleMembers: OrganizationRecoveryMemberSummary[];
  policy: null | {
    id: string;
    organizationId: string;
    revision: number;
    state: OrganizationRecoveryPolicyState;
    createdAt: string;
    updatedAt: string;
    custodians: Array<{
      ordinal: number;
      membershipId: string;
      name: string | null;
      email: string | null;
      enrollmentState: "pending_acceptance" | "accepted" | "ineligible";
      acceptedAt: string | null;
    }>;
  };
  operation: null | {
    id: string;
    organizationId: string;
    policyId: string;
    policyRevision: number;
    revision: number;
    state: OrganizationRecoveryOperationState;
    target: OrganizationRecoveryMemberSummary;
    approvalCount: number;
    approvals: Array<{
      membershipId: string;
      name: string | null;
      email: string | null;
      approvedAt: string;
    }>;
    quorumAt: string | null;
    executableAt: string | null;
    expiresAt: string;
    notificationJournaled: boolean;
    executedAt: string | null;
    cancelledAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
  capabilities: OrganizationRecoveryCapabilities;
};

export type OrganizationRecoveryMutationResult = {
  replay: boolean;
  overview: OrganizationRecoveryOverview;
};

export class OrganizationRecoveryDeniedError extends Error {
  readonly name = "OrganizationRecoveryDeniedError";
  readonly code = "organization_recovery_denied";
}

export class OrganizationRecoveryUnavailableError extends Error {
  readonly name = "OrganizationRecoveryUnavailableError";
  readonly code = "recovery_unavailable";
}

export class OrganizationRecoveryRevisionConflictError extends Error {
  readonly name = "OrganizationRecoveryRevisionConflictError";
  readonly code = "organization_recovery_revision_conflict";
}

export class OrganizationRecoveryOperationReuseError extends Error {
  readonly name = "OrganizationRecoveryOperationReuseError";
  readonly code = "organization_recovery_operation_reuse";
}

function mapOrganizationRecoverySqlError(error: unknown): never {
  const state = nestedPostgresSqlState(error);
  if (state === "40001") throw new OrganizationRecoveryRevisionConflictError();
  if (state === "23505") throw new OrganizationRecoveryOperationReuseError();
  if (state === "55000") {
    throw new OrganizationRecoveryUnavailableError(
      error instanceof Error ? error.message : "Organization recovery is unavailable",
    );
  }
  if (state === "42501" || state === "P0002") {
    throw new OrganizationRecoveryDeniedError(
      error instanceof Error ? error.message : "Organization recovery authority denied",
    );
  }
  throw error;
}

function asOverview(value: unknown): OrganizationRecoveryOverview {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Organization recovery returned an invalid overview");
  }
  return value as OrganizationRecoveryOverview;
}

function asMutationResult(value: unknown): OrganizationRecoveryMutationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Organization recovery returned an invalid mutation result");
  }
  const candidate = value as { replay?: unknown; overview?: unknown };
  if (typeof candidate.replay !== "boolean") {
    throw new Error("Organization recovery returned an invalid replay result");
  }
  return { replay: candidate.replay, overview: asOverview(candidate.overview) };
}

async function scopedRecoveryJson(
  db: Database,
  organizationId: string,
  actorSubjectId: string,
  query: (scopedDb: Database) => Promise<unknown>,
): Promise<OrganizationRecoveryOverview> {
  try {
    return await withRlsContext(
      db,
      { accountId: organizationId, workspaceId: null },
      async (scopedDb) => {
        await setSubjectRlsContext(scopedDb, actorSubjectId);
        return asOverview(await query(scopedDb));
      },
    );
  } catch (error) {
    mapOrganizationRecoverySqlError(error);
  }
}

async function runRecoveryCommand(
  db: Database,
  command: Record<string, unknown> & {
    organizationId: string;
    actorSubjectId: string;
  },
): Promise<OrganizationRecoveryMutationResult> {
  try {
    return await withRlsContext(
      db,
      { accountId: command.organizationId, workspaceId: null },
      async (scopedDb) => {
        await setSubjectRlsContext(scopedDb, command.actorSubjectId);
        const [row] = await rawRows<{ result: unknown }>(
          scopedDb,
          sql`select organization_recovery_command(${JSON.stringify(command)}::jsonb) as result`,
        );
        return asMutationResult(row?.result);
      },
    );
  } catch (error) {
    mapOrganizationRecoverySqlError(error);
  }
}

export async function getOrganizationRecoveryOverview(
  db: Database,
  input: {
    organizationId: string;
    actorSubjectId: string;
    actorAuthUserId: string;
    actorAuthSessionId: string;
    actorFence: OrganizationRecoveryActorEvidence | null;
  },
): Promise<OrganizationRecoveryOverview> {
  return await scopedRecoveryJson(
    db,
    input.organizationId,
    input.actorSubjectId,
    async (scopedDb) => {
      const [row] = await rawRows<{ result: unknown }>(
        scopedDb,
        sql`select get_organization_recovery_overview(
          ${input.organizationId}::uuid, ${input.actorSubjectId},
          ${input.actorFence ? JSON.stringify(input.actorFence) : null}::jsonb,
          ${input.actorAuthSessionId}, ${input.actorAuthUserId}
        ) as result`,
      );
      return row?.result;
    },
  );
}

type RecoveryMutationBase = {
  organizationId: string;
  actorSubjectId: string;
  actorAuthUserId: string;
  actorAuthSessionId: string;
  operationId: string;
  actorFence: OrganizationRecoveryActorFence;
};

export type OrganizationRecoveryNotificationClaim = {
  attemptId: string;
  outboxId: string;
  deliveryId: string;
  provider: string;
  claimOwner: string;
  attemptNumber: number;
  leaseExpiresAt: string;
  idempotencyKey: string;
  recipientCanonicalIdentityId: string;
  notificationType: "recovery_quorum_started";
  payloadDigest: string;
  payload: Record<string, unknown>;
};

export type OrganizationRecoveryNotificationSettlement = {
  outboxId: string;
  deliveryId: string;
  claimOwner: string;
  attemptNumber: number;
  phase: "sent" | "failed" | "outcome_unknown";
  providerMessageId: string | null;
  errorClass: string | null;
  settledAt: string;
  replay: boolean;
};

export type OrganizationRecoveryNotificationReconciliation = {
  outboxId: string;
  deliveryId: string;
  reconciliationOwner: string;
  attemptNumber: number;
  resolution: "sent" | "retry";
  providerMessageId: string | null;
  reconciledAt: string;
  replay: boolean;
};

function asObject<T>(value: unknown, label: string): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Organization recovery returned invalid ${label}`);
  }
  return value as T;
}

export async function prepareOrganizationRecoveryNotifications(
  db: Database,
  input: {
    provider: string;
    claimOwner: string;
    limit: number;
    leaseSeconds: number;
  },
): Promise<OrganizationRecoveryNotificationClaim[]> {
  const [row] = await rawRows<{ result: unknown }>(
    db,
    sql`select prepare_organization_recovery_notifications(
      ${input.provider}, ${input.claimOwner}, ${input.limit}::integer,
      ${input.leaseSeconds}::integer
    ) as result`,
  );
  if (!Array.isArray(row?.result)) {
    throw new Error("Organization recovery returned invalid notification claims");
  }
  return row.result as OrganizationRecoveryNotificationClaim[];
}

export const claimOrganizationRecoveryNotifications = prepareOrganizationRecoveryNotifications;

export async function settleOrganizationRecoveryNotification(
  db: Database,
  input: {
    outboxId: string;
    deliveryId: string;
    claimOwner: string;
    phase: "sent" | "failed" | "outcome_unknown";
    providerMessageId?: string | null;
    errorClass?: string | null;
  },
): Promise<OrganizationRecoveryNotificationSettlement> {
  const [row] = await rawRows<{ result: unknown }>(
    db,
    sql`select settle_organization_recovery_notification(
      ${input.outboxId}::uuid, ${input.deliveryId}::uuid, ${input.claimOwner},
      ${input.phase}, ${input.providerMessageId ?? null}, ${input.errorClass ?? null}
    ) as result`,
  );
  return asObject<OrganizationRecoveryNotificationSettlement>(
    row?.result,
    "notification settlement",
  );
}

export async function reconcileOrganizationRecoveryNotification(
  db: Database,
  input: {
    outboxId: string;
    deliveryId: string;
    reconciliationOwner: string;
    resolution: "sent" | "retry";
    providerMessageId?: string | null;
  },
): Promise<OrganizationRecoveryNotificationReconciliation> {
  const [row] = await rawRows<{ result: unknown }>(
    db,
    sql`select reconcile_organization_recovery_notification(
      ${input.outboxId}::uuid, ${input.deliveryId}::uuid,
      ${input.reconciliationOwner}, ${input.resolution},
      ${input.providerMessageId ?? null}
    ) as result`,
  );
  return asObject<OrganizationRecoveryNotificationReconciliation>(
    row?.result,
    "notification reconciliation",
  );
}

export async function configureOrganizationRecoveryPolicy(
  db: Database,
  input: RecoveryMutationBase & {
    expectedPolicyRevision: number;
    custodianMembershipIds: [string, string, string];
  },
): Promise<OrganizationRecoveryMutationResult> {
  return await runRecoveryCommand(db, { action: "configure_policy", ...input });
}

export async function acceptOrganizationRecoveryCustody(
  db: Database,
  input: RecoveryMutationBase & { expectedPolicyRevision: number },
): Promise<OrganizationRecoveryMutationResult> {
  return await runRecoveryCommand(db, { action: "accept_custody", ...input });
}

export async function disableOrganizationRecoveryPolicy(
  db: Database,
  input: RecoveryMutationBase & { expectedPolicyRevision: number },
): Promise<OrganizationRecoveryMutationResult> {
  return await runRecoveryCommand(db, { action: "disable_policy", ...input });
}

export async function startOrganizationRecoveryOperation(
  db: Database,
  input: RecoveryMutationBase & {
    expectedPolicyRevision: number;
    targetMembershipId: string;
  },
): Promise<OrganizationRecoveryMutationResult> {
  return await runRecoveryCommand(db, { action: "start_operation", ...input });
}

type RecoveryOperationMutation = RecoveryMutationBase & {
  recoveryOperationId: string;
  expectedOperationRevision: number;
};

export async function approveOrganizationRecoveryOperation(
  db: Database,
  input: RecoveryOperationMutation,
): Promise<OrganizationRecoveryMutationResult> {
  return await runRecoveryCommand(db, {
    action: "approve_operation",
    ...input,
  });
}

export async function cancelOrganizationRecoveryOperation(
  db: Database,
  input: RecoveryOperationMutation,
): Promise<OrganizationRecoveryMutationResult> {
  return await runRecoveryCommand(db, { action: "cancel_operation", ...input });
}

export async function executeOrganizationRecoveryOperation(
  db: Database,
  input: RecoveryOperationMutation,
): Promise<OrganizationRecoveryMutationResult> {
  return await runRecoveryCommand(db, {
    action: "execute_operation",
    ...input,
  });
}
