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

export type WorkspaceStateResponse = {
  workspaceId: string;
  generatedAt: string;
  truth: {
    current: { source: "read_time_projection"; capturedAt: string };
    policySnapshot: {
      status: "not_captured";
      reason: "workspace_instruction_policy_snapshot_not_implemented";
    };
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
          latestUpdatedAt: string | null;
        };
        gaps: Array<{
          code: WorkspaceStateGapCode;
          severity: "info" | "warning";
          relatedCount: number | null;
        }>;
      };
};
