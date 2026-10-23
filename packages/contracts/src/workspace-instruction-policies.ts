import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";

export const WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS = 262_144;
export const WORKSPACE_INSTRUCTION_POLICY_PROMPT_MAX_UTF8_BYTES = 131_072;
export const WORKSPACE_INSTRUCTION_POLICY_REASON_MAX_CHARS = 4_096;
export const WORKSPACE_INSTRUCTION_POLICY_ROLE_KEY_MAX_CHARS = 64;
export const WORKSPACE_INSTRUCTION_POLICY_SOURCE_ID_MAX_CHARS = 512;
export const WORKSPACE_INSTRUCTION_POLICY_ONBOARDING_SOURCE_VERSION_MAX_CHARS = 256;

export const WorkspaceInstructionPolicyKind = /* @__PURE__ */ defineSchema(() =>
  z.enum(["charter", "policy"]),
);
export type WorkspaceInstructionPolicyKind = z.infer<typeof WorkspaceInstructionPolicyKind>;

export const WorkspaceInstructionPolicyScope = /* @__PURE__ */ defineSchema(() =>
  z.enum(["global", "role"]),
);
export type WorkspaceInstructionPolicyScope = z.infer<typeof WorkspaceInstructionPolicyScope>;

export const WorkspaceInstructionPolicyProvenanceSource = /* @__PURE__ */ defineSchema(() =>
  z.enum(["human", "agent_learning", "onboarding", "knowledge_proposal", "legacy_import"]),
);
export type WorkspaceInstructionPolicyProvenanceSource = z.infer<
  typeof WorkspaceInstructionPolicyProvenanceSource
>;

export const WorkspaceInstructionPolicyDraftProvenanceSource = /* @__PURE__ */ defineSchema(() =>
  z.enum(["human", "onboarding", "knowledge_proposal"]),
);
export type WorkspaceInstructionPolicyDraftProvenanceSource = z.infer<
  typeof WorkspaceInstructionPolicyDraftProvenanceSource
>;

export const WorkspaceInstructionPolicyActivationType = /* @__PURE__ */ defineSchema(() =>
  z.enum(["activate", "rollback"]),
);
export type WorkspaceInstructionPolicyActivationType = z.infer<
  typeof WorkspaceInstructionPolicyActivationType
>;

export const WorkspaceInstructionPolicyRoleKey = /* @__PURE__ */ defineSchema(() =>
  primitives.nonEmptyString
    .max(WORKSPACE_INSTRUCTION_POLICY_ROLE_KEY_MAX_CHARS)
    .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/),
);
export type WorkspaceInstructionPolicyRoleKey = z.infer<typeof WorkspaceInstructionPolicyRoleKey>;

/**
 * Role-policy keys are identifiers rather than display names. Normalize once
 * at ingress so activation uniqueness and every client use the same key.
 */
export function normalizeWorkspaceInstructionPolicyRoleKey(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, "-").replace(/-+/g, "-");
}

export const WorkspaceInstructionPolicyRoleKeyInput = /* @__PURE__ */ defineSchema(() =>
  primitives.string
    .transform(normalizeWorkspaceInstructionPolicyRoleKey)
    .pipe(WorkspaceInstructionPolicyRoleKey),
);
export type WorkspaceInstructionPolicyRoleKeyInput = z.infer<
  typeof WorkspaceInstructionPolicyRoleKeyInput
>;

export const WorkspaceInstructionPolicyRoleSource = /* @__PURE__ */ defineSchema(() =>
  z.enum(["session_binding", "metadata_fallback", "none", "invalid_metadata_fallback"]),
);
export type WorkspaceInstructionPolicyRoleSource = z.infer<
  typeof WorkspaceInstructionPolicyRoleSource
>;

const targetShape = {
  kind: WorkspaceInstructionPolicyKind,
  scope: WorkspaceInstructionPolicyScope,
  roleKey: WorkspaceInstructionPolicyRoleKey.nullable(),
};

