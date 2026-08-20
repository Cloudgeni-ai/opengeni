import { z } from "zod";
import {
  ConnectionKind,
  SessionTenancyVisibility,
  UserResourceAuthorityGrant,
  UserResourceDelegation,
  UserResourceLifecycleGrantMode,
} from "./index";

/** The only generic grant action that authorizes use of a connection. */
export const ConnectionUseAction = z.literal("connection.use");
export type ConnectionUseAction = z.infer<typeof ConnectionUseAction>;

/**
 * Connection authority is either workspace-owned or user-owned. Omission is
 * intentionally compatible with the historical workspace connection path.
 */
export const ConnectionAuthorityEnvelope = z
  .object({
    scope: z.enum(["workspace", "user"]).default("workspace"),
    userDelegation: UserResourceDelegation.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.scope === "workspace" && value.userDelegation !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["userDelegation"],
        message: "workspace connections cannot carry user delegation",
      });
      return;
    }
    if (value.scope === "user" && value.userDelegation === undefined) {
      context.addIssue({
        code: "custom",
        path: ["userDelegation"],
        message: "user connections require an immutable delegation",
      });
      return;
    }
    if (value.userDelegation && value.userDelegation.action !== ConnectionUseAction.value) {
      context.addIssue({
        code: "custom",
        path: ["userDelegation", "action"],
        message: "connection delegation must use connection.use",
      });
    }
  });
export type ConnectionAuthorityEnvelope = z.infer<typeof ConnectionAuthorityEnvelope>;

export const ConnectionAuthorityGrant = UserResourceAuthorityGrant.extend({
  action: ConnectionUseAction,
}).strict();
export type ConnectionAuthorityGrant = z.infer<typeof ConnectionAuthorityGrant>;

/** Owner-only opaque projection; connection identity and owner metadata stay server-side. */
export const ConnectionAuthoritySummary = z
  .object({
    authorityId: z.string().uuid(),
    generation: z.number().int().positive(),
    status: z.enum(["active", "retained", "revoked"]),
    grants: z.array(ConnectionAuthorityGrant),
  })
  .strict();
export type ConnectionAuthoritySummary = z.infer<typeof ConnectionAuthoritySummary>;

export const ListConnectionAuthoritiesQuery = z.object({ scope: z.literal("user") }).strict();
export const ListConnectionAuthoritiesResponse = z
  .object({
    scope: z.literal("user"),
    authorities: z.array(ConnectionAuthoritySummary),
  })
  .strict();

export const IssueConnectionUseGrantRequest = z
  .object({
    scope: z.literal("user"),
    mode: UserResourceLifecycleGrantMode,
    context: SessionTenancyVisibility,
    sessionId: z.string().uuid().nullable().optional(),
    workspaceSharedAcknowledged: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.context === "workspace_shared" && !value.workspaceSharedAcknowledged) {
      context.addIssue({
        code: "custom",
        path: ["workspaceSharedAcknowledged"],
        message: "workspace_shared requires durable shared-output acknowledgement",
      });
    }
    if (value.mode === "always" && value.sessionId) {
      context.addIssue({ code: "custom", path: ["sessionId"], message: "always is unbound" });
    }
    if (value.mode !== "always" && !value.sessionId) {
      context.addIssue({
        code: "custom",
        path: ["sessionId"],
        message: "once/session require a target session",
      });
    }
  });
export type IssueConnectionUseGrantRequest = z.infer<typeof IssueConnectionUseGrantRequest>;

export const RevokeConnectionUseGrantQuery = z.object({ scope: z.literal("user") }).strict();

export const ConnectionUseGrantMutationResponse = z
  .object({
    scope: z.literal("user"),
    grant: ConnectionAuthorityGrant,
  })
  .strict();
export type ConnectionUseGrantMutationResponse = z.infer<typeof ConnectionUseGrantMutationResponse>;

export const ConnectionUseGrantRevocationResponse = z
  .object({
    scope: z.literal("user"),
    grant: z
      .object({
        grantId: z.string().uuid(),
        generation: z.number().int().positive(),
        status: z.literal("revoked"),
        revokedAt: z.string().datetime(),
      })
      .strict(),
  })
  .strict();
export type ConnectionUseGrantRevocationResponse = z.infer<
  typeof ConnectionUseGrantRevocationResponse
>;

