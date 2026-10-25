import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";
import { Permission } from "./permissions";

export const OrganizationMembershipRole = /* @__PURE__ */ defineSchema(() =>
  z.enum(["owner", "admin", "member"]),
);
export type OrganizationMembershipRole = z.infer<typeof OrganizationMembershipRole>;

export const WorkspaceMemberRole = /* @__PURE__ */ defineSchema(() =>
  z.enum(["viewer", "member", "admin", "custom"]),
);
export type WorkspaceMemberRole = z.infer<typeof WorkspaceMemberRole>;

export const AssignableWorkspaceMemberRole = /* @__PURE__ */ defineSchema(() =>
  z.enum(["viewer", "member", "admin"]),
);
export type AssignableWorkspaceMemberRole = z.infer<typeof AssignableWorkspaceMemberRole>;

export const OrganizationInvitationStatus = /* @__PURE__ */ defineSchema(() =>
  z.enum(["pending", "accepted", "revoked", "expired"]),
);
export type OrganizationInvitationStatus = z.infer<typeof OrganizationInvitationStatus>;

export const OrganizationUserSetupDeliveryState = /* @__PURE__ */ defineSchema(() =>
  z.enum(["pending", "sent", "failed", "outcome_unknown", "revoked"]),
);
export type OrganizationUserSetupDeliveryState = z.infer<typeof OrganizationUserSetupDeliveryState>;

export const OrganizationUserSetupDelivery = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid,
    state: OrganizationUserSetupDeliveryState,
    attemptCount: primitives.nonnegativeInteger,
    revision: primitives.positiveInteger,
    errorClass: z.string().min(1).max(64).nullable(),
    retryState: z.enum(["available", "reconciliation_required", "unavailable"]),
    sentAt: primitives.string.datetime({ offset: true }).nullable(),
    updatedAt: primitives.string.datetime({ offset: true }),
  }),
);
export type OrganizationUserSetupDelivery = z.infer<typeof OrganizationUserSetupDelivery>;

export const OrganizationInvitation = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid,
    organizationId: primitives.uuid,
    organizationName: primitives.string.trim().min(1).max(120).nullable().default(null),
    targetEmail: z.string().email(),
    targetName: primitives.string.trim().min(1).max(120).nullable().default(null),
    initialWorkspaceIds: z.array(primitives.uuid).max(100).default([]),
    role: OrganizationMembershipRole,
    status: OrganizationInvitationStatus,
    revision: primitives.positiveInteger,
    expiresAt: primitives.string.datetime({ offset: true }),
    acceptedMembershipId: primitives.nullableUuid,
    createdAt: primitives.string.datetime({ offset: true }),
    updatedAt: primitives.string.datetime({ offset: true }),
    delivery: OrganizationUserSetupDelivery.nullable().default(null),
  }),
);
export type OrganizationInvitation = z.infer<typeof OrganizationInvitation>;

export const OrganizationMember = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid,
    organizationId: primitives.uuid,
    subjectId: z.string().min(1).max(1024),
    name: z.string().min(1).max(1024).nullable().default(null),
    email: z.string().email().max(320).nullable().default(null),
    role: OrganizationMembershipRole,
    status: z.enum(["provisioning", "active", "suspended", "revoked"]),
    authorizationRevision: primitives.positiveInteger,
    personalWorkspaceId: primitives.nullableUuid,
    revokedAt: primitives.string.datetime({ offset: true }).nullable(),
    personalRetentionUntil: primitives.string.datetime({ offset: true }).nullable(),
    createdAt: primitives.string.datetime({ offset: true }),
    updatedAt: primitives.string.datetime({ offset: true }),
  }),
);
export type OrganizationMember = z.infer<typeof OrganizationMember>;

export const OrganizationAdministrationMemberWorkspaceAccess = /* @__PURE__ */ defineSchema(() =>
  z.object({
    workspaceId: primitives.uuid,
    workspaceName: z.string().min(1).max(255),
    membershipId: primitives.uuid,
    role: WorkspaceMemberRole,
    updatedAt: primitives.string.datetime({ offset: true }),
  }),
);
export type OrganizationAdministrationMemberWorkspaceAccess = z.infer<
  typeof OrganizationAdministrationMemberWorkspaceAccess
>;

