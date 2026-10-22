import { defineSchema } from "./define-schema";
import { z } from "zod";

const Uuid = /* @__PURE__ */ defineSchema(() => z.string().uuid());
const Timestamp = /* @__PURE__ */ defineSchema(() => z.string().datetime({ offset: true }));

export const OrganizationRecoveryPolicyState = /* @__PURE__ */ defineSchema(() =>
  z.enum(["pending_acceptance", "active", "degraded", "superseded", "disabled"]),
);
export type OrganizationRecoveryPolicyState = z.infer<typeof OrganizationRecoveryPolicyState>;

export const OrganizationRecoveryOperationState = /* @__PURE__ */ defineSchema(() =>
  z.enum(["collecting", "cooling", "executed", "cancelled", "expired", "superseded"]),
);
export type OrganizationRecoveryOperationState = z.infer<typeof OrganizationRecoveryOperationState>;

export const OrganizationRecoveryUnavailableReason = /* @__PURE__ */ defineSchema(() =>
  z.enum(["no_policy", "pending_acceptance", "degraded", "disabled", "identity_unavailable"]),
);
export type OrganizationRecoveryUnavailableReason = z.infer<
  typeof OrganizationRecoveryUnavailableReason
>;

export const OrganizationRecoveryMemberSummary = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      membershipId: Uuid,
      name: z.string().trim().min(1).max(1024).nullable(),
      email: z.string().email().max(320).nullable(),
    })
    .strict(),
);
export type OrganizationRecoveryMemberSummary = z.infer<typeof OrganizationRecoveryMemberSummary>;

export const OrganizationRecoveryCustodian = /* @__PURE__ */ defineSchema(() =>
  OrganizationRecoveryMemberSummary.extend({
    ordinal: z.number().int().min(1).max(3),
    enrollmentState: z.enum(["pending_acceptance", "accepted", "ineligible"]),
    acceptedAt: Timestamp.nullable(),
  }).strict(),
);
export type OrganizationRecoveryCustodian = z.infer<typeof OrganizationRecoveryCustodian>;

export const OrganizationRecoveryPolicy = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      id: Uuid,
      organizationId: Uuid,
      revision: z.number().int().positive(),
      state: OrganizationRecoveryPolicyState,
      custodians: z.array(OrganizationRecoveryCustodian).length(3),
      createdAt: Timestamp,
      updatedAt: Timestamp,
    })
    .strict(),
);
export type OrganizationRecoveryPolicy = z.infer<typeof OrganizationRecoveryPolicy>;

export const OrganizationRecoveryApproval = /* @__PURE__ */ defineSchema(() =>
  OrganizationRecoveryMemberSummary.extend({
    approvedAt: Timestamp,
  }).strict(),
);
export type OrganizationRecoveryApproval = z.infer<typeof OrganizationRecoveryApproval>;

export const OrganizationRecoveryOperation = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      id: Uuid,
      organizationId: Uuid,
      policyId: Uuid,
      policyRevision: z.number().int().positive(),
      revision: z.number().int().positive(),
      state: OrganizationRecoveryOperationState,
      target: OrganizationRecoveryMemberSummary,
      approvals: z.array(OrganizationRecoveryApproval).max(3),
      approvalCount: z.number().int().min(0).max(3),
      quorumAt: Timestamp.nullable(),
      executableAt: Timestamp.nullable(),
      expiresAt: Timestamp,
      executedAt: Timestamp.nullable(),
      cancelledAt: Timestamp.nullable(),
      notificationJournaled: z.boolean(),
      createdAt: Timestamp,
      updatedAt: Timestamp,
    })
    .strict(),
);
export type OrganizationRecoveryOperation = z.infer<typeof OrganizationRecoveryOperation>;

export const OrganizationRecoveryCapabilities = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      configure: z.boolean(),
      accept: z.boolean(),
      disable: z.boolean(),
      start: z.boolean(),
      approve: z.boolean(),
      cancel: z.boolean(),
      execute: z.boolean(),
    })
    .strict(),
);
export type OrganizationRecoveryCapabilities = z.infer<typeof OrganizationRecoveryCapabilities>;

export const OrganizationRecoveryOverview = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      organizationId: Uuid,
      availability: z.enum(["available", "recovery_unavailable"]),
      unavailableReason: OrganizationRecoveryUnavailableReason.nullable(),
      recentReauthenticationAt: Timestamp.nullable(),
      eligibleMembers: z.array(OrganizationRecoveryMemberSummary).max(1000),
      policy: OrganizationRecoveryPolicy.nullable(),
      operation: OrganizationRecoveryOperation.nullable(),
      capabilities: OrganizationRecoveryCapabilities,
    })
    .strict(),
);
export type OrganizationRecoveryOverview = z.infer<typeof OrganizationRecoveryOverview>;

const ExpectedPolicyRevision = /* @__PURE__ */ defineSchema(() => z.number().int().nonnegative());
const ExpectedOperationRevision = /* @__PURE__ */ defineSchema(() => z.number().int().positive());
const CommandOperationId = Uuid;

export const ConfigureOrganizationRecoveryPolicyRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      custodianMembershipIds: z.tuple([Uuid, Uuid, Uuid]).superRefine((ids, context) => {
        if (new Set(ids).size !== 3) {
          context.addIssue({
            code: "custom",
            message: "recovery custodians must be three distinct memberships",
          });
        }
      }),
      expectedPolicyRevision: ExpectedPolicyRevision,
      operationId: CommandOperationId,
    })
    .strict(),
);
export type ConfigureOrganizationRecoveryPolicyRequest = z.infer<
  typeof ConfigureOrganizationRecoveryPolicyRequest
>;

export const AcceptOrganizationRecoveryCustodyRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      expectedPolicyRevision: ExpectedPolicyRevision,
      operationId: CommandOperationId,
    })
    .strict(),
);
export type AcceptOrganizationRecoveryCustodyRequest = z.infer<
  typeof AcceptOrganizationRecoveryCustodyRequest
>;

export const DisableOrganizationRecoveryPolicyRequest = AcceptOrganizationRecoveryCustodyRequest;
export type DisableOrganizationRecoveryPolicyRequest = z.infer<
  typeof DisableOrganizationRecoveryPolicyRequest
>;

export const StartOrganizationRecoveryOperationRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      targetMembershipId: Uuid,
      expectedPolicyRevision: z.number().int().positive(),
      operationId: CommandOperationId,
    })
    .strict(),
);
export type StartOrganizationRecoveryOperationRequest = z.infer<
  typeof StartOrganizationRecoveryOperationRequest
>;

export const OrganizationRecoveryOperationCommandRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      expectedOperationRevision: ExpectedOperationRevision,
      operationId: CommandOperationId,
    })
    .strict(),
);
export type OrganizationRecoveryOperationCommandRequest = z.infer<
  typeof OrganizationRecoveryOperationCommandRequest
>;

export const OrganizationRecoveryMutationResponse = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      replay: z.boolean(),
      overview: OrganizationRecoveryOverview,
    })
    .strict(),
);
export type OrganizationRecoveryMutationResponse = z.infer<
  typeof OrganizationRecoveryMutationResponse
>;
