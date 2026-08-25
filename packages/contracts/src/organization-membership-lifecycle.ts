import { z } from "zod";
import { Permission } from "./permissions";

export const OrganizationMembershipRole = z.enum(["owner", "admin", "member"]);
export type OrganizationMembershipRole = z.infer<typeof OrganizationMembershipRole>;

export const WorkspaceMemberRole = z.enum(["viewer", "member", "admin", "custom"]);
export type WorkspaceMemberRole = z.infer<typeof WorkspaceMemberRole>;

export const AssignableWorkspaceMemberRole = z.enum(["viewer", "member", "admin"]);
export type AssignableWorkspaceMemberRole = z.infer<typeof AssignableWorkspaceMemberRole>;

export const OrganizationInvitationStatus = z.enum(["pending", "accepted", "revoked", "expired"]);
export type OrganizationInvitationStatus = z.infer<typeof OrganizationInvitationStatus>;

export const OrganizationUserSetupDeliveryState = z.enum([
  "pending",
  "sent",
  "failed",
  "outcome_unknown",
  "revoked",
]);
export type OrganizationUserSetupDeliveryState = z.infer<typeof OrganizationUserSetupDeliveryState>;

export const OrganizationUserSetupDelivery = z.object({
  id: z.string().uuid(),
  state: OrganizationUserSetupDeliveryState,
  attemptCount: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
  errorClass: z.string().min(1).max(64).nullable(),
  sentAt: z.string().datetime({ offset: true }).nullable(),
  updatedAt: z.string().datetime({ offset: true }),
});
export type OrganizationUserSetupDelivery = z.infer<typeof OrganizationUserSetupDelivery>;

export const OrganizationInvitation = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  organizationName: z.string().trim().min(1).max(120).nullable().default(null),
  targetEmail: z.string().email(),
  targetName: z.string().trim().min(1).max(120).nullable().default(null),
  initialWorkspaceIds: z.array(z.string().uuid()).max(100).default([]),
  role: OrganizationMembershipRole,
  status: OrganizationInvitationStatus,
  revision: z.number().int().positive(),
  expiresAt: z.string().datetime({ offset: true }),
  acceptedMembershipId: z.string().uuid().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  delivery: OrganizationUserSetupDelivery.nullable().default(null),
});
export type OrganizationInvitation = z.infer<typeof OrganizationInvitation>;

export const OrganizationMember = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  subjectId: z.string().min(1).max(1024),
  name: z.string().min(1).max(1024).nullable().default(null),
  email: z.string().email().max(320).nullable().default(null),
  role: OrganizationMembershipRole,
  status: z.enum(["provisioning", "active", "suspended", "revoked"]),
  authorizationRevision: z.number().int().positive(),
  personalWorkspaceId: z.string().uuid().nullable(),
  revokedAt: z.string().datetime({ offset: true }).nullable(),
  personalRetentionUntil: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type OrganizationMember = z.infer<typeof OrganizationMember>;

export const OrganizationAdministrationMemberWorkspaceAccess = z.object({
  workspaceId: z.string().uuid(),
  workspaceName: z.string().min(1).max(255),
  membershipId: z.string().uuid(),
  role: WorkspaceMemberRole,
  updatedAt: z.string().datetime({ offset: true }),
});
export type OrganizationAdministrationMemberWorkspaceAccess = z.infer<
  typeof OrganizationAdministrationMemberWorkspaceAccess
>;

/** Safe admin projection. Personal-workspace and personal-resource metadata are absent. */
export const OrganizationAdministrationMember = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  subjectId: z.string().min(1).max(1024),
  name: z.string().min(1).max(1024).nullable(),
  email: z.string().email().max(320).nullable(),
  role: OrganizationMembershipRole,
  status: z.enum(["provisioning", "active", "suspended", "revoked"]),
  authorizationRevision: z.number().int().positive(),
  sharedWorkspaceAccess: z.array(OrganizationAdministrationMemberWorkspaceAccess).max(500),
  revokedAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type OrganizationAdministrationMember = z.infer<typeof OrganizationAdministrationMember>;