/** Safe admin projection. Personal-workspace and personal-resource metadata are absent. */
export const OrganizationAdministrationMember = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid,
    organizationId: primitives.uuid,
    subjectId: z.string().min(1).max(1024),
    name: z.string().min(1).max(1024).nullable(),
    email: z.string().email().max(320).nullable(),
    role: OrganizationMembershipRole,
    status: z.enum(["provisioning", "active", "suspended", "revoked"]),
    authorizationRevision: primitives.positiveInteger,
    sharedWorkspaceAccess: z.array(OrganizationAdministrationMemberWorkspaceAccess).max(500),
    revokedAt: primitives.string.datetime({ offset: true }).nullable(),
    createdAt: primitives.string.datetime({ offset: true }),
    updatedAt: primitives.string.datetime({ offset: true }),
  }),
);
export type OrganizationAdministrationMember = z.infer<typeof OrganizationAdministrationMember>;

export const OrganizationSummary = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid,
    name: primitives.string.trim().min(1).max(120),
    createdAt: primitives.string.datetime({ offset: true }),
    updatedAt: primitives.string.datetime({ offset: true }),
  }),
);
export type OrganizationSummary = z.infer<typeof OrganizationSummary>;

export const OrganizationPrivateSessionSettings = /* @__PURE__ */ defineSchema(() =>
  z.object({
    organizationId: primitives.uuid,
    enabled: primitives.boolean,
    available: primitives.boolean,
    version: primitives.nonnegativeInteger,
    updatedAt: primitives.string.datetime({ offset: true }),
    changed: primitives.optionalBoolean,
  }),
);
export type OrganizationPrivateSessionSettings = z.infer<typeof OrganizationPrivateSessionSettings>;

export const UpdateOrganizationPrivateSessionSettingsRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      enabled: primitives.boolean,
      expectedVersion: primitives.nonnegativeInteger,
      operationId: primitives.uuid,
    })
    .strict(),
);
export type UpdateOrganizationPrivateSessionSettingsRequest = z.infer<
  typeof UpdateOrganizationPrivateSessionSettingsRequest
>;

/**
 * An organization's privacy choices, after the deployment's limits. A product
 * that embeds Opengeni can only narrow these: `limits` says which choices are
 * fixed for every organization on this deployment.
 */
export const OrganizationPrivacySettings = /* @__PURE__ */ defineSchema(() =>
  z.object({
    organizationId: primitives.uuid,
    /** Who can see new chats and schedules unless the person picks otherwise. */
    defaultVisibility: z.enum(["private", "workspace"]),
    /** Whether people have their own Personal workspace to see and work in. */
    personalWorkspaces: z.boolean(),
    /** Whether admins see that other people's Only me schedules exist, and can pause them. */
    adminsSeePrivateSchedules: primitives.boolean,
    limits: z.object({
      /** False when this deployment turns Only me off in shared workspaces. */
      onlyMeAllowed: primitives.boolean,
      /** True when new chats and schedules always start as Workspace. */
      defaultVisibilityLocked: primitives.boolean,
      /** True when admins always see that other people's Only me schedules exist. */
      adminsSeePrivateSchedulesLocked: primitives.boolean,
    }),
    updatedAt: primitives.string.datetime({ offset: true }).nullable(),
  }),
);
export type OrganizationPrivacySettings = z.infer<typeof OrganizationPrivacySettings>;

export const UpdateOrganizationPrivacySettingsRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      defaultVisibility: z.enum(["private", "workspace"]).optional(),
      adminsSeePrivateSchedules: primitives.optionalBoolean,
      personalWorkspaces: z.boolean().optional(),
    })
    .strict()
    .refine(
      (value) =>
        value.defaultVisibility !== undefined ||
        value.adminsSeePrivateSchedules !== undefined ||
        value.personalWorkspaces !== undefined,
      { message: "Change at least one setting." },
    ),
);
export type UpdateOrganizationPrivacySettingsRequest = z.infer<
  typeof UpdateOrganizationPrivacySettingsRequest
>;

