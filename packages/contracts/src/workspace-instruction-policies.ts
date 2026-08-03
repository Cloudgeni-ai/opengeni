import { z } from "zod";

export const WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS = 262_144;
export const WORKSPACE_INSTRUCTION_POLICY_PROMPT_MAX_UTF8_BYTES = 131_072;
export const WORKSPACE_INSTRUCTION_POLICY_REASON_MAX_CHARS = 4_096;
export const WORKSPACE_INSTRUCTION_POLICY_ROLE_KEY_MAX_CHARS = 64;
export const WORKSPACE_INSTRUCTION_POLICY_SOURCE_ID_MAX_CHARS = 512;
export const WORKSPACE_INSTRUCTION_POLICY_ONBOARDING_SOURCE_VERSION_MAX_CHARS = 256;

export const WorkspaceInstructionPolicyKind = z.enum(["charter", "policy"]);
export type WorkspaceInstructionPolicyKind = z.infer<typeof WorkspaceInstructionPolicyKind>;

export const WorkspaceInstructionPolicyScope = z.enum(["global", "role"]);
export type WorkspaceInstructionPolicyScope = z.infer<typeof WorkspaceInstructionPolicyScope>;

export const WorkspaceInstructionPolicyProvenanceSource = z.enum([
  "human",
  "onboarding",
  "knowledge_proposal",
  "legacy_import",
]);
export type WorkspaceInstructionPolicyProvenanceSource = z.infer<
  typeof WorkspaceInstructionPolicyProvenanceSource
>;

export const WorkspaceInstructionPolicyDraftProvenanceSource = z.enum([
  "human",
  "onboarding",
  "knowledge_proposal",
]);
export type WorkspaceInstructionPolicyDraftProvenanceSource = z.infer<
  typeof WorkspaceInstructionPolicyDraftProvenanceSource
>;

export const WorkspaceInstructionPolicyActivationType = z.enum(["activate", "rollback"]);
export type WorkspaceInstructionPolicyActivationType = z.infer<
  typeof WorkspaceInstructionPolicyActivationType
>;

export const WorkspaceInstructionPolicyRoleKey = z
  .string()
  .min(1)
  .max(WORKSPACE_INSTRUCTION_POLICY_ROLE_KEY_MAX_CHARS)
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/);
export type WorkspaceInstructionPolicyRoleKey = z.infer<typeof WorkspaceInstructionPolicyRoleKey>;

/**
 * Role-policy keys are identifiers rather than display names. Normalize once
 * at ingress so activation uniqueness and every client use the same key.
 */
export function normalizeWorkspaceInstructionPolicyRoleKey(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, "-").replace(/-+/g, "-");
}

export const WorkspaceInstructionPolicyRoleKeyInput = z
  .string()
  .transform(normalizeWorkspaceInstructionPolicyRoleKey)
  .pipe(WorkspaceInstructionPolicyRoleKey);
export type WorkspaceInstructionPolicyRoleKeyInput = z.infer<
  typeof WorkspaceInstructionPolicyRoleKeyInput
>;

export const WorkspaceInstructionPolicyRoleSource = z.enum([
  "session_binding",
  "metadata_fallback",
  "none",
  "invalid_metadata_fallback",
]);
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

export const WorkspaceInstructionPolicyTarget = z.object(targetShape).superRefine(validateTarget);
export type WorkspaceInstructionPolicyTarget = z.infer<typeof WorkspaceInstructionPolicyTarget>;

export const WorkspaceInstructionPolicyProvenance = z.object({
  source: WorkspaceInstructionPolicyProvenanceSource,
  sourceId: z.string().min(1).max(WORKSPACE_INSTRUCTION_POLICY_SOURCE_ID_MAX_CHARS).nullable(),
});
export type WorkspaceInstructionPolicyProvenance = z.infer<
  typeof WorkspaceInstructionPolicyProvenance
>;

const revisionIdentityShape = {
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
};

export const WorkspaceInstructionPolicyRevisionIdentity = z.object(revisionIdentityShape);
export type WorkspaceInstructionPolicyRevisionIdentity = z.infer<
  typeof WorkspaceInstructionPolicyRevisionIdentity
>;