export const OrganizationSummary = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type OrganizationSummary = z.infer<typeof OrganizationSummary>;

export const OrganizationPrivateSessionSettings = z.object({
  organizationId: z.string().uuid(),
  enabled: z.boolean(),
  available: z.boolean(),
  version: z.number().int().nonnegative(),
  updatedAt: z.string().datetime({ offset: true }),
  changed: z.boolean().optional(),
});
export type OrganizationPrivateSessionSettings = z.infer<typeof OrganizationPrivateSessionSettings>;

export const UpdateOrganizationPrivateSessionSettingsRequest = z
  .object({
    enabled: z.boolean(),
    expectedVersion: z.number().int().nonnegative(),
    operationId: z.string().uuid(),
  })
  .strict();
export type UpdateOrganizationPrivateSessionSettingsRequest = z.infer<
  typeof UpdateOrganizationPrivateSessionSettingsRequest
>;

export const OrganizationWorkspaceAccessMember = z.object({
  membershipId: z.string().uuid(),
  organizationMembershipId: z.string().uuid().nullable(),
  subjectId: z.string().min(1).max(1024),
  name: z.string().min(1).max(1024).nullable(),
  email: z.string().email().max(320).nullable(),
  subjectLabel: z.string().min(1).max(1024).nullable(),
  principalKind: z.enum(["human", "service"]),
  organizationRole: OrganizationMembershipRole.nullable(),
  role: WorkspaceMemberRole,
  permissions: z.array(z.string().min(1).max(128)),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type OrganizationWorkspaceAccessMember = z.infer<typeof OrganizationWorkspaceAccessMember>;

export const OrganizationWorkspaceAccess = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  slug: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  members: z.array(OrganizationWorkspaceAccessMember).max(1000),
});
export type OrganizationWorkspaceAccess = z.infer<typeof OrganizationWorkspaceAccess>;

export const OrganizationWorkspaceRoleDefinition = z.object({
  role: AssignableWorkspaceMemberRole,
  label: z.string().min(1).max(64),
  description: z.string().min(1).max(512),
  permissions: z.array(Permission).min(1),
});
export type OrganizationWorkspaceRoleDefinition = z.infer<
  typeof OrganizationWorkspaceRoleDefinition
>;

export const OrganizationAdministrationOverview = z.object({
  organization: OrganizationSummary,
  roles: z.array(OrganizationWorkspaceRoleDefinition).length(3),
  workspaces: z.array(OrganizationWorkspaceAccess).max(500),
});
export type OrganizationAdministrationOverview = z.infer<typeof OrganizationAdministrationOverview>;

export const CreateOrganizationWorkspaceRequest = z
  .object({
    name: z.string().trim().min(1).max(120),
    operationId: z.string().uuid(),
  })
  .strict();
export type CreateOrganizationWorkspaceRequest = z.infer<typeof CreateOrganizationWorkspaceRequest>;

export const UpdateOrganizationWorkspaceRequest = z
  .object({
    name: z.string().trim().min(1).max(120),
    expectedUpdatedAt: z.string().datetime({ offset: true }),
    operationId: z.string().uuid(),
  })
  .strict();
export type UpdateOrganizationWorkspaceRequest = z.infer<typeof UpdateOrganizationWorkspaceRequest>;

export const PutOrganizationWorkspaceMemberRequest = z.discriminatedUnion("role", [
  z
    .object({
      role: AssignableWorkspaceMemberRole,
      expectedUpdatedAt: z.string().datetime({ offset: true }).nullable(),
      operationId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      role: z.literal("custom"),
      permissions: z.array(Permission).max(128),
      expectedUpdatedAt: z.string().datetime({ offset: true }).nullable(),
      operationId: z.string().uuid(),
    })
    .strict(),
]);
export type PutOrganizationWorkspaceMemberRequest = z.infer<
  typeof PutOrganizationWorkspaceMemberRequest