export const ConnectionAuthoritySelectionSource = z.enum([
  "explicit_workspace",
  "legacy_workspace_omission",
  "legacy_user_compatibility",
  "user_delegation",
]);
export type ConnectionAuthoritySelectionSource = z.infer<typeof ConnectionAuthoritySelectionSource>;

export const ConnectionUseSelectionSource = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9](?:[a-z0-9._:-]*[a-z0-9])?$/u);
export type ConnectionUseSelectionSource = z.infer<typeof ConnectionUseSelectionSource>;

const AcceptedConnectionWork = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("turn"),
      turnId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("scheduled_task"),
      taskId: z.string().uuid(),
      taskAuthorityRevision: z.number().int().positive(),
      runId: z.string().uuid(),
    })
    .strict(),
]);

/**
 * Internal, credential-free authority frozen when work is accepted. Personal
 * owner identity is retained only for live authorization and usage/audit
 * attribution; it is never part of the public delegation envelope.
 */
export const ConnectionUseAuthoritySnapshot = z
  .object({
    organizationId: z.string().uuid(),
    originWorkspaceId: z.string().uuid(),
    targetWorkspaceId: z.string().uuid(),
    targetSessionId: z.string().uuid(),
    targetSessionVisibility: SessionTenancyVisibility,
    targetSessionAuthorityEpoch: z.number().int().positive(),
    acceptedWork: AcceptedConnectionWork,
    connectionId: z.string().uuid(),
    connectionGeneration: z.number().int().positive(),
    connectionStatus: z.literal("active"),
    providerDomain: z.string().min(1).max(2048),
    connectionKind: ConnectionKind,
    scope: z.enum(["workspace", "user", "legacy_user"]),
    ownerSubjectId: z.string().min(1).max(512).nullable(),
    ownerOrganizationMembershipId: z.string().uuid().nullable(),
    ownerMembershipAuthorizationRevision: z.number().int().positive().nullable().default(null),
    authoritySource: ConnectionAuthoritySelectionSource,
    selectionSources: z.array(ConnectionUseSelectionSource).min(1).max(128),
    userDelegation: UserResourceDelegation.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const ownedBySubject = value.scope !== "workspace";
    const delegated = value.scope === "user";
    if (ownedBySubject !== (value.ownerSubjectId !== null)) {
      context.addIssue({
        code: "custom",
        path: ["ownerSubjectId"],
        message: "personal connections retain an owner subject",
      });
    }
    if (delegated !== (value.ownerOrganizationMembershipId !== null)) {
      context.addIssue({
        code: "custom",
        path: ["ownerOrganizationMembershipId"],
        message: "only user connections retain an owner membership",
      });
    }
    if (delegated !== (value.ownerMembershipAuthorizationRevision !== null)) {
      context.addIssue({
        code: "custom",
        path: ["ownerMembershipAuthorizationRevision"],
        message: "only user connections retain an owner membership revision",
      });
    }
    if (delegated !== (value.userDelegation !== null)) {
      context.addIssue({
        code: "custom",
        path: ["userDelegation"],
        message: "only user connections retain a delegation",
      });
    }
    if (delegated && value.authoritySource !== "user_delegation") {
      context.addIssue({
        code: "custom",
        path: ["authoritySource"],
        message: "user connections require user_delegation provenance",
      });
    }
    if (!delegated && value.authoritySource === "user_delegation") {
      context.addIssue({
        code: "custom",
        path: ["authoritySource"],
        message: "non-delegated connections cannot claim user delegation provenance",
      });
    }
    if (value.scope === "legacy_user" && value.authoritySource !== "legacy_user_compatibility") {
      context.addIssue({
        code: "custom",
        path: ["authoritySource"],
        message: "legacy user connections require explicit compatibility provenance",
      });
    }
    if (value.scope === "workspace" && value.authoritySource === "legacy_user_compatibility") {
      context.addIssue({
        code: "custom",
        path: ["authoritySource"],
        message: "workspace connections cannot claim legacy user provenance",
      });
    }
    if (!delegated && value.originWorkspaceId !== value.targetWorkspaceId) {
      context.addIssue({
        code: "custom",
        path: ["originWorkspaceId"],
        message: "workspace connections must be owned by the target workspace",
      });
    }
    const delegation = value.userDelegation;
    if (!delegation) return;
    const exactFacts: Array<[boolean, (string | number)[], string]> = [
      [
        delegation.organizationId === value.organizationId,
        ["userDelegation", "organizationId"],
        "delegation organization mismatch",
      ],
      [
        delegation.workspaceId === value.targetWorkspaceId,
        ["userDelegation", "workspaceId"],
        "delegation target workspace mismatch",
      ],
      [
        delegation.action === ConnectionUseAction.value,
        ["userDelegation", "action"],
        "delegation action mismatch",
      ],
      [
        delegation.context === value.targetSessionVisibility,
        ["userDelegation", "context"],
        "delegation visibility mismatch",
      ],
    ];
    for (const [matches, path, message] of exactFacts) {
      if (!matches) context.addIssue({ code: "custom", path, message });
    }
    if (delegation.sessionId !== null && delegation.sessionId !== value.targetSessionId) {
      context.addIssue({
        code: "custom",
        path: ["userDelegation", "sessionId"],
        message: "delegation session mismatch",
      });
    }
    if (
      delegation.authorityEpoch !== null &&
      delegation.authorityEpoch !== value.targetSessionAuthorityEpoch
    ) {
      context.addIssue({
        code: "custom",
        path: ["userDelegation", "authorityEpoch"],
        message: "delegation authority epoch mismatch",
      });
    }
  });
