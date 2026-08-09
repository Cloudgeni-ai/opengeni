import { z } from "zod";

export const DURABLE_LEARNING_CONTRACT_VERSION = "durable-learning.v1" as const;
export const DURABLE_LEARNING_CONTENT_MAX_CHARS = 262_144;
export const DURABLE_LEARNING_SUMMARY_MAX_CHARS = 512;
export const DURABLE_LEARNING_REASON_MAX_CHARS = 4_096;
export const DURABLE_LEARNING_EVIDENCE_MAX_COUNT = 32;

export const DurableLearningOrigin = z.enum([
  "explicit_remember",
  "autonomous_learning",
  "legacy_memory_save",
  "human_admin",
  "migration",
]);
export type DurableLearningOrigin = z.infer<typeof DurableLearningOrigin>;

export const DurableLearningRequestedAuthority = z.enum([
  "unspecified",
  "active",
  "proposal",
  "evidence_only",
]);
export type DurableLearningRequestedAuthority = z.infer<typeof DurableLearningRequestedAuthority>;

export const DurableLearningSurface = z.enum([
  "unspecified",
  "memory",
  "preference_registry",
  "instruction_policy",
  "company_profile",
  "documents_evidence",
]);
export type DurableLearningSurface = z.infer<typeof DurableLearningSurface>;

export const DurableLearningResolvedSurface = DurableLearningSurface.exclude(["unspecified"]);
export type DurableLearningResolvedSurface = z.infer<typeof DurableLearningResolvedSurface>;

export const DurableLearningScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unspecified") }),
  z.object({ kind: z.literal("organization") }),
  z.object({ kind: z.literal("workspace") }),
  z.object({ kind: z.literal("user"), subjectId: z.string().min(1).max(1_024) }),
  z.object({ kind: z.literal("role"), roleKey: z.string().min(1).max(64) }),
  z.object({ kind: z.literal("session"), sessionId: z.string().uuid() }),
  z.object({
    kind: z.literal("ephemeral"),
    sessionId: z.string().uuid(),
    validUntil: z.string().datetime({ offset: true }),
  }),
]);
export type DurableLearningScope = z.infer<typeof DurableLearningScope>;

export const DurableLearningResolvedScope = DurableLearningScope.refine(
  (scope) => scope.kind !== "unspecified",
  "durable learning scope must be resolved",
);
export type DurableLearningResolvedScope = Exclude<DurableLearningScope, { kind: "unspecified" }>;

export const DurableLearningSubjectKind = z.enum([
  "fact",
  "decision",
  "observation",
  "history",
  "preference",
  "procedure",
  "working_method",
  "skill_guidance",
  "workspace_charter",
  "mandatory_operating_context",
  "workspace_goal",
  "company_identity",
  "company_mission",
  "company_product",
  "company_customer",
  "company_goal",
  "company_constraint",
  "document",
  "connector_content",
  "transcript",
]);
export type DurableLearningSubjectKind = z.infer<typeof DurableLearningSubjectKind>;

export const DurableLearningSubject = z.object({
  kind: DurableLearningSubjectKind,
  content: z
    .string()
    .min(1)
    .max(DURABLE_LEARNING_CONTENT_MAX_CHARS)
    .refine((value) => value.trim().length > 0, "durable learning content must not be blank"),
  stableKey: z.string().min(1).max(96).nullable().default(null),
  title: z.string().min(1).max(120).nullable().default(null),
  summary: z.string().min(1).max(DURABLE_LEARNING_SUMMARY_MAX_CHARS).nullable().default(null),
  roleKey: z.string().min(1).max(64).nullable().default(null),
  replacesResourceId: z.string().min(1).max(512).nullable().default(null),
  legacyMemory: z
    .object({
      kind: z.enum(["semantic", "preference", "procedural", "episodic", "decision"]),
      confidence: z.number().min(0).max(1).nullable().default(null),
      pinned: z.boolean().nullable().default(null),
      metadata: z.record(z.string(), z.unknown()).default({}),
    })
    .nullable()
    .default(null),
});
export type DurableLearningSubject = z.infer<typeof DurableLearningSubject>;