function validateTarget(
  value: {
    kind: WorkspaceInstructionPolicyKind;
    scope: WorkspaceInstructionPolicyScope;
    roleKey: string | null;
  },
  context: z.RefinementCtx,
): void {
  if (value.kind === "charter" && (value.scope !== "global" || value.roleKey !== null)) {
    context.addIssue({
      code: "custom",
      path: ["scope"],
      message: "a charter must use global scope with no role key",
    });
  }
  if (value.scope === "global" && value.roleKey !== null) {
    context.addIssue({
      code: "custom",
      path: ["roleKey"],
      message: "a global instruction policy must not have a role key",
    });
  }
  if (value.scope === "role" && (value.kind !== "policy" || value.roleKey === null)) {
    context.addIssue({
      code: "custom",
      path: ["roleKey"],
      message: "role scope requires a policy and a normalized role key",
    });
  }
}

export const WorkspaceInstructionPolicyTarget = /* @__PURE__ */ defineSchema(() =>
  z.object(targetShape).superRefine(validateTarget),
);
export type WorkspaceInstructionPolicyTarget = z.infer<typeof WorkspaceInstructionPolicyTarget>;

export const WorkspaceInstructionPolicyProvenance = /* @__PURE__ */ defineSchema(() =>
  z.object({
    source: WorkspaceInstructionPolicyProvenanceSource,
    sourceId: primitives.nonEmptyString
      .max(WORKSPACE_INSTRUCTION_POLICY_SOURCE_ID_MAX_CHARS)
      .nullable(),
  }),
);
export type WorkspaceInstructionPolicyProvenance = z.infer<
  typeof WorkspaceInstructionPolicyProvenance
>;

const revisionIdentityShape = {
  id: primitives.uuid,
  revision: primitives.positiveInteger,
  contentHash: primitives.string.regex(/^[0-9a-f]{64}$/),
};

export const WorkspaceInstructionPolicyRevisionIdentity = /* @__PURE__ */ defineSchema(() =>
  z.object(revisionIdentityShape),
);
export type WorkspaceInstructionPolicyRevisionIdentity = z.infer<
  typeof WorkspaceInstructionPolicyRevisionIdentity
>;

export const WorkspaceInstructionPolicyRevision = /* @__PURE__ */ defineSchema(() =>
  z.object({
    ...revisionIdentityShape,
    operationId: primitives.uuid,
    accountId: primitives.uuid,
    workspaceId: primitives.uuid,
    ...targetShape,
    content: primitives.nonEmptyString.max(WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS),
    provenance: WorkspaceInstructionPolicyProvenance,
    supersedesRevisionId: primitives.nullableUuid,
    createdBySubjectId: primitives.nonEmptyString,
    createdAt: primitives.dateTime,
  }),
);
export type WorkspaceInstructionPolicyRevision = z.infer<typeof WorkspaceInstructionPolicyRevision>;

export const WorkspaceInstructionPolicyHead = /* @__PURE__ */ defineSchema(() =>
  z.object({
    workspaceId: primitives.uuid,
    ...targetShape,
    revisionId: primitives.uuid,
    revision: primitives.positiveInteger,
    contentHash: primitives.string.regex(/^[0-9a-f]{64}$/),
    activationVersion: primitives.positiveInteger,
    activatedAt: primitives.dateTime,
  }),
);
export type WorkspaceInstructionPolicyHead = z.infer<typeof WorkspaceInstructionPolicyHead>;

export const WorkspaceInstructionPolicyInactiveHead = /* @__PURE__ */ defineSchema(() =>
  z.object({
    workspaceId: primitives.uuid,
    ...targetShape,
    activationVersion: primitives.positiveInteger,
    deactivatedAt: primitives.dateTime,
  }),
);
export type WorkspaceInstructionPolicyInactiveHead = z.infer<
  typeof WorkspaceInstructionPolicyInactiveHead
>;

