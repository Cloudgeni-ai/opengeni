import type {
  WorkspaceInstructionPolicyKind,
  WorkspaceInstructionPolicyProvenanceSource,
  WorkspaceInstructionPolicyScope,
} from "./workspace-instruction-policies";

export type WorkspaceStateDocumentStatusCounts = {
  queued: number;
  indexing: number;
  ready: number;
  failed: number;
};

export type WorkspaceStateSourceKindCounts = {
  manual_upload: number;
  meeting_transcript: number;
  repository: number;
  email: number;
  chat: number;
  document: number;
  web: number;
  other: number;
};

export type WorkspaceStateMemoryStatusCounts = {
  proposed: number;
  approved: number;
  rejected: number;
  active: number;
  superseded: number;
  archived: number;
};

export type WorkspaceStateMemoryKindCounts = {
  semantic: number;
  episodic: number;
  procedural: number;
  decision: number;
  preference: number;
};

export type WorkspaceStateGapCode =
  | "no_document_bases"
  | "no_visible_documents"
  | "failed_documents"
  | "processing_documents"
  | "missing_topic_coverage"
  | "no_memory_records"
  | "pending_memory_review"
  | "partial_inventory";

export type WorkspaceStateGovernanceDriftStatus =
  | "identical"
  | "changed"
  | "superseded"
  | "missing"
  | "unavailable"
  | "truncated";

export type WorkspaceStateGetOptions = { attemptId?: string };

export type WorkspaceStateAttemptGovernance =
  | { status: "not_requested" }
  | {
      status: "unavailable";
      reason: "attempt_not_found_or_not_authorized";
      driftStatus: "unavailable";
    }
  | {
      status: "available";
      attemptId: string;
      executionGeneration: number;
      acceptedAt: string;
      policySnapshot:
        | { status: "missing" }
        | {
            status: "available";
            id: string;
            createdAt: string;
            entryHash: string;
            policyRole: string | null;
            roleSource:
              | "session_binding"
              | "metadata_fallback"
              | "none"
              | "invalid_metadata_fallback";
            entries: Array<{
              kind: WorkspaceInstructionPolicyKind;
              scope: WorkspaceInstructionPolicyScope;
              roleKey: string | null;
              revisionId: string;
              revision: number;
              contentHash: string;
              activationVersion: number;
              activatedAt: string;
              provenance: {
                source: WorkspaceInstructionPolicyProvenanceSource;
                sourceIdHash: string | null;
              };
            }>;
          };
      preferenceSnapshot:
        | { status: "missing" }
        | {
            status: "available";
            id: string;
            createdAt: string;
            descriptorHash: string;
            descriptorCount: number;
            truncated: boolean;
          };
      drift: {
        overall: WorkspaceStateGovernanceDriftStatus;
        policy: {
          status: WorkspaceStateGovernanceDriftStatus;
          snapshotHash: string | null;
          currentHash: string | null;
          snapshotTargetCount: number;
          currentTargetCount: number;
        };
        preferences: {
          status: WorkspaceStateGovernanceDriftStatus;
          snapshotHash: string | null;
          currentHash: string | null;
          snapshotDescriptorCount: number;
          currentDescriptorCount: number;
          snapshotTruncated: boolean;
          currentTruncated: boolean;
        };
      };
    };

export type WorkspaceStateResponse = {
  workspaceId: string;
  generatedAt: string;
  truth: {
    current: { source: "read_time_projection"; capturedAt: string };
    attemptGovernance: WorkspaceStateAttemptGovernance;
  };
  policy: {
    authority: "workspace_instruction_policy_heads";
    activeHeads: Array<{
      kind: WorkspaceInstructionPolicyKind;
      scope: WorkspaceInstructionPolicyScope;
      roleKey: string | null;
      revisionId: string;
      revision: number;
      contentHash: string;
      activationVersion: number;
      activatedAt: string;
    }>;
    activeHeadsTruncated: boolean;
    latestRevision: {
      kind: WorkspaceInstructionPolicyKind;
      scope: WorkspaceInstructionPolicyScope;
      roleKey: string | null;
      revisionId: string;
      revision: number;
      contentHash: string;
      provenanceSource: WorkspaceInstructionPolicyProvenanceSource;
      state: "active" | "inactive";
      createdAt: string;
    } | null;
    legacyRuntime: {
      source: "workspace_override" | "deployment_default";
      workspaceOverrideConfigured: boolean;
    };
    runtimeComposition: { status: "not_implemented" };
  };
  knowledge:
    | {
        availability: "unavailable";
        reason: "missing_permission";
        requiredPermission: "documents:search";
      }
    | {
        availability: "available";
        coverage: "complete" | "partial";
        baseCount: number;
        bases: Array<{
          id: string;
          name: string;
          visibleDocumentCount: number;
          statusCounts: WorkspaceStateDocumentStatusCounts;
          latestUpdatedAt: string | null;
        }>;
        basesTruncated: boolean;
        inspectedVisibleDocumentCount: number;
        documentStatusCounts: WorkspaceStateDocumentStatusCounts;
        sourceKindCounts: WorkspaceStateSourceKindCounts;
        topics: Array<{ name: string; documentCount: number }>;
        topicsTruncated: boolean;
        latestDocumentUpdatedAt: string | null;
        memorySample: {
          recordCount: number;
          sampleLimit: 100;
          limitReached: boolean;
          statusCounts: WorkspaceStateMemoryStatusCounts;
          kindCounts: WorkspaceStateMemoryKindCounts;
          preferenceAuthority: {
            kindCountSource: "knowledge_memories_legacy_observations";
            activeAuthority: "structured_preference_registry";
          };
          latestUpdatedAt: string | null;
        };
        gaps: Array<{
          code: WorkspaceStateGapCode;
          severity: "info" | "warning";
          relatedCount: number | null;
        }>;
      };
};