export type ConnectionUseAuthoritySnapshot = z.infer<typeof ConnectionUseAuthoritySnapshot>;

export const ConnectionUseDenialReason = z.enum([
  "tenant_mismatch",
  "workspace_access_inactive",
  "session_inactive",
  "session_identity_changed",
  "session_visibility_changed",
  "session_authority_epoch_changed",
  "accepted_attempt_authority_required",
  "accepted_snapshot_digest_changed",
  "connection_missing",
  "connection_identity_changed",
  "connection_generation_changed",
  "connection_status_inactive",
  "connection_owner_changed",
  "owner_membership_inactive",
  "authority_missing",
  "authority_identity_changed",
  "authority_generation_changed",
  "authority_status_inactive",
  "grant_missing",
  "grant_identity_changed",
  "grant_generation_changed",
  "grant_status_inactive",
  "grant_expired",
  "grant_already_consumed",
]);
export type ConnectionUseDenialReason = z.infer<typeof ConnectionUseDenialReason>;

const ConnectionUseAttributionFields = z
  .object({
    organizationId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    sessionId: z.string().uuid(),
    connectionId: z.string().uuid(),
    connectionGeneration: z.number().int().positive(),
    scope: z.enum(["workspace", "user", "legacy_user"]),
    ownerSubjectId: z.string().min(1).max(512).nullable(),
    authorityId: z.string().uuid().nullable(),
    grantId: z.string().uuid().nullable(),
  })
  .strict();

function refineConnectionUseAttribution(
  value: z.infer<typeof ConnectionUseAttributionFields>,
  context: z.RefinementCtx,
): void {
  const personal = value.scope !== "workspace";
  for (const field of ["ownerSubjectId"] as const) {
    if (personal !== (value[field] !== null)) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: personal
          ? `personal attribution requires ${field}`
          : `workspace attribution cannot carry ${field}`,
      });
    }
  }
  const delegated = value.scope === "user";
  for (const field of ["authorityId", "grantId"] as const) {
    if (delegated !== (value[field] !== null)) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: delegated
          ? `delegated personal attribution requires ${field}`
          : `non-delegated attribution cannot carry ${field}`,
      });
    }
  }
}

/** Metadata-only attribution emitted after pre-use authorization. */
export const ConnectionUseAttribution = ConnectionUseAttributionFields.superRefine(
  refineConnectionUseAttribution,
);
export type ConnectionUseAttribution = z.infer<typeof ConnectionUseAttribution>;

export const ConnectionUseAuditFact = ConnectionUseAttributionFields.extend({
  outcome: z.enum(["authorized", "denied"]),
  denialReason: ConnectionUseDenialReason.nullable(),
  occurredAt: z.string().datetime({ offset: true }),
}).superRefine((value, context) => {
  refineConnectionUseAttribution(value, context);
  if ((value.outcome === "denied") !== (value.denialReason !== null)) {
    context.addIssue({
      code: "custom",
      path: ["denialReason"],
      message: "only denied connection use carries a denial reason",
    });
  }
});
export type ConnectionUseAuditFact = z.infer<typeof ConnectionUseAuditFact>;

export const ConnectionUseAuthorizationResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("authorized"), attribution: ConnectionUseAttribution }).strict(),
  z.object({ status: z.literal("denied"), reason: ConnectionUseDenialReason }).strict(),
]);
export type ConnectionUseAuthorizationResult = z.infer<typeof ConnectionUseAuthorizationResult>;