export const WorkspaceInstructionPolicySnapshotProvenance = /* @__PURE__ */ defineSchema(() =>
  z.object({
    source: WorkspaceInstructionPolicyProvenanceSource,
    sourceIdHash: primitives.string.regex(/^[0-9a-f]{64}$/).nullable(),
  }),
);
export type WorkspaceInstructionPolicySnapshotProvenance = z.infer<
  typeof WorkspaceInstructionPolicySnapshotProvenance
>;

export const WorkspaceInstructionPolicySnapshotEntry = /* @__PURE__ */ defineSchema(() =>
  z.object({
    kind: WorkspaceInstructionPolicyKind,
    scope: WorkspaceInstructionPolicyScope,
    roleKey: WorkspaceInstructionPolicyRoleKey.nullable(),
    revisionId: primitives.uuid,
    revision: primitives.positiveInteger,
    contentHash: primitives.string.regex(/^[0-9a-f]{64}$/),
    activationVersion: primitives.positiveInteger,
    activatedAt: primitives.dateTime,
    provenance: WorkspaceInstructionPolicySnapshotProvenance,
  }),
);
export type WorkspaceInstructionPolicySnapshotEntry = z.infer<
  typeof WorkspaceInstructionPolicySnapshotEntry
>;

export const WorkspaceInstructionPolicySnapshot = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid,
    workspaceId: primitives.uuid,
    sessionId: primitives.uuid,
    turnId: primitives.uuid,
    attemptId: primitives.uuid,
    executionGeneration: primitives.positiveInteger,
    policyRole: WorkspaceInstructionPolicyRoleKey.nullable(),
    roleSource: WorkspaceInstructionPolicyRoleSource,
    entryHash: primitives.string.regex(/^[0-9a-f]{64}$/),
    entries: z.array(WorkspaceInstructionPolicySnapshotEntry).max(3),
    createdAt: primitives.dateTime,
  }),
);
export type WorkspaceInstructionPolicySnapshot = z.infer<typeof WorkspaceInstructionPolicySnapshot>;

export const ResolvedWorkspaceInstructionPolicySnapshotEntry =
  /* @__PURE__ */ defineSchema(() =>
    WorkspaceInstructionPolicySnapshotEntry.extend({
      content: primitives.nonEmptyString.max(WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS),
    }),
  );
export type ResolvedWorkspaceInstructionPolicySnapshotEntry = z.infer<
  typeof ResolvedWorkspaceInstructionPolicySnapshotEntry
>;

export const ResolvedWorkspaceInstructionPolicySnapshot = /* @__PURE__ */ defineSchema(() =>
  WorkspaceInstructionPolicySnapshot.extend({
    entries: z.array(ResolvedWorkspaceInstructionPolicySnapshotEntry).max(3),
  }),
);
export type ResolvedWorkspaceInstructionPolicySnapshot = z.infer<
  typeof ResolvedWorkspaceInstructionPolicySnapshot
>;

export const WorkspaceInstructionPolicyActivationEvent = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid,
    operationId: primitives.uuid,
    accountId: primitives.uuid,
    workspaceId: primitives.uuid,
    ...targetShape,
    type: WorkspaceInstructionPolicyActivationType,
    activationVersion: primitives.positiveInteger,
    oldRevision: WorkspaceInstructionPolicyRevisionIdentity.nullable(),
    newRevision: WorkspaceInstructionPolicyRevisionIdentity,
    actorSubjectId: primitives.nonEmptyString,
    reason: primitives.nonEmptyString.max(WORKSPACE_INSTRUCTION_POLICY_REASON_MAX_CHARS),
    createdAt: primitives.dateTime,
  }),
);
export type WorkspaceInstructionPolicyActivationEvent = z.infer<
  typeof WorkspaceInstructionPolicyActivationEvent
>;

