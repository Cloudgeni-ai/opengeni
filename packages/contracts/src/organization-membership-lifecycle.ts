import { z } from "zod";

export const OrganizationMembershipRole = z.enum(["owner", "admin", "member"]);
export type OrganizationMembershipRole = z.infer<typeof OrganizationMembershipRole>;

export const OrganizationInvitationStatus = z.enum(["pending", "accepted", "revoked", "expired"]);
export type OrganizationInvitationStatus = z.infer<typeof OrganizationInvitationStatus>;

export const OrganizationInvitation = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
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
});
export type OrganizationInvitation = z.infer<typeof OrganizationInvitation>;

export const OrganizationMember = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  subjectId: z.string().min(1).max(1024),
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
export type OrganizationPrivateSessionSettings = z.infer<
  typeof OrganizationPrivateSessionSettings
>;

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
  subjectId: z.string().min(1).max(1024),
  subjectLabel: z.string().min(1).max(1024).nullable(),
  principalKind: z.enum(["human", "service"]),
  role: z.string().min(1).max(64),
  permissions: z.array(z.string().min(1).max(128)),
  createdAt: z.string().datetime({ offset: true }),
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

export const OrganizationAdministrationOverview = z.object({
  organization: OrganizationSummary,
  workspaces: z.array(OrganizationWorkspaceAccess).max(500),
});
export type OrganizationAdministrationOverview = z.infer<typeof OrganizationAdministrationOverview>;

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
export const ListSelfOrganizationMembershipsResponse = z.object({
  memberships: z.array(OrganizationMember),
});
