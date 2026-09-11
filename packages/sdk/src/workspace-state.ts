import type {
  WorkspaceInstructionPolicyKind,
  WorkspaceInstructionPolicyProvenanceSource,
  WorkspaceInstructionPolicyScope,
} from "./workspace-instruction-policies";

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
  preferences: {
    authority: "preference_registry_preferences";
    activeDescriptorCount: number;
    activeDescriptorHash: string;
    scopeCounts: { organization: number; workspace: number; user: number };
    truncated: boolean;
  };
  knowledge:
    | {
        availability: "unavailable";
        reason: "missing_permission";
        requiredPermission: "documents:search";
      }
    | {
        availability: "available";
        authority: "knowledge_entries";
        coverage: "complete" | "partial";
        sampleLimit: 50;
        entries: Array<{
          id: string;
          revisionId: string;
          title: string;
          kind: "source" | "fact" | "decision" | "requirement" | "incident" | "note" | "group";
          scope: "organization" | "workspace" | "personal";
          updatedAt: string;
        }>;
      };
};

export type WorkspaceStateExportOmission =
  | "hidden_platform_prompts"
  | "policy_bodies"
  | "preference_content"
  | "document_content_and_private_metadata"
  | "memory_content_and_provenance"
  | "secret_values_and_credentials"
  | "session_messages_and_tool_outputs";

export type WorkspaceStateExportResponse = {
  kind: "opengeni.workspace_state.sanitized_export";
  schemaVersion: 1;
  generatedAt: string;
  stateSha256: string;
  omissions: WorkspaceStateExportOmission[];
  state: WorkspaceStateResponse;
};