export const WorkspaceInstructionPolicyDeactivationEvent = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid,
    operationId: primitives.uuid,
    accountId: primitives.uuid,
    workspaceId: primitives.uuid,
    ...targetShape,
    type: z.literal("automatic_deactivate"),
    activationVersion: primitives.positiveInteger,
    oldRevision: WorkspaceInstructionPolicyRevisionIdentity,
    actorSubjectId: primitives.nonEmptyString,
    reason: primitives.nonEmptyString.max(WORKSPACE_INSTRUCTION_POLICY_REASON_MAX_CHARS),
    createdAt: primitives.dateTime,
  }),
);
export type WorkspaceInstructionPolicyDeactivationEvent = z.infer<
  typeof WorkspaceInstructionPolicyDeactivationEvent
>;

export const CreateWorkspaceInstructionPolicyDraftRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      operationId: primitives.optionalUuid,
      kind: WorkspaceInstructionPolicyKind,
      scope: WorkspaceInstructionPolicyScope,
      roleKey: WorkspaceInstructionPolicyRoleKeyInput.nullable().default(null),
      content: primitives.nonEmptyString
        .max(WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS)
        .refine((value) => value.trim().length > 0, "instruction policy content must not be blank"),
      provenanceSource: WorkspaceInstructionPolicyDraftProvenanceSource.default("human"),
      provenanceSourceId: primitives.nonEmptyString
        .max(WORKSPACE_INSTRUCTION_POLICY_SOURCE_ID_MAX_CHARS)
        .nullable()
        .default(null),
      supersedesRevisionId: primitives.nullableUuid.default(null),
    })
    .superRefine(validateTarget),
);
export type CreateWorkspaceInstructionPolicyDraftRequest = z.infer<
  typeof CreateWorkspaceInstructionPolicyDraftRequest
>;

export const ImportLegacyWorkspaceInstructionPolicyDraftRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      operationId: primitives.optionalUuid,
      supersedesRevisionId: primitives.nullableUuid.default(null),
    })
    .strict(),
);
export type ImportLegacyWorkspaceInstructionPolicyDraftRequest = z.infer<
  typeof ImportLegacyWorkspaceInstructionPolicyDraftRequest
>;

export const WorkspaceInstructionPolicyListQuery = /* @__PURE__ */ defineSchema(() =>
  z.object({
    kind: WorkspaceInstructionPolicyKind.optional(),
    scope: WorkspaceInstructionPolicyScope.optional(),
    roleKey: WorkspaceInstructionPolicyRoleKeyInput.nullable().optional(),
    afterRevision: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
);
export type WorkspaceInstructionPolicyListQuery = z.infer<
  typeof WorkspaceInstructionPolicyListQuery
>;

export const WorkspaceInstructionPolicyListResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    revisions: z.array(WorkspaceInstructionPolicyRevision),
    activeHeads: z.array(WorkspaceInstructionPolicyHead),
    inactiveHeads: z.array(WorkspaceInstructionPolicyInactiveHead).default([]),
    inactiveHeadsTruncated: primitives.boolean.default(false),
    activationEvents: z.array(WorkspaceInstructionPolicyActivationEvent),
    deactivationEvents: z.array(WorkspaceInstructionPolicyDeactivationEvent).default([]),
    nextAfterRevision: z.number().int().positive().nullable(),
  }),
);
export type WorkspaceInstructionPolicyListResponse = z.infer<
  typeof WorkspaceInstructionPolicyListResponse
>;

export const WorkspaceInstructionPolicyDiffRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      fromRevisionId: primitives.uuid,
      toRevisionId: primitives.uuid,
    })
    .refine((value) => value.fromRevisionId !== value.toRevisionId, {
      message: "diff revisions must be different",
      path: ["toRevisionId"],
    }),
);
export type WorkspaceInstructionPolicyDiffRequest = z.infer<
  typeof WorkspaceInstructionPolicyDiffRequest
>;

export const WorkspaceInstructionPolicyDiffResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    from: WorkspaceInstructionPolicyRevision,
    to: WorkspaceInstructionPolicyRevision,
    format: z.literal("unified"),
    diff: primitives.string,
  }),
);
export type WorkspaceInstructionPolicyDiffResponse = z.infer<
  typeof WorkspaceInstructionPolicyDiffResponse
>;

export const ActivateWorkspaceInstructionPolicyRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    operationId: primitives.optionalUuid,
    expectedCurrentRevisionId: primitives.nullableUuid,
    expectedActivationVersion: z.number().int().nonnegative().optional(),
    reason: primitives.string.trim().min(1).max(WORKSPACE_INSTRUCTION_POLICY_REASON_MAX_CHARS),
  }),
);
export type ActivateWorkspaceInstructionPolicyRequest = z.infer<
  typeof ActivateWorkspaceInstructionPolicyRequest
>;

export const RollbackWorkspaceInstructionPolicyRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    operationId: primitives.optionalUuid,
    targetRevisionId: primitives.uuid,
    expectedCurrentRevisionId: primitives.uuid,
    expectedActivationVersion: z.number().int().positive().optional(),
    reason: primitives.string.trim().min(1).max(WORKSPACE_INSTRUCTION_POLICY_REASON_MAX_CHARS),
  }),
);
export type RollbackWorkspaceInstructionPolicyRequest = z.infer<
  typeof RollbackWorkspaceInstructionPolicyRequest
>;

export const WorkspaceInstructionPolicyActivationResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    head: WorkspaceInstructionPolicyHead,
    event: WorkspaceInstructionPolicyActivationEvent,
  }),
);
export type WorkspaceInstructionPolicyActivationResponse = z.infer<
  typeof WorkspaceInstructionPolicyActivationResponse
>;

export const WorkspaceInstructionPolicyConflictResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    code: z.literal("WORKSPACE_INSTRUCTION_POLICY_CONFLICT"),
    message: primitives.string,
    currentHead: WorkspaceInstructionPolicyHead.nullable(),
  }),
);
export type WorkspaceInstructionPolicyConflictResponse = z.infer<
  typeof WorkspaceInstructionPolicyConflictResponse
>;

export const WorkspaceInstructionPolicyOperationReuseResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    code: z.literal("WORKSPACE_INSTRUCTION_POLICY_OPERATION_REUSED"),
    message: primitives.string,
  }),
);
export type WorkspaceInstructionPolicyOperationReuseResponse = z.infer<
  typeof WorkspaceInstructionPolicyOperationReuseResponse
>;

export const WorkspaceInstructionPolicyOnboardingProposalSource = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.nonEmptyString.max(WORKSPACE_INSTRUCTION_POLICY_SOURCE_ID_MAX_CHARS),
    version: primitives.nonEmptyString.max(
      WORKSPACE_INSTRUCTION_POLICY_ONBOARDING_SOURCE_VERSION_MAX_CHARS,
    ),
    confidenceBps: z.number().int().min(0).max(10_000),
  }),
);
export type WorkspaceInstructionPolicyOnboardingProposalSource = z.infer<
  typeof WorkspaceInstructionPolicyOnboardingProposalSource
>;

export const CreateWorkspaceInstructionPolicyOnboardingProposalRequest =
  /* @__PURE__ */ defineSchema(() =>
    z
      .object({
        operationId: primitives.optionalUuid,
        kind: WorkspaceInstructionPolicyKind,
        scope: WorkspaceInstructionPolicyScope,
        roleKey: WorkspaceInstructionPolicyRoleKeyInput.nullable().default(null),
        // Content bounds are enforced by the domain layer so empty and oversized
        // proposals retain their typed API outcomes instead of collapsing into a
        // generic request-shape error.
        content: primitives.string,
        sourceId: primitives.string
          .trim()
          .min(1)
          .max(WORKSPACE_INSTRUCTION_POLICY_SOURCE_ID_MAX_CHARS),
        sourceVersion: primitives.string
          .trim()
          .min(1)
          .max(WORKSPACE_INSTRUCTION_POLICY_ONBOARDING_SOURCE_VERSION_MAX_CHARS),
        confidenceBps: z.number().int().min(0).max(10_000),
        expectedCurrentRevisionId: primitives.nullableUuid,
        expectedActivationVersion: primitives.nonnegativeInteger,
      })
      .superRefine(validateTarget),
  );