export const OrganizationWorkspaceAccessMember = /* @__PURE__ */ defineSchema(() =>
  z.object({
    membershipId: primitives.uuid,
    organizationMembershipId: primitives.nullableUuid,
    subjectId: z.string().min(1).max(1024),
    name: z.string().min(1).max(1024).nullable(),
    email: z.string().email().max(320).nullable(),
    subjectLabel: z.string().min(1).max(1024).nullable(),
    principalKind: z.enum(["human", "service"]),
    organizationRole: OrganizationMembershipRole.nullable(),
    role: WorkspaceMemberRole,
    permissions: z.array(z.string().min(1).max(128)),
    createdAt: primitives.string.datetime({ offset: true }),
    updatedAt: primitives.string.datetime({ offset: true }),
  }),
);
export type OrganizationWorkspaceAccessMember = z.infer<typeof OrganizationWorkspaceAccessMember>;

export const OrganizationWorkspaceAccess = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid,
    name: primitives.nonEmptyString,
    slug: primitives.nullableString,
    createdAt: primitives.string.datetime({ offset: true }),
    updatedAt: primitives.string.datetime({ offset: true }),
    members: z.array(OrganizationWorkspaceAccessMember).max(1000),
  }),
);
export type OrganizationWorkspaceAccess = z.infer<typeof OrganizationWorkspaceAccess>;

export const OrganizationWorkspaceRoleDefinition = /* @__PURE__ */ defineSchema(() =>
  z.object({
    role: AssignableWorkspaceMemberRole,
    label: z.string().min(1).max(64),
    description: z.string().min(1).max(512),
    permissions: z.array(Permission).min(1),
  }),
);
export type OrganizationWorkspaceRoleDefinition = z.infer<
  typeof OrganizationWorkspaceRoleDefinition
>;

export const OrganizationAdministrationOverview = /* @__PURE__ */ defineSchema(() =>
  z.object({
    organization: OrganizationSummary,
    roles: z.array(OrganizationWorkspaceRoleDefinition).length(3),
    workspaces: z.array(OrganizationWorkspaceAccess).max(500),
  }),
);
export type OrganizationAdministrationOverview = z.infer<typeof OrganizationAdministrationOverview>;

export const CreateOrganizationWorkspaceRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      name: primitives.string.trim().min(1).max(120),
      operationId: primitives.uuid,
    })
    .strict(),
);
export type CreateOrganizationWorkspaceRequest = z.infer<typeof CreateOrganizationWorkspaceRequest>;

export const UpdateOrganizationWorkspaceRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      name: primitives.string.trim().min(1).max(120),
      expectedUpdatedAt: primitives.string.datetime({ offset: true }),
      operationId: primitives.uuid,
    })
    .strict(),
);
export type UpdateOrganizationWorkspaceRequest = z.infer<typeof UpdateOrganizationWorkspaceRequest>;

export const PutOrganizationWorkspaceMemberRequest = /* @__PURE__ */ defineSchema(() =>
  z.discriminatedUnion("role", [
    z
      .object({
        role: AssignableWorkspaceMemberRole,
        expectedUpdatedAt: primitives.string.datetime({ offset: true }).nullable(),
        operationId: primitives.uuid,
      })
      .strict(),
    z
      .object({
        role: z.literal("custom"),
        permissions: z.array(Permission).max(128),
        expectedUpdatedAt: primitives.string.datetime({ offset: true }).nullable(),
        operationId: primitives.uuid,
      })
      .strict(),
  ]),
);
export type PutOrganizationWorkspaceMemberRequest = z.infer<
  typeof PutOrganizationWorkspaceMemberRequest
>;

export const RevokeOrganizationWorkspaceMemberRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      expectedUpdatedAt: primitives.string.datetime({ offset: true }),
      operationId: primitives.uuid,
    })
    .strict(),
);
export type RevokeOrganizationWorkspaceMemberRequest = z.infer<
  typeof RevokeOrganizationWorkspaceMemberRequest
>;

export const RevokeOrganizationWorkspaceMemberResponse = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      removed: primitives.boolean,
      replay: primitives.boolean,
    })
    .strict(),
);
export type RevokeOrganizationWorkspaceMemberResponse = z.infer<
  typeof RevokeOrganizationWorkspaceMemberResponse
>;

export const CreateOrganizationRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    name: primitives.string.trim().min(1).max(120),
    operationId: primitives.uuid,
  }),
);
export type CreateOrganizationRequest = z.infer<typeof CreateOrganizationRequest>;

export const CreateOrganizationResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    organization: OrganizationSummary,
    workspaceId: primitives.uuid,
  }),
);
export type CreateOrganizationResponse = z.infer<typeof CreateOrganizationResponse>;

export const CreateAdditionalOrganizationRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      name: primitives.string.trim().min(1).max(120),
      workspaceName: primitives.string.trim().min(1).max(120),
      operationId: primitives.uuid,
    })
    .strict(),
);
export type CreateAdditionalOrganizationRequest = z.infer<
  typeof CreateAdditionalOrganizationRequest
>;

export const CreateAdditionalOrganizationResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    organization: OrganizationSummary,
    workspaceId: primitives.uuid,
    personalWorkspaceId: primitives.uuid,
  }),
);
export type CreateAdditionalOrganizationResponse = z.infer<
  typeof CreateAdditionalOrganizationResponse
>;

export const UpdateOrganizationNameRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    name: primitives.string.trim().min(1).max(120),
    expectedUpdatedAt: primitives.string.datetime({ offset: true }),
    operationId: primitives.uuid,
  }),
);
export type UpdateOrganizationNameRequest = z.infer<typeof UpdateOrganizationNameRequest>;

export const OrganizationRetentionPolicy = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      organizationId: primitives.uuid,
      mode: z.enum(["retain", "delete_after"]),
      retentionDays: z.number().int().min(30).max(90).nullable(),
      version: primitives.positiveInteger,
      updatedAt: primitives.string.datetime({ offset: true }),
    })
    .superRefine((value, context) => {
      if ((value.mode === "retain") !== (value.retentionDays === null)) {
        context.addIssue({
          code: "custom",
          path: ["retentionDays"],
          message: "retain requires no duration; delete_after requires a duration",
        });
      }
    }),
);
export type OrganizationRetentionPolicy = z.infer<typeof OrganizationRetentionPolicy>;

export const OrganizationRetentionDeletionClaim = /* @__PURE__ */ defineSchema(() =>
  z.object({
    organizationId: primitives.uuid,
    membershipId: primitives.uuid,
    operationId: primitives.uuid,
    retentionUntil: primitives.string.datetime({ offset: true }),
    claimExpiresAt: primitives.string.datetime({ offset: true }),
    personalWorkspaceId: primitives.nullableUuid,
    objectCount: primitives.nonnegativeInteger,
    deletedObjectCount: primitives.nonnegativeInteger,
  }),
);
export type OrganizationRetentionDeletionClaim = z.infer<typeof OrganizationRetentionDeletionClaim>;

export const OrganizationRetentionDeletionObject = /* @__PURE__ */ defineSchema(() =>
  z.object({
    objectKind: z.enum([
      "file",
      "session_recording",
      "browser_state_artifact",
      "browser_state_upload",
      "transcription_recording_object",
      "video_staging_reference",
      "workspace_artifact_version",
      "editable_artifact_blob",
      "workspace_capture_manifest",
      "workspace_capture_tree_index",
      "workspace_capture_blob",
    ]),
    sourceId: z.string().min(1).max(2048),
    objectBucket: z.string().min(1).max(1024),
    objectKey: z.string().min(1).max(4096),
  }),
);
export type OrganizationRetentionDeletionObject = z.infer<
  typeof OrganizationRetentionDeletionObject
>;

export const OrganizationRetentionDatabaseFinalization = /* @__PURE__ */ defineSchema(() =>
  z.object({
    organizationId: primitives.uuid,
    membershipId: primitives.uuid,
    operationId: primitives.uuid,
    outcome: z.literal("cleanup_pending"),
    objectBucket: z.string().min(1).max(1024),
    objectCount: primitives.nonnegativeInteger,
    deletedResources: z.record(primitives.string, primitives.nonnegativeInteger),
    databaseFinalizedAt: primitives.string.datetime({ offset: true }),
  }),
);
export type OrganizationRetentionDatabaseFinalization = z.infer<
  typeof OrganizationRetentionDatabaseFinalization
>;

export const OrganizationRetentionDeletionResult = /* @__PURE__ */ defineSchema(() =>
  z.object({
    organizationId: primitives.uuid,
    membershipId: primitives.uuid,
    operationId: primitives.uuid,
    outcome: z.enum(["completed", "already_completed"]),
    deletedResources: z.record(primitives.string, primitives.nonnegativeInteger),
    completedAt: primitives.string.datetime({ offset: true }),
  }),
);
export type OrganizationRetentionDeletionResult = z.infer<
  typeof OrganizationRetentionDeletionResult
>;