>;

export const RevokeOrganizationWorkspaceMemberRequest = z
  .object({
    expectedUpdatedAt: z.string().datetime({ offset: true }),
    operationId: z.string().uuid(),
  })
  .strict();
export type RevokeOrganizationWorkspaceMemberRequest = z.infer<
  typeof RevokeOrganizationWorkspaceMemberRequest
>;

export const RevokeOrganizationWorkspaceMemberResponse = z
  .object({
    removed: z.boolean(),
    replay: z.boolean(),
  })
  .strict();
export type RevokeOrganizationWorkspaceMemberResponse = z.infer<
  typeof RevokeOrganizationWorkspaceMemberResponse
>;

export const CreateOrganizationRequest = z.object({
  name: z.string().trim().min(1).max(120),
  operationId: z.string().uuid(),
});
export type CreateOrganizationRequest = z.infer<typeof CreateOrganizationRequest>;

export const CreateOrganizationResponse = z.object({
  organization: OrganizationSummary,
  workspaceId: z.string().uuid(),
});
export type CreateOrganizationResponse = z.infer<typeof CreateOrganizationResponse>;

export const UpdateOrganizationNameRequest = z.object({
  name: z.string().trim().min(1).max(120),
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  operationId: z.string().uuid(),
});
export type UpdateOrganizationNameRequest = z.infer<typeof UpdateOrganizationNameRequest>;

