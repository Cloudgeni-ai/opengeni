import { z } from "zod";

import {
  WorkspaceInstructionPolicyKind,
  WorkspaceInstructionPolicyProvenanceSource,
  WorkspaceInstructionPolicyRoleKey,
  WorkspaceInstructionPolicyRoleSource,
  WorkspaceInstructionPolicyScope,
  WorkspaceInstructionPolicySnapshotEntry,
} from "./workspace-instruction-policies";

export const WORKSPACE_STATE_MAX_ACTIVE_POLICY_HEADS = 32;
export const WORKSPACE_STATE_MAX_BASES = 24;
export const WORKSPACE_STATE_MAX_TOPICS = 24;
export const WORKSPACE_STATE_MAX_GAPS = 16;
export const WORKSPACE_STATE_BASE_NAME_MAX_CHARS = 160;
export const WORKSPACE_STATE_TOPIC_MAX_CHARS = 96;
export const WORKSPACE_STATE_MEMORY_SAMPLE_LIMIT = 100;

const Count = z.number().int().nonnegative();

export const WorkspaceStateQuery = z.object({ attemptId: z.string().uuid().optional() }).strict();
export type WorkspaceStateQuery = z.infer<typeof WorkspaceStateQuery>;

export const WorkspaceStateDocumentStatusCounts = z
  .object({
    queued: Count,
    indexing: Count,
    ready: Count,
    failed: Count,
  })
  .strict();
export type WorkspaceStateDocumentStatusCounts = z.infer<typeof WorkspaceStateDocumentStatusCounts>;

export const WorkspaceStateSourceKindCounts = z
  .object({
    manual_upload: Count,
    meeting_transcript: Count,
    repository: Count,
    email: Count,
    chat: Count,
    document: Count,
    web: Count,
    other: Count,
  })
  .strict();
export type WorkspaceStateSourceKindCounts = z.infer<typeof WorkspaceStateSourceKindCounts>;

export const WorkspaceStateMemoryStatusCounts = z
  .object({
    proposed: Count,
    approved: Count,
    rejected: Count,
    active: Count,
    superseded: Count,
    archived: Count,
  })
  .strict();
export type WorkspaceStateMemoryStatusCounts = z.infer<typeof WorkspaceStateMemoryStatusCounts>;

export const WorkspaceStateMemoryKindCounts = z
  .object({
    semantic: Count,
    episodic: Count,
    procedural: Count,
    decision: Count,
    preference: Count,
  })
  .strict();
export type WorkspaceStateMemoryKindCounts = z.infer<typeof WorkspaceStateMemoryKindCounts>;

export const WorkspaceStatePolicyHead = z
  .object({
    kind: WorkspaceInstructionPolicyKind,
    scope: WorkspaceInstructionPolicyScope,
    roleKey: WorkspaceInstructionPolicyRoleKey.nullable(),
    revisionId: z.string().uuid(),
    revision: z.number().int().positive(),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    activationVersion: z.number().int().positive(),
    activatedAt: z.string().datetime(),
  })
  .strict();

export const WorkspaceStatePolicyRevisionSummary = z
  .object({
    kind: WorkspaceInstructionPolicyKind,
    scope: WorkspaceInstructionPolicyScope,
    roleKey: WorkspaceInstructionPolicyRoleKey.nullable(),
    revisionId: z.string().uuid(),
    revision: z.number().int().positive(),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    provenanceSource: WorkspaceInstructionPolicyProvenanceSource,
    state: z.enum(["active", "inactive"]),
    createdAt: z.string().datetime(),
  })
  .strict();

export const WorkspaceStatePolicy = z
  .object({
    authority: z.literal("workspace_instruction_policy_heads"),
    activeHeads: z.array(WorkspaceStatePolicyHead).max(WORKSPACE_STATE_MAX_ACTIVE_POLICY_HEADS),
    activeHeadsTruncated: z.boolean(),
    latestRevision: WorkspaceStatePolicyRevisionSummary.nullable(),
    legacyRuntime: z
      .object({
        source: z.enum(["workspace_override", "deployment_default"]),
        workspaceOverrideConfigured: z.boolean(),
      })
      .strict(),
    runtimeComposition: z
      .object({
        status: z.literal("not_implemented"),
      })
      .strict(),
  })
  .strict();

export const WorkspaceStateKnowledgeBase = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(WORKSPACE_STATE_BASE_NAME_MAX_CHARS),
    visibleDocumentCount: Count,
    statusCounts: WorkspaceStateDocumentStatusCounts,
    latestUpdatedAt: z.string().datetime().nullable(),
  })
  .strict();

export const WorkspaceStateTopic = z
  .object({
    name: z.string().min(1).max(WORKSPACE_STATE_TOPIC_MAX_CHARS),
    documentCount: Count,
  })
  .strict();

export const WorkspaceStateGapCode = z.enum([
  "no_document_bases",
  "no_visible_documents",
  "failed_documents",
  "processing_documents",
  "missing_topic_coverage",
  "no_memory_records",
  "pending_memory_review",
  "partial_inventory",
]);
export type WorkspaceStateGapCode = z.infer<typeof WorkspaceStateGapCode>;

export const WorkspaceStateGap = z
  .object({
    code: WorkspaceStateGapCode,
    severity: z.enum(["info", "warning"]),
    relatedCount: Count.nullable(),
  })
  .strict();
export type WorkspaceStateGap = z.infer<typeof WorkspaceStateGap>;

