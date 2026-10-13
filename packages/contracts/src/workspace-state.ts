import { defineSchema } from "./define-schema";
import { z } from "zod";
import { KnowledgeEntryKind, KnowledgeEntryScope } from "./knowledge-entries";

import {
  WorkspaceInstructionPolicyKind,
  WorkspaceInstructionPolicyProvenanceSource,
  WorkspaceInstructionPolicyRoleKey,
  WorkspaceInstructionPolicyRoleSource,
  WorkspaceInstructionPolicyScope,
  WorkspaceInstructionPolicySnapshotEntry,
} from "./workspace-instruction-policies";

export const WORKSPACE_STATE_MAX_ACTIVE_POLICY_HEADS = 32;
export const WORKSPACE_STATE_KNOWLEDGE_SAMPLE_LIMIT = 50;
export const WORKSPACE_STATE_EXPORT_SCHEMA_VERSION = 1;

const Count = /* @__PURE__ */ defineSchema(() => z.number().int().nonnegative());

export const WorkspaceStateQuery = /* @__PURE__ */ defineSchema(() =>
  z.object({ attemptId: z.string().uuid().optional() }).strict(),
);
export type WorkspaceStateQuery = z.infer<typeof WorkspaceStateQuery>;

export const WorkspaceStatePolicyHead = /* @__PURE__ */ defineSchema(() =>
  z
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
    .strict(),
);

export const WorkspaceStatePolicyRevisionSummary = /* @__PURE__ */ defineSchema(() =>
  z
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
    .strict(),
);

export const WorkspaceStatePolicy = /* @__PURE__ */ defineSchema(() =>
  z
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
    .strict(),
);

export const WorkspaceStatePreferences = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      authority: z.literal("preference_registry_preferences"),
      activeDescriptorCount: Count.max(64),
      activeDescriptorHash: z.string().regex(/^[0-9a-f]{64}$/),
      scopeCounts: z
        .object({
          organization: Count,
          workspace: Count,
          user: Count,
        })
        .strict(),
      truncated: z.boolean(),
    })
    .strict(),
);

/** Published metadata only; exact content, revisions and evidence use Knowledge. */
export const WorkspaceStateKnowledgeAvailable = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      availability: z.literal("available"),
      authority: z.literal("knowledge_entries"),
      coverage: z.enum(["complete", "partial"]),
      sampleLimit: z.literal(WORKSPACE_STATE_KNOWLEDGE_SAMPLE_LIMIT),
      entries: z
        .array(
          z
            .object({
              id: z.uuid(),
              revisionId: z.uuid(),
              title: z.string(),
              kind: KnowledgeEntryKind,
              scope: KnowledgeEntryScope,
              updatedAt: z.string().datetime({ offset: true }),
            })
            .strict(),
        )
        .max(WORKSPACE_STATE_KNOWLEDGE_SAMPLE_LIMIT),
    })
    .strict(),
);

export const WorkspaceStateKnowledgeUnavailable = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      availability: z.literal("unavailable"),
      reason: z.literal("missing_permission"),
      requiredPermission: z.literal("documents:search"),
    })
    .strict(),
);

export const WorkspaceStateKnowledge = /* @__PURE__ */ defineSchema(() =>
  z.discriminatedUnion("availability", [
    WorkspaceStateKnowledgeAvailable,
    WorkspaceStateKnowledgeUnavailable,
  ]),
);
export type WorkspaceStateKnowledge = z.infer<typeof WorkspaceStateKnowledge>;

export const WorkspaceStateGovernanceDriftStatus = /* @__PURE__ */ defineSchema(() =>
  z.enum(["identical", "changed", "superseded", "missing", "unavailable", "truncated"]),
);
export type WorkspaceStateGovernanceDriftStatus = z.infer<
  typeof WorkspaceStateGovernanceDriftStatus
>;

const WorkspaceStatePolicySnapshotAvailable = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      status: z.literal("available"),
      id: z.string().uuid(),
      createdAt: z.string().datetime(),
      entryHash: z.string().regex(/^[0-9a-f]{64}$/),
      policyRole: WorkspaceInstructionPolicyRoleKey.nullable(),
      roleSource: WorkspaceInstructionPolicyRoleSource,
      entries: z.array(WorkspaceInstructionPolicySnapshotEntry).max(3),
    })
    .strict(),
);

const WorkspaceStatePolicySnapshotMissing = /* @__PURE__ */ defineSchema(() =>
  z.object({ status: z.literal("missing") }).strict(),
);

const WorkspaceStatePreferenceSnapshotAvailable = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      status: z.literal("available"),
      id: z.string().uuid(),
      createdAt: z.string().datetime(),
      descriptorHash: z.string().regex(/^[0-9a-f]{64}$/),
      descriptorCount: Count.max(64),
      truncated: z.boolean(),
    })
    .strict(),
);

const WorkspaceStatePreferenceSnapshotMissing = /* @__PURE__ */ defineSchema(() =>
  z.object({ status: z.literal("missing") }).strict(),
);

const WorkspaceStateGovernanceDrift = /* @__PURE__ */ defineSchema(() =>
  z
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
    .strict(),
);

export const WorkspaceStateAttemptGovernance = /* @__PURE__ */ defineSchema(() =>
  z.discriminatedUnion("status", [
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
  ]),
);
export type WorkspaceStateAttemptGovernance = z.infer<typeof WorkspaceStateAttemptGovernance>;

export const WorkspaceStateResponse = /* @__PURE__ */ defineSchema(() =>
  z
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
      preferences: WorkspaceStatePreferences,
      knowledge: WorkspaceStateKnowledge,
    })
    .strict(),
);
export type WorkspaceStateResponse = z.infer<typeof WorkspaceStateResponse>;

export const WorkspaceStateExportOmission = /* @__PURE__ */ defineSchema(() =>
  z.enum([
    "hidden_platform_prompts",
    "policy_bodies",
    "preference_content",
    "document_content_and_private_metadata",
    "memory_content_and_provenance",
    "secret_values_and_credentials",
    "session_messages_and_tool_outputs",
  ]),
);
export type WorkspaceStateExportOmission = z.infer<typeof WorkspaceStateExportOmission>;

export const WorkspaceStateExportResponse = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      kind: z.literal("opengeni.workspace_state.sanitized_export"),
      schemaVersion: z.literal(WORKSPACE_STATE_EXPORT_SCHEMA_VERSION),
      generatedAt: z.string().datetime(),
      stateSha256: z.string().regex(/^[0-9a-f]{64}$/),
      omissions: z.array(WorkspaceStateExportOmission).length(7),
      state: WorkspaceStateResponse,
    })
    .strict(),
);
export type WorkspaceStateExportResponse = z.infer<typeof WorkspaceStateExportResponse>;