export const OrganizationRetentionPolicy = z
  .object({
    organizationId: z.string().uuid(),
    mode: z.enum(["retain", "delete_after"]),
    retentionDays: z.number().int().min(30).max(90).nullable(),
    version: z.number().int().positive(),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .superRefine((value, context) => {
    if ((value.mode === "retain") !== (value.retentionDays === null)) {
      context.addIssue({
        code: "custom",
        path: ["retentionDays"],
        message: "retain requires no duration; delete_after requires a duration",
      });
    }
  });
export type OrganizationRetentionPolicy = z.infer<typeof OrganizationRetentionPolicy>;

export const OrganizationRetentionDeletionClaim = z.object({
  organizationId: z.string().uuid(),
  membershipId: z.string().uuid(),
  operationId: z.string().uuid(),
  retentionUntil: z.string().datetime({ offset: true }),
  claimExpiresAt: z.string().datetime({ offset: true }),
  personalWorkspaceId: z.string().uuid().nullable(),
  objectCount: z.number().int().nonnegative(),
  deletedObjectCount: z.number().int().nonnegative(),
});
export type OrganizationRetentionDeletionClaim = z.infer<typeof OrganizationRetentionDeletionClaim>;

export const OrganizationRetentionDeletionObject = z.object({
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
});
export type OrganizationRetentionDeletionObject = z.infer<
  typeof OrganizationRetentionDeletionObject
>;

export const OrganizationRetentionDatabaseFinalization = z.object({
  organizationId: z.string().uuid(),
  membershipId: z.string().uuid(),
  operationId: z.string().uuid(),
  outcome: z.literal("cleanup_pending"),
  objectBucket: z.string().min(1).max(1024),
  objectCount: z.number().int().nonnegative(),
  deletedResources: z.record(z.string(), z.number().int().nonnegative()),
  databaseFinalizedAt: z.string().datetime({ offset: true }),
});
export type OrganizationRetentionDatabaseFinalization = z.infer<
  typeof OrganizationRetentionDatabaseFinalization
>;

export const OrganizationRetentionDeletionResult = z.object({
  organizationId: z.string().uuid(),
  membershipId: z.string().uuid(),
  operationId: z.string().uuid(),
  outcome: z.enum(["completed", "already_completed"]),
  deletedResources: z.record(z.string(), z.number().int().nonnegative()),
  completedAt: z.string().datetime({ offset: true }),
});
export type OrganizationRetentionDeletionResult = z.infer<
  typeof OrganizationRetentionDeletionResult
>;

export const OrganizationRetentionDeletionPreview = z.object({
  membershipId: z.string().uuid(),
  retentionUntil: z.string().datetime({ offset: true }),
  personalWorkspaceId: z.string().uuid().nullable(),
  resourceCount: z.number().int().nonnegative(),
  objectCount: z.number().int().nonnegative(),
});
export type OrganizationRetentionDeletionPreview = z.infer<
  typeof OrganizationRetentionDeletionPreview
>;

export const CreateOrganizationInvitationRequest = z.object({
  email: z.string().email().max(320),
  name: z.string().trim().min(1).max(120).optional(),
  initialWorkspaceIds: z.array(z.string().uuid()).max(100).default([]),
  role: OrganizationMembershipRole.default("member"),
  expiresAt: z.string().datetime({ offset: true }),
  operationId: z.string().uuid(),
});
export type CreateOrganizationInvitationRequest = z.infer<
  typeof CreateOrganizationInvitationRequest
>;

/**
 * Public, signed-out completion contract for an invitation-bound account setup.
 * The bearer is delivered out of band to the invited email address. It is
 * never persisted in plaintext; `operationId` makes an outcome-unknown retry
 * converge on the first committed result.
 */
export const CompleteOrganizationUserSetupRequest = z.object({
  token: z.string().min(32).max(2048),
  name: z.string().trim().min(1).max(120),
  password: z.string().min(8).max(128),
  operationId: z.string().uuid(),
});
export type CompleteOrganizationUserSetupRequest = z.infer<
  typeof CompleteOrganizationUserSetupRequest
>;

export const CompleteOrganizationUserSetupResponse = z.object({
  status: z.literal("complete"),
});
export type CompleteOrganizationUserSetupResponse = z.infer<
  typeof CompleteOrganizationUserSetupResponse
>;

export const PreviewOrganizationUserSetupRequest = z
  .object({ token: z.string().min(32).max(2048) })
  .strict();
export type PreviewOrganizationUserSetupRequest = z.infer<
  typeof PreviewOrganizationUserSetupRequest
>;

export const OrganizationUserSetupPreviewWorkspace = z.object({
  workspaceId: z.string().uuid(),
  workspaceName: z.string().min(1).max(255),
  role: AssignableWorkspaceMemberRole,
});
export type OrganizationUserSetupPreviewWorkspace = z.infer<
  typeof OrganizationUserSetupPreviewWorkspace
>;

const OrganizationUserSetupPreviewUnavailable = z.object({
  state: z.enum(["unavailable", "expired", "revoked", "completed"]),
});
const OrganizationUserSetupPreviewPending = z.object({
  state: z.literal("pending"),
  organizationId: z.string().uuid(),
  organizationName: z.string().trim().min(1).max(120),
  targetEmail: z.string().email().max(320),
  targetName: z.string().trim().min(1).max(120).nullable(),
  organizationRole: OrganizationMembershipRole,
  sharedWorkspaceAccess: z.array(OrganizationUserSetupPreviewWorkspace).max(100),
  expiresAt: z.string().datetime({ offset: true }),
});
export const OrganizationUserSetupPreview = z.discriminatedUnion("state", [
  OrganizationUserSetupPreviewUnavailable,
  OrganizationUserSetupPreviewPending,
]);
export type OrganizationUserSetupPreview = z.infer<typeof OrganizationUserSetupPreview>;

export const RetryOrganizationUserSetupDeliveryRequest = z
  .object({ operationId: z.string().uuid() })
  .strict();
export type RetryOrganizationUserSetupDeliveryRequest = z.infer<
  typeof RetryOrganizationUserSetupDeliveryRequest
>;

/** Authenticated organization-name-only setup after ordinary account creation. */
export const CompleteSelfServiceOrganizationSetupRequest = z.object({
  organizationName: z.string().trim().min(1).max(120),
  operationId: z.string().uuid(),
});
export type CompleteSelfServiceOrganizationSetupRequest = z.infer<
  typeof CompleteSelfServiceOrganizationSetupRequest
>;

export const CompleteSelfServiceOrganizationSetupResponse = z.object({
  status: z.literal("complete"),
  organizationId: z.string().uuid(),
  personalWorkspaceId: z.string().uuid(),
});
export type CompleteSelfServiceOrganizationSetupResponse = z.infer<
  typeof CompleteSelfServiceOrganizationSetupResponse
>;

export const SelfServiceOrganizationOnboardingStatus = z.object({
  state: z.enum(["required", "invitation_pending", "unavailable", "complete"]),
});
export type SelfServiceOrganizationOnboardingStatus = z.infer<
  typeof SelfServiceOrganizationOnboardingStatus
>;

export const AcceptOrganizationInvitationRequest = z.object({
  expectedRevision: z.number().int().positive(),
  operationId: z.string().uuid(),
});
export type AcceptOrganizationInvitationRequest = z.infer<
  typeof AcceptOrganizationInvitationRequest
>;

export const RevokeOrganizationInvitationRequest = AcceptOrganizationInvitationRequest;
export type RevokeOrganizationInvitationRequest = z.infer<
  typeof RevokeOrganizationInvitationRequest
>;

export const OrganizationMemberTransitionKind = z.enum([
  "change_role",
  "suspend",
  "reactivate",
  "offboard",
]);
export type OrganizationMemberTransitionKind = z.infer<typeof OrganizationMemberTransitionKind>;

export const UpdateOrganizationMemberRequest = z
  .object({
    kind: OrganizationMemberTransitionKind,
    role: OrganizationMembershipRole.optional(),
    expectedAuthorizationRevision: z.number().int().positive(),
    operationId: z.string().uuid(),
    reason: z.string().trim().min(1).max(512).optional(),
  })
  .superRefine((value, context) => {
    if ((value.kind === "change_role") !== (value.role !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["role"],
        message: "role is required only for change_role",
      });
    }
  });
export type UpdateOrganizationMemberRequest = z.infer<typeof UpdateOrganizationMemberRequest>;

export const UpdateOrganizationRetentionPolicyRequest = z
  .object({
    mode: z.enum(["retain", "delete_after"]),
    retentionDays: z.number().int().min(30).max(90).nullable(),
    expectedVersion: z.number().int().positive(),
    operationId: z.string().uuid(),
  })
  .superRefine((value, context) => {
    if ((value.mode === "retain") !== (value.retentionDays === null)) {
      context.addIssue({
        code: "custom",
        path: ["retentionDays"],
        message: "retain requires no duration; delete_after requires a duration",
      });
    }
  });
export type UpdateOrganizationRetentionPolicyRequest = z.infer<
  typeof UpdateOrganizationRetentionPolicyRequest
>;

export const ListOrganizationInvitationsResponse = z.object({
  invitations: z.array(OrganizationInvitation).max(101),
});
export const ListOrganizationInvitationsPageQuery = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListOrganizationInvitationsPageQuery = z.infer<
  typeof ListOrganizationInvitationsPageQuery
>;
export const ListOrganizationInvitationsPageResponse = z.object({
  invitations: z.array(OrganizationInvitation).max(100),
  nextCursor: z.string().uuid().nullable(),
});
export type ListOrganizationInvitationsPageResponse = z.infer<
  typeof ListOrganizationInvitationsPageResponse
>;
export const AcceptOrganizationInvitationResponse = z.object({
  invitation: OrganizationInvitation,
  membership: OrganizationMember,
});
export type AcceptOrganizationInvitationResponse = z.infer<
  typeof AcceptOrganizationInvitationResponse
>;
export const ListOrganizationMembersResponse = z.object({
  members: z.array(OrganizationMember),
});
export const ListOrganizationAdministrationMembersResponse = z.object({
  members: z.array(OrganizationAdministrationMember).max(1000),
});
export const ListSelfOrganizationMembershipsResponse = z.object({
  memberships: z.array(OrganizationMember),
});