export type CreateWorkspaceInstructionPolicyOnboardingProposalRequest = z.infer<
  typeof CreateWorkspaceInstructionPolicyOnboardingProposalRequest
>;

export const WorkspaceInstructionPolicyOnboardingProposal = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid,
    operationId: primitives.uuid,
    accountId: primitives.uuid,
    workspaceId: primitives.uuid,
    ...targetShape,
    source: WorkspaceInstructionPolicyOnboardingProposalSource,
    baseline: WorkspaceInstructionPolicyHead.nullable(),
    draft: WorkspaceInstructionPolicyRevision,
    status: z.literal("proposed"),
    createdBySubjectId: primitives.nonEmptyString,
    createdAt: primitives.dateTime,
  }),
);
export type WorkspaceInstructionPolicyOnboardingProposal = z.infer<
  typeof WorkspaceInstructionPolicyOnboardingProposal
>;

export const WorkspaceInstructionPolicyOnboardingProposalListQuery = /* @__PURE__ */ defineSchema(
  () =>
    z.object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
);
export type WorkspaceInstructionPolicyOnboardingProposalListQuery = z.infer<
  typeof WorkspaceInstructionPolicyOnboardingProposalListQuery
>;

export const WorkspaceInstructionPolicyOnboardingProposalListResponse =
  /* @__PURE__ */ defineSchema(() =>
    z.object({
      proposals: z.array(WorkspaceInstructionPolicyOnboardingProposal),
      truncated: primitives.boolean,
    }),
  );
export type WorkspaceInstructionPolicyOnboardingProposalListResponse = z.infer<
  typeof WorkspaceInstructionPolicyOnboardingProposalListResponse
>;

export const WorkspaceInstructionPolicyOnboardingProposalContentErrorResponse =
  /* @__PURE__ */ defineSchema(() =>
    z.object({
      code: z.enum([
        "WORKSPACE_INSTRUCTION_POLICY_ONBOARDING_PROPOSAL_EMPTY",
        "WORKSPACE_INSTRUCTION_POLICY_ONBOARDING_PROPOSAL_OVERSIZED",
      ]),
      message: primitives.string,
      maxChars: primitives.positiveInteger,
    }),
  );
export type WorkspaceInstructionPolicyOnboardingProposalContentErrorResponse = z.infer<
  typeof WorkspaceInstructionPolicyOnboardingProposalContentErrorResponse
>;

export const WorkspaceInstructionPolicyOnboardingProposalStaleResponse =
  /* @__PURE__ */ defineSchema(() =>
    z.object({
      code: z.literal("WORKSPACE_INSTRUCTION_POLICY_ONBOARDING_PROPOSAL_STALE"),
      message: primitives.string,
      currentHead: WorkspaceInstructionPolicyHead.nullable(),
    }),
  );
export type WorkspaceInstructionPolicyOnboardingProposalStaleResponse = z.infer<
  typeof WorkspaceInstructionPolicyOnboardingProposalStaleResponse
>;

export const WorkspaceInstructionPolicyOnboardingProposalConflictResponse =
  /* @__PURE__ */ defineSchema(() =>
    z.object({
      code: z.literal("WORKSPACE_INSTRUCTION_POLICY_ONBOARDING_PROPOSAL_CONFLICT"),
      message: primitives.string,
      existingProposalId: primitives.uuid,
      existingDraftRevisionId: primitives.uuid,
    }),
  );
export type WorkspaceInstructionPolicyOnboardingProposalConflictResponse = z.infer<
  typeof WorkspaceInstructionPolicyOnboardingProposalConflictResponse
>;