export const WorkspaceInstructionPolicyRevision = z.object({
  ...revisionIdentityShape,
  operationId: z.string().uuid(),
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  ...targetShape,
  content: z.string().min(1).max(WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS),
  provenance: WorkspaceInstructionPolicyProvenance,
  supersedesRevisionId: z.string().uuid().nullable(),
  createdBySubjectId: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type WorkspaceInstructionPolicyRevision = z.infer<typeof WorkspaceInstructionPolicyRevision>;

export const WorkspaceInstructionPolicyHead = z.object({
  workspaceId: z.string().uuid(),
  ...targetShape,
  revisionId: z.string().uuid(),
  revision: z.number().int().positive(),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  activationVersion: z.number().int().positive(),
  activatedAt: z.string().datetime(),
});
export type WorkspaceInstructionPolicyHead = z.infer<typeof WorkspaceInstructionPolicyHead>;

export const WorkspaceInstructionPolicySnapshotProvenance = z.object({
  source: WorkspaceInstructionPolicyProvenanceSource,
  sourceIdHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
});
export type WorkspaceInstructionPolicySnapshotProvenance = z.infer<
  typeof WorkspaceInstructionPolicySnapshotProvenance
>;

export const WorkspaceInstructionPolicySnapshotEntry = z.object({
  kind: WorkspaceInstructionPolicyKind,
  scope: WorkspaceInstructionPolicyScope,
  roleKey: WorkspaceInstructionPolicyRoleKey.nullable(),
  revisionId: z.string().uuid(),
  revision: z.number().int().positive(),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  activationVersion: z.number().int().positive(),
  activatedAt: z.string().datetime(),
  provenance: WorkspaceInstructionPolicySnapshotProvenance,
});
export type WorkspaceInstructionPolicySnapshotEntry = z.infer<
  typeof WorkspaceInstructionPolicySnapshotEntry
>;

export const WorkspaceInstructionPolicySnapshot = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  sessionId: z.string().uuid(),
  turnId: z.string().uuid(),
  attemptId: z.string().uuid(),
  executionGeneration: z.number().int().positive(),
  policyRole: WorkspaceInstructionPolicyRoleKey.nullable(),
  roleSource: WorkspaceInstructionPolicyRoleSource,
  entryHash: z.string().regex(/^[0-9a-f]{64}$/),
  entries: z.array(WorkspaceInstructionPolicySnapshotEntry).max(3),
  createdAt: z.string().datetime(),
});
export type WorkspaceInstructionPolicySnapshot = z.infer<typeof WorkspaceInstructionPolicySnapshot>;

export const ResolvedWorkspaceInstructionPolicySnapshotEntry =
  WorkspaceInstructionPolicySnapshotEntry.extend({
    content: z.string().min(1).max(WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS),
  });
export type ResolvedWorkspaceInstructionPolicySnapshotEntry = z.infer<
  typeof ResolvedWorkspaceInstructionPolicySnapshotEntry
>;

export const ResolvedWorkspaceInstructionPolicySnapshot = WorkspaceInstructionPolicySnapshot.extend(
  {
    entries: z.array(ResolvedWorkspaceInstructionPolicySnapshotEntry).max(3),
  },
);
export type ResolvedWorkspaceInstructionPolicySnapshot = z.infer<
  typeof ResolvedWorkspaceInstructionPolicySnapshot
>;

export const WorkspaceInstructionPolicyActivationEvent = z.object({
  id: z.string().uuid(),
  operationId: z.string().uuid(),
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  ...targetShape,
  type: WorkspaceInstructionPolicyActivationType,
  activationVersion: z.number().int().positive(),
  oldRevision: WorkspaceInstructionPolicyRevisionIdentity.nullable(),
  newRevision: WorkspaceInstructionPolicyRevisionIdentity,
  actorSubjectId: z.string().min(1),
  reason: z.string().min(1).max(WORKSPACE_INSTRUCTION_POLICY_REASON_MAX_CHARS),
  createdAt: z.string().datetime(),
});
export type WorkspaceInstructionPolicyActivationEvent = z.infer<
  typeof WorkspaceInstructionPolicyActivationEvent
>;

export const CreateWorkspaceInstructionPolicyDraftRequest = z
  .object({
    operationId: z.string().uuid().optional(),
    kind: WorkspaceInstructionPolicyKind,
    scope: WorkspaceInstructionPolicyScope,
    roleKey: WorkspaceInstructionPolicyRoleKeyInput.nullable().default(null),
    content: z
      .string()
      .min(1)
      .max(WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS)
      .refine((value) => value.trim().length > 0, "instruction policy content must not be blank"),
    provenanceSource: WorkspaceInstructionPolicyDraftProvenanceSource.default("human"),
    provenanceSourceId: z
      .string()
      .min(1)
      .max(WORKSPACE_INSTRUCTION_POLICY_SOURCE_ID_MAX_CHARS)
      .nullable()
      .default(null),
    supersedesRevisionId: z.string().uuid().nullable().default(null),
  })
  .superRefine(validateTarget);
export type CreateWorkspaceInstructionPolicyDraftRequest = z.infer<
  typeof CreateWorkspaceInstructionPolicyDraftRequest