export const DurableLearningEvidenceEligibility = z.enum(["eligible", "revoked", "unknown"]);
export type DurableLearningEvidenceEligibility = z.infer<typeof DurableLearningEvidenceEligibility>;

export const DurableLearningEvidence = z.object({
  kind: z.enum([
    "human_statement",
    "session_message",
    "session_observation",
    "memory",
    "document",
    "connector",
    "knowledge_claim",
    "admin_action",
    "migration",
  ]),
  sourceId: z.string().min(1).max(1_024),
  sourceVersion: z.string().min(1).max(256).nullable().default(null),
  contentHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable()
    .default(null),
  eligibility: DurableLearningEvidenceEligibility,
});
export type DurableLearningEvidence = z.infer<typeof DurableLearningEvidence>;

export const DurableLearningWriteRequest = z.object({
  contractVersion: z.literal(DURABLE_LEARNING_CONTRACT_VERSION),
  operation: z.literal("write"),
  attemptId: z.string().uuid(),
  origin: DurableLearningOrigin,
  requestedAuthority: DurableLearningRequestedAuthority,
  requestedScope: DurableLearningScope,
  targetSurface: DurableLearningSurface,
  subject: DurableLearningSubject,
  evidence: z.array(DurableLearningEvidence).max(DURABLE_LEARNING_EVIDENCE_MAX_COUNT).default([]),
});
export type DurableLearningWriteRequest = z.infer<typeof DurableLearningWriteRequest>;

export const DurableLearningRollbackRequest = z.object({
  contractVersion: z.literal(DURABLE_LEARNING_CONTRACT_VERSION),
  operation: z.literal("rollback"),
  attemptId: z.string().uuid(),
  origin: DurableLearningOrigin,
  targetAttemptId: z.string().uuid(),
  reason: z.string().trim().min(1).max(DURABLE_LEARNING_REASON_MAX_CHARS),
});
export type DurableLearningRollbackRequest = z.infer<typeof DurableLearningRollbackRequest>;

export const DurableLearningRequest = z.discriminatedUnion("operation", [
  DurableLearningWriteRequest,
  DurableLearningRollbackRequest,
]);
export type DurableLearningRequest = z.infer<typeof DurableLearningRequest>;

export const DurableLearningActorKind = z.enum(["human", "agent", "service"]);
export type DurableLearningActorKind = z.infer<typeof DurableLearningActorKind>;

export const DurableLearningPolicyMode = z.enum(["off", "suggest", "automatic"]);
export type DurableLearningPolicyMode = z.infer<typeof DurableLearningPolicyMode>;

export const DurableLearningAuthorityContext = z.object({
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  actor: z.object({
    kind: DurableLearningActorKind,
    subjectId: z.string().min(1).max(1_024),
  }),
  initiatingHumanSubjectId: z.string().min(1).max(1_024).nullable(),
  sessionId: z.string().uuid().nullable(),
  grants: z.object({
    organization: z.boolean(),
    workspace: z.boolean(),
    selfUser: z.boolean(),
    roleKeys: z.array(z.string().min(1).max(64)).max(64),
    sessionIds: z.array(z.string().uuid()).max(64),
    ephemeralSessionIds: z.array(z.string().uuid()).max(64),
    activate: z.boolean(),
  }),
  learningPolicy: z
    .object({
      mode: DurableLearningPolicyMode,
      snapshotId: z.string().min(1).max(512),
      revisionId: z.string().min(1).max(512),
    })
    .nullable(),
  availableSurfaces: z.object({
    memory: z.boolean(),
    preferenceRegistry: z.boolean(),
    instructionPolicy: z.boolean(),
    companyProfile: z.boolean(),
    documentsEvidence: z.boolean(),
  }),
});
export type DurableLearningAuthorityContext = z.infer<typeof DurableLearningAuthorityContext>;