export const OrganizationRetentionDeletionPreview = /* @__PURE__ */ defineSchema(() =>
  z.object({
    membershipId: primitives.uuid,
    retentionUntil: primitives.string.datetime({ offset: true }),
    personalWorkspaceId: primitives.nullableUuid,
    resourceCount: primitives.nonnegativeInteger,
    objectCount: primitives.nonnegativeInteger,
  }),
);
export type OrganizationRetentionDeletionPreview = z.infer<
  typeof OrganizationRetentionDeletionPreview
>;

export const CreateOrganizationInvitationRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    email: z.string().email().max(320),
    name: primitives.string.trim().min(1).max(120).optional(),
    initialWorkspaceIds: z.array(primitives.uuid).max(100).default([]),
    role: OrganizationMembershipRole.default("member"),
    expiresAt: primitives.string.datetime({ offset: true }),
    operationId: primitives.uuid,
  }),
);
export type CreateOrganizationInvitationRequest = z.infer<
  typeof CreateOrganizationInvitationRequest
>;

/**
 * Public, signed-out completion contract for an invitation-bound account setup.
 * The bearer is delivered out of band to the invited email address. It is
 * never persisted in plaintext; `operationId` makes an outcome-unknown retry
 * converge on the first committed result.
 */
export const CompleteOrganizationUserSetupRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    token: z.string().min(32).max(2048),
    name: primitives.string.trim().min(1).max(120),
    password: z.string().min(8).max(128),
    operationId: primitives.uuid,
  }),
);
export type CompleteOrganizationUserSetupRequest = z.infer<
  typeof CompleteOrganizationUserSetupRequest
>;

export const CompleteOrganizationUserSetupResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    status: z.literal("complete"),
  }),
);
export type CompleteOrganizationUserSetupResponse = z.infer<
  typeof CompleteOrganizationUserSetupResponse
>;

export const PreviewOrganizationUserSetupRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({ token: z.string().min(32).max(2048) }).strict(),
);
export type PreviewOrganizationUserSetupRequest = z.infer<
  typeof PreviewOrganizationUserSetupRequest
>;

export const OrganizationUserSetupPreviewWorkspace = /* @__PURE__ */ defineSchema(() =>
  z.object({
    workspaceId: primitives.uuid,
    workspaceName: z.string().min(1).max(255),
    role: AssignableWorkspaceMemberRole,
  }),
);
export type OrganizationUserSetupPreviewWorkspace = z.infer<
  typeof OrganizationUserSetupPreviewWorkspace
>;

const OrganizationUserSetupPreviewUnavailable = /* @__PURE__ */ defineSchema(() =>
  z.object({
    state: z.enum(["unavailable", "expired", "revoked", "completed"]),
  }),
);
const OrganizationUserSetupPreviewPending = /* @__PURE__ */ defineSchema(() =>
  z.object({
    state: z.literal("pending"),
    organizationId: primitives.uuid,
    organizationName: primitives.string.trim().min(1).max(120),
    targetEmail: z.string().email().max(320),
    targetName: primitives.string.trim().min(1).max(120).nullable(),
    organizationRole: OrganizationMembershipRole,
    sharedWorkspaceAccess: z.array(OrganizationUserSetupPreviewWorkspace).max(100),
    expiresAt: primitives.string.datetime({ offset: true }),
  }),
);
export const OrganizationUserSetupPreview = /* @__PURE__ */ defineSchema(() =>
  z.discriminatedUnion("state", [
    OrganizationUserSetupPreviewUnavailable,
    OrganizationUserSetupPreviewPending,
  ]),
);
export type OrganizationUserSetupPreview = z.infer<typeof OrganizationUserSetupPreview>;

export const RetryOrganizationUserSetupDeliveryRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({ operationId: primitives.uuid }).strict(),
);
export type RetryOrganizationUserSetupDeliveryRequest = z.infer<
  typeof RetryOrganizationUserSetupDeliveryRequest
>;

/** Authenticated organization-name-only setup after ordinary account creation. */
export const CompleteSelfServiceOrganizationSetupRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    organizationName: primitives.string.trim().min(1).max(120),
    operationId: primitives.uuid,
    /**
     * The signup answer to "How do you want to use Opengeni?": get help with
     * everyday things (`everyday`), add AI agents to a product (`embed`) or run
     * agents in the cloud (`cloud`). Stored once per person and organization;
     * the first answer wins.
     */
    useCase: z.enum(["everyday", "embed", "cloud"]).optional(),
  }),
);
export type CompleteSelfServiceOrganizationSetupRequest = z.infer<
  typeof CompleteSelfServiceOrganizationSetupRequest