export const WorkspaceStateKnowledgeAvailable = z
  .object({
    availability: z.literal("available"),
    coverage: z.enum(["complete", "partial"]),
    baseCount: Count,
    bases: z.array(WorkspaceStateKnowledgeBase).max(WORKSPACE_STATE_MAX_BASES),
    basesTruncated: z.boolean(),
    inspectedVisibleDocumentCount: Count,
    documentStatusCounts: WorkspaceStateDocumentStatusCounts,
    sourceKindCounts: WorkspaceStateSourceKindCounts,
    topics: z.array(WorkspaceStateTopic).max(WORKSPACE_STATE_MAX_TOPICS),
    topicsTruncated: z.boolean(),
    latestDocumentUpdatedAt: z.string().datetime().nullable(),
    memorySample: z
      .object({
        recordCount: Count.max(WORKSPACE_STATE_MEMORY_SAMPLE_LIMIT),
        sampleLimit: z.literal(WORKSPACE_STATE_MEMORY_SAMPLE_LIMIT),
        limitReached: z.boolean(),
        statusCounts: WorkspaceStateMemoryStatusCounts,
        kindCounts: WorkspaceStateMemoryKindCounts,
        preferenceAuthority: z
          .object({
            kindCountSource: z.literal("knowledge_memories_legacy_observations"),
            activeAuthority: z.literal("structured_preference_registry"),
          })
          .strict(),
        latestUpdatedAt: z.string().datetime().nullable(),
      })
      .strict(),
    gaps: z.array(WorkspaceStateGap).max(WORKSPACE_STATE_MAX_GAPS),
  })
  .strict();

export const WorkspaceStateKnowledgeUnavailable = z
  .object({
    availability: z.literal("unavailable"),
    reason: z.literal("missing_permission"),
    requiredPermission: z.literal("documents:search"),
  })
  .strict();

export const WorkspaceStateKnowledge = z.discriminatedUnion("availability", [
  WorkspaceStateKnowledgeAvailable,
  WorkspaceStateKnowledgeUnavailable,
]);
export type WorkspaceStateKnowledge = z.infer<typeof WorkspaceStateKnowledge>;

export const WorkspaceStateGovernanceDriftStatus = z.enum([
  "identical",
  "changed",
  "superseded",
  "missing",
  "unavailable",
  "truncated",
]);
export type WorkspaceStateGovernanceDriftStatus = z.infer<
  typeof WorkspaceStateGovernanceDriftStatus
>;

const WorkspaceStatePolicySnapshotAvailable = z
  .object({
    status: z.literal("available"),
    id: z.string().uuid(),
    createdAt: z.string().datetime(),
    entryHash: z.string().regex(/^[0-9a-f]{64}$/),
    policyRole: WorkspaceInstructionPolicyRoleKey.nullable(),
    roleSource: WorkspaceInstructionPolicyRoleSource,
    entries: z.array(WorkspaceInstructionPolicySnapshotEntry).max(3),
  })
  .strict();

const WorkspaceStatePolicySnapshotMissing = z.object({ status: z.literal("missing") }).strict();

const WorkspaceStatePreferenceSnapshotAvailable = z
  .object({
    status: z.literal("available"),
    id: z.string().uuid(),
    createdAt: z.string().datetime(),
    descriptorHash: z.string().regex(/^[0-9a-f]{64}$/),
    descriptorCount: Count.max(64),
    truncated: z.boolean(),
  })
  .strict();

const WorkspaceStatePreferenceSnapshotMissing = z.object({ status: z.literal("missing") }).strict();

const WorkspaceStateGovernanceDrift = z
  .object({
    overall: WorkspaceStateGovernanceDriftStatus,
    policy: z
      .object({
        status: WorkspaceStateGovernanceDriftStatus,
        snapshotHash: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .nullable(),
        currentHash: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .nullable(),
        snapshotTargetCount: Count,
        currentTargetCount: Count,
      })
      .strict(),
    preferences: z
      .object({
        status: WorkspaceStateGovernanceDriftStatus,
        snapshotHash: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .nullable(),
        currentHash: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .nullable(),
        snapshotDescriptorCount: Count,
        currentDescriptorCount: Count,
        snapshotTruncated: z.boolean(),
        currentTruncated: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const WorkspaceStateAttemptGovernance = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_requested") }).strict(),
  z
    .object({
      status: z.literal("unavailable"),
      reason: z.literal("attempt_not_found_or_not_authorized"),
      driftStatus: z.literal("unavailable"),
    })
    .strict(),
  z
    .object({
      status: z.literal("available"),
      attemptId: z.string().uuid(),
      executionGeneration: z.number().int().positive(),
      acceptedAt: z.string().datetime(),
      policySnapshot: z.discriminatedUnion("status", [
        WorkspaceStatePolicySnapshotAvailable,
        WorkspaceStatePolicySnapshotMissing,
      ]),
      preferenceSnapshot: z.discriminatedUnion("status", [
        WorkspaceStatePreferenceSnapshotAvailable,
        WorkspaceStatePreferenceSnapshotMissing,
      ]),
      drift: WorkspaceStateGovernanceDrift,
    })
    .strict(),
]);
export type WorkspaceStateAttemptGovernance = z.infer<typeof WorkspaceStateAttemptGovernance>;

export const WorkspaceStateResponse = z
  .object({
    workspaceId: z.string().uuid(),
    generatedAt: z.string().datetime(),
    truth: z
      .object({
        current: z
          .object({
            source: z.literal("read_time_projection"),
            capturedAt: z.string().datetime(),
          })
          .strict(),
        attemptGovernance: WorkspaceStateAttemptGovernance,
      })
      .strict(),
    policy: WorkspaceStatePolicy,
    knowledge: WorkspaceStateKnowledge,
  })
  .strict();
export type WorkspaceStateResponse = z.infer<typeof WorkspaceStateResponse>;