>;

export const ImportLegacyWorkspaceInstructionPolicyDraftRequest = z
  .object({
    operationId: z.string().uuid().optional(),
    supersedesRevisionId: z.string().uuid().nullable().default(null),
  })
  .strict();
export type ImportLegacyWorkspaceInstructionPolicyDraftRequest = z.infer<
  typeof ImportLegacyWorkspaceInstructionPolicyDraftRequest
>;

export const WorkspaceInstructionPolicyListQuery = z.object({
  kind: WorkspaceInstructionPolicyKind.optional(),
  scope: WorkspaceInstructionPolicyScope.optional(),
  roleKey: WorkspaceInstructionPolicyRoleKeyInput.nullable().optional(),
  afterRevision: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type WorkspaceInstructionPolicyListQuery = z.infer<
  typeof WorkspaceInstructionPolicyListQuery
>;

export const WorkspaceInstructionPolicyListResponse = z.object({
  revisions: z.array(WorkspaceInstructionPolicyRevision),
  activeHeads: z.array(WorkspaceInstructionPolicyHead),
  activationEvents: z.array(WorkspaceInstructionPolicyActivationEvent),
  nextAfterRevision: z.number().int().positive().nullable(),
});
export type WorkspaceInstructionPolicyListResponse = z.infer<
  typeof WorkspaceInstructionPolicyListResponse
>;

export const WorkspaceInstructionPolicyDiffRequest = z
  .object({
    fromRevisionId: z.string().uuid(),
    toRevisionId: z.string().uuid(),
  })
  .refine((value) => value.fromRevisionId !== value.toRevisionId, {
    message: "diff revisions must be different",
    path: ["toRevisionId"],
  });
export type WorkspaceInstructionPolicyDiffRequest = z.infer<
  typeof WorkspaceInstructionPolicyDiffRequest
>;

export const WorkspaceInstructionPolicyDiffResponse = z.object({
  from: WorkspaceInstructionPolicyRevision,
  to: WorkspaceInstructionPolicyRevision,
  format: z.literal("unified"),
  diff: z.string(),
});
export type WorkspaceInstructionPolicyDiffResponse = z.infer<
  typeof WorkspaceInstructionPolicyDiffResponse
>;

export const ActivateWorkspaceInstructionPolicyRequest = z.object({
  operationId: z.string().uuid().optional(),
  expectedCurrentRevisionId: z.string().uuid().nullable(),
  expectedActivationVersion: z.number().int().nonnegative().optional(),
  reason: z.string().trim().min(1).max(WORKSPACE_INSTRUCTION_POLICY_REASON_MAX_CHARS),
});
export type ActivateWorkspaceInstructionPolicyRequest = z.infer<
  typeof ActivateWorkspaceInstructionPolicyRequest
>;

export const RollbackWorkspaceInstructionPolicyRequest = z.object({
  operationId: z.string().uuid().optional(),
  targetRevisionId: z.string().uuid(),
  expectedCurrentRevisionId: z.string().uuid(),
  expectedActivationVersion: z.number().int().positive().optional(),
  reason: z.string().trim().min(1).max(WORKSPACE_INSTRUCTION_POLICY_REASON_MAX_CHARS),
});
export type RollbackWorkspaceInstructionPolicyRequest = z.infer<
  typeof RollbackWorkspaceInstructionPolicyRequest
>;

export const WorkspaceInstructionPolicyActivationResponse = z.object({
  head: WorkspaceInstructionPolicyHead,
  event: WorkspaceInstructionPolicyActivationEvent,
});
export type WorkspaceInstructionPolicyActivationResponse = z.infer<
  typeof WorkspaceInstructionPolicyActivationResponse
>;

export const WorkspaceInstructionPolicyConflictResponse = z.object({
  code: z.literal("WORKSPACE_INSTRUCTION_POLICY_CONFLICT"),
  message: z.string(),
  currentHead: WorkspaceInstructionPolicyHead.nullable(),
});
export type WorkspaceInstructionPolicyConflictResponse = z.infer<
  typeof WorkspaceInstructionPolicyConflictResponse
>;

export const WorkspaceInstructionPolicyOperationReuseResponse = z.object({
  code: z.literal("WORKSPACE_INSTRUCTION_POLICY_OPERATION_REUSED"),
  message: z.string(),
});
export type WorkspaceInstructionPolicyOperationReuseResponse = z.infer<
  typeof WorkspaceInstructionPolicyOperationReuseResponse
>;

export const WorkspaceInstructionPolicyOnboardingProposalSource = z.object({
  id: z.string().min(1).max(WORKSPACE_INSTRUCTION_POLICY_SOURCE_ID_MAX_CHARS),
  version: z.string().min(1).max(WORKSPACE_INSTRUCTION_POLICY_ONBOARDING_SOURCE_VERSION_MAX_CHARS),
  confidenceBps: z.number().int().min(0).max(10_000),
});
export type WorkspaceInstructionPolicyOnboardingProposalSource = z.infer<
  typeof WorkspaceInstructionPolicyOnboardingProposalSource
>;

export const CreateWorkspaceInstructionPolicyOnboardingProposalRequest = z
  .object({
    operationId: z.string().uuid().optional(),
    kind: WorkspaceInstructionPolicyKind,
    scope: WorkspaceInstructionPolicyScope,
    roleKey: WorkspaceInstructionPolicyRoleKeyInput.nullable().default(null),
    // Content bounds are enforced by the domain layer so empty and oversized
    // proposals retain their typed API outcomes instead of collapsing into a
    // generic request-shape error.
    content: z.string(),
    sourceId: z.string().trim().min(1).max(WORKSPACE_INSTRUCTION_POLICY_SOURCE_ID_MAX_CHARS),
    sourceVersion: z
      .string()
      .trim()
      .min(1)
      .max(WORKSPACE_INSTRUCTION_POLICY_ONBOARDING_SOURCE_VERSION_MAX_CHARS),
    confidenceBps: z.number().int().min(0).max(10_000),
    expectedCurrentRevisionId: z.string().uuid().nullable(),
    expectedActivationVersion: z.number().int().nonnegative(),
  })
  .superRefine(validateTarget);
export type CreateWorkspaceInstructionPolicyOnboardingProposalRequest = z.infer<
  typeof CreateWorkspaceInstructionPolicyOnboardingProposalRequest
>;

export const WorkspaceInstructionPolicyOnboardingProposal = z.object({
  id: z.string().uuid(),
  operationId: z.string().uuid(),
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  ...targetShape,
  source: WorkspaceInstructionPolicyOnboardingProposalSource,
  baseline: WorkspaceInstructionPolicyHead.nullable(),
  draft: WorkspaceInstructionPolicyRevision,
  status: z.literal("proposed"),
  createdBySubjectId: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type WorkspaceInstructionPolicyOnboardingProposal = z.infer<
  typeof WorkspaceInstructionPolicyOnboardingProposal
>;

export const WorkspaceInstructionPolicyOnboardingProposalListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type WorkspaceInstructionPolicyOnboardingProposalListQuery = z.infer<
  typeof WorkspaceInstructionPolicyOnboardingProposalListQuery
>;

export const WorkspaceInstructionPolicyOnboardingProposalListResponse = z.object({
  proposals: z.array(WorkspaceInstructionPolicyOnboardingProposal),
  truncated: z.boolean(),
});
export type WorkspaceInstructionPolicyOnboardingProposalListResponse = z.infer<
  typeof WorkspaceInstructionPolicyOnboardingProposalListResponse
>;

export const WorkspaceInstructionPolicyOnboardingProposalContentErrorResponse = z.object({
  code: z.enum([
    "WORKSPACE_INSTRUCTION_POLICY_ONBOARDING_PROPOSAL_EMPTY",
    "WORKSPACE_INSTRUCTION_POLICY_ONBOARDING_PROPOSAL_OVERSIZED",
  ]),
  message: z.string(),
  maxChars: z.number().int().positive(),
});
export type WorkspaceInstructionPolicyOnboardingProposalContentErrorResponse = z.infer<
  typeof WorkspaceInstructionPolicyOnboardingProposalContentErrorResponse
>;

export const WorkspaceInstructionPolicyOnboardingProposalStaleResponse = z.object({
  code: z.literal("WORKSPACE_INSTRUCTION_POLICY_ONBOARDING_PROPOSAL_STALE"),
  message: z.string(),
  currentHead: WorkspaceInstructionPolicyHead.nullable(),
});
export type WorkspaceInstructionPolicyOnboardingProposalStaleResponse = z.infer<
  typeof WorkspaceInstructionPolicyOnboardingProposalStaleResponse
>;

export const WorkspaceInstructionPolicyOnboardingProposalConflictResponse = z.object({
  code: z.literal("WORKSPACE_INSTRUCTION_POLICY_ONBOARDING_PROPOSAL_CONFLICT"),
  message: z.string(),
  existingProposalId: z.string().uuid(),
  existingDraftRevisionId: z.string().uuid(),
});
export type WorkspaceInstructionPolicyOnboardingProposalConflictResponse = z.infer<
  typeof WorkspaceInstructionPolicyOnboardingProposalConflictResponse
>;