export const DurableLearningDecisionCode = z.enum([
  "ROUTED",
  "SCOPE_REQUIRED",
  "AUTHORITY_REQUIRED",
  "SURFACE_REQUIRED",
  "SUBJECT_SURFACE_MISMATCH",
  "SCOPE_NOT_SUPPORTED_BY_SURFACE",
  "SCOPE_NOT_AUTHORIZED",
  "INITIATING_HUMAN_REQUIRED",
  "ACTOR_INITIATING_HUMAN_MISMATCH",
  "EVIDENCE_INELIGIBLE",
  "LEARNING_POLICY_REQUIRED",
  "LEARNING_POLICY_OFF",
  "ACTIVATION_NOT_AUTHORIZED",
  "SURFACE_NOT_AVAILABLE",
  "LEGACY_MEMORY_SAVE_CONTRACT_VIOLATION",
  "ROLLBACK_TARGET_NOT_FOUND",
  "ROLLBACK_NOT_SUPPORTED",
  "ROLLBACK_NOT_AUTHORIZED",
  "ATTEMPT_REUSED_WITH_DIFFERENT_INPUT",
  "ATTEMPT_IN_PROGRESS",
  "AUTHORITY_WRITE_FAILED",
]);
export type DurableLearningDecisionCode = z.infer<typeof DurableLearningDecisionCode>;

export const DurableLearningResolvedAuthority = z.enum(["active", "proposal", "evidence_only"]);
export type DurableLearningResolvedAuthority = z.infer<typeof DurableLearningResolvedAuthority>;

export const DurableLearningRouteDecision = z.object({
  disposition: z.enum(["route", "clarification_required", "rejected"]),
  code: DurableLearningDecisionCode,
  destination: DurableLearningResolvedSurface.nullable(),
  scope: DurableLearningScope.nullable(),
  authority: DurableLearningResolvedAuthority.nullable(),
  policySnapshotId: z.string().max(512).nullable(),
  reasons: z.array(z.string().min(1).max(512)).max(16),
  clarificationFields: z
    .array(z.enum(["requestedScope", "requestedAuthority", "targetSurface"]))
    .max(3),
});
export type DurableLearningRouteDecision = z.infer<typeof DurableLearningRouteDecision>;

export const DurableLearningAttempt = z.object({
  id: z.string().uuid(),
  contractVersion: z.literal(DURABLE_LEARNING_CONTRACT_VERSION),
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  request: DurableLearningRequest,
  actor: DurableLearningAuthorityContext.shape.actor,
  initiatingHumanSubjectId: z.string().min(1).max(1_024).nullable(),
  sessionId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
});
export type DurableLearningAttempt = z.infer<typeof DurableLearningAttempt>;

export const DurableLearningResource = z.object({
  surface: DurableLearningResolvedSurface,
  id: z.string().min(1).max(512),
  version: z.string().min(1).max(512).nullable(),
  status: z.string().min(1).max(64),
});
export type DurableLearningResource = z.infer<typeof DurableLearningResource>;

export const DurableLearningReceipt = z.object({
  contractVersion: z.literal(DURABLE_LEARNING_CONTRACT_VERSION),
  attemptId: z.string().uuid(),
  inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  outcome: z.enum([
    "applied",
    "proposed",
    "evidence_recorded",
    "noop",
    "clarification_required",
    "rejected",
    "rolled_back",
    "failed",
  ]),
  decision: DurableLearningRouteDecision,
  resource: DurableLearningResource.nullable(),
  effectiveBoundary: z.enum(["immediate", "next_accepted_attempt", "not_applicable"]),
  rollback: z.object({
    supported: z.boolean(),
    targetAttemptId: z.string().uuid().nullable(),
    token: z.string().min(1).max(1_024).nullable(),
  }),
  createdAt: z.string().datetime(),
});
export type DurableLearningReceipt = z.infer<typeof DurableLearningReceipt>;

export const DurableLearningRouterResponse = z.object({
  receipt: DurableLearningReceipt,
  idempotency: z.enum(["created", "replayed"]),
});
export type DurableLearningRouterResponse = z.infer<typeof DurableLearningRouterResponse>;