>;

export const CompleteSelfServiceOrganizationSetupResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    status: z.literal("complete"),
    organizationId: primitives.uuid,
    personalWorkspaceId: primitives.uuid,
  }),
);
export type CompleteSelfServiceOrganizationSetupResponse = z.infer<
  typeof CompleteSelfServiceOrganizationSetupResponse
>;

export const SelfServiceOrganizationOnboardingStatus = /* @__PURE__ */ defineSchema(() =>
  z.object({
    state: z.enum(["required", "invitation_pending", "unavailable", "complete"]),
  }),
);
export type SelfServiceOrganizationOnboardingStatus = z.infer<
  typeof SelfServiceOrganizationOnboardingStatus
>;

export const AcceptOrganizationInvitationRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    expectedRevision: primitives.positiveInteger,
    operationId: primitives.uuid,
  }),
);
export type AcceptOrganizationInvitationRequest = z.infer<
  typeof AcceptOrganizationInvitationRequest
>;

export const RevokeOrganizationInvitationRequest = AcceptOrganizationInvitationRequest;
export type RevokeOrganizationInvitationRequest = z.infer<
  typeof RevokeOrganizationInvitationRequest
>;

export const OrganizationMemberTransitionKind = /* @__PURE__ */ defineSchema(() =>
  z.enum(["change_role", "suspend", "reactivate", "offboard"]),
);
export type OrganizationMemberTransitionKind = z.infer<typeof OrganizationMemberTransitionKind>;

export const UpdateOrganizationMemberRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      kind: OrganizationMemberTransitionKind,
      role: OrganizationMembershipRole.optional(),
      expectedAuthorizationRevision: primitives.positiveInteger,
      operationId: primitives.uuid,
      reason: primitives.string.trim().min(1).max(512).optional(),
    })
    .superRefine((value, context) => {
      if ((value.kind === "change_role") !== (value.role !== undefined)) {
        context.addIssue({
          code: "custom",
          path: ["role"],
          message: "role is required only for change_role",
        });
      }
    }),
);
export type UpdateOrganizationMemberRequest = z.infer<typeof UpdateOrganizationMemberRequest>;

export const UpdateOrganizationRetentionPolicyRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      mode: z.enum(["retain", "delete_after"]),
      retentionDays: z.number().int().min(30).max(90).nullable(),
      expectedVersion: primitives.positiveInteger,
      operationId: primitives.uuid,
    })
    .superRefine((value, context) => {
      if ((value.mode === "retain") !== (value.retentionDays === null)) {
        context.addIssue({
          code: "custom",
          path: ["retentionDays"],
          message: "retain requires no duration; delete_after requires a duration",
        });
      }
    }),
);
export type UpdateOrganizationRetentionPolicyRequest = z.infer<
  typeof UpdateOrganizationRetentionPolicyRequest
>;

export const ListOrganizationInvitationsResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    invitations: z.array(OrganizationInvitation).max(101),
  }),
);
export const ListOrganizationInvitationsPageQuery = /* @__PURE__ */ defineSchema(() =>
  z.object({
    cursor: primitives.optionalUuid,
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
);
export type ListOrganizationInvitationsPageQuery = z.infer<
  typeof ListOrganizationInvitationsPageQuery
>;
export const ListOrganizationInvitationsPageResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    invitations: z.array(OrganizationInvitation).max(100),
    nextCursor: primitives.nullableUuid,
  }),
);
export type ListOrganizationInvitationsPageResponse = z.infer<
  typeof ListOrganizationInvitationsPageResponse
>;
export const AcceptOrganizationInvitationResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    invitation: OrganizationInvitation,
    membership: OrganizationMember,
  }),
);
export type AcceptOrganizationInvitationResponse = z.infer<
  typeof AcceptOrganizationInvitationResponse
>;
export const ListOrganizationMembersResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    members: z.array(OrganizationMember),
  }),
);
export const ListOrganizationAdministrationMembersResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    members: z.array(OrganizationAdministrationMember).max(1000),
  }),
);
export const ListSelfOrganizationMembershipsResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    memberships: z.array(OrganizationMember),
  }),
);
