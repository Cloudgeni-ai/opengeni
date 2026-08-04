export const WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS = 262_144;

export type WorkspaceInstructionPolicyKind = "charter" | "policy";
export type WorkspaceInstructionPolicyScope = "global" | "role";
export type WorkspaceInstructionPolicyProvenanceSource =
  | "human"
  | "onboarding"
  | "knowledge_proposal"
  | "legacy_import";
export type WorkspaceInstructionPolicyDraftProvenanceSource = Exclude<
  WorkspaceInstructionPolicyProvenanceSource,
  "legacy_import"
>;
export type WorkspaceInstructionPolicyActivationType = "activate" | "rollback";

export function normalizeWorkspaceInstructionPolicyRoleKey(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, "-").replace(/-+/g, "-");
}

export type WorkspaceInstructionPolicyTarget = {
  kind: WorkspaceInstructionPolicyKind;
  scope: WorkspaceInstructionPolicyScope;
  roleKey: string | null;
};

export type WorkspaceInstructionPolicyRevisionIdentity = {
  id: string;
  revision: number;
  contentHash: string;
};

export type WorkspaceInstructionPolicyRevision = WorkspaceInstructionPolicyRevisionIdentity &
  WorkspaceInstructionPolicyTarget & {
    operationId: string;
    accountId: string;
    workspaceId: string;
    content: string;
    provenance: {
      source: WorkspaceInstructionPolicyProvenanceSource;
      sourceId: string | null;
    };
    supersedesRevisionId: string | null;
    createdBySubjectId: string;
    createdAt: string;
  };

export type WorkspaceInstructionPolicyHead = WorkspaceInstructionPolicyTarget & {
  workspaceId: string;
  revisionId: string;
  revision: number;
  contentHash: string;
  activationVersion: number;
  activatedAt: string;
};

export type WorkspaceInstructionPolicyActivationEvent = WorkspaceInstructionPolicyTarget & {
  id: string;
  operationId: string;
  accountId: string;
  workspaceId: string;
  type: WorkspaceInstructionPolicyActivationType;
  activationVersion: number;
  oldRevision: WorkspaceInstructionPolicyRevisionIdentity | null;
  newRevision: WorkspaceInstructionPolicyRevisionIdentity;
  actorSubjectId: string;
  reason: string;
  createdAt: string;
};

export type CreateWorkspaceInstructionPolicyDraftRequest = WorkspaceInstructionPolicyTarget & {
  operationId?: string;
  content: string;
  provenanceSource?: WorkspaceInstructionPolicyDraftProvenanceSource;
  provenanceSourceId?: string | null;
  supersedesRevisionId?: string | null;
};

export type ImportLegacyWorkspaceInstructionPolicyDraftRequest = {
  operationId?: string;
  supersedesRevisionId?: string | null;
};

export type WorkspaceInstructionPolicyListOptions = {
  kind?: WorkspaceInstructionPolicyKind;
  scope?: WorkspaceInstructionPolicyScope;
  roleKey?: string;
  afterRevision?: number;
  limit?: number;
};

export type WorkspaceInstructionPolicyListResponse = {
  revisions: WorkspaceInstructionPolicyRevision[];
  activeHeads: WorkspaceInstructionPolicyHead[];
  activationEvents: WorkspaceInstructionPolicyActivationEvent[];
  nextAfterRevision: number | null;
};

export type WorkspaceInstructionPolicyDiffRequest = {
  fromRevisionId: string;
  toRevisionId: string;
};

export type WorkspaceInstructionPolicyDiffResponse = {
  from: WorkspaceInstructionPolicyRevision;
  to: WorkspaceInstructionPolicyRevision;
  format: "unified";
  diff: string;
};

export type ActivateWorkspaceInstructionPolicyRequest = {
  operationId?: string;
  expectedCurrentRevisionId: string | null;
  expectedActivationVersion?: number;
  reason: string;
};

export type RollbackWorkspaceInstructionPolicyRequest = {
  operationId?: string;
  targetRevisionId: string;
  expectedCurrentRevisionId: string;
  expectedActivationVersion?: number;
  reason: string;
};

export type WorkspaceInstructionPolicyActivationResponse = {
  head: WorkspaceInstructionPolicyHead;
  event: WorkspaceInstructionPolicyActivationEvent;
};

export type WorkspaceInstructionPolicyConflictResponse = {
  code: "WORKSPACE_INSTRUCTION_POLICY_CONFLICT";
  message: string;
  currentHead: WorkspaceInstructionPolicyHead | null;
};

export type WorkspaceInstructionPolicyOperationReuseResponse = {
  code: "WORKSPACE_INSTRUCTION_POLICY_OPERATION_REUSED";
  message: string;
};

export type WorkspaceInstructionPolicyOnboardingProposalSource = {
  id: string;
  version: string;
  confidenceBps: number;
};

export type CreateWorkspaceInstructionPolicyOnboardingProposalRequest =
  WorkspaceInstructionPolicyTarget & {
    operationId?: string;
    content: string;
    sourceId: string;
    sourceVersion: string;
    confidenceBps: number;
    expectedCurrentRevisionId: string | null;
    expectedActivationVersion: number;
  };

export type WorkspaceInstructionPolicyOnboardingProposal = WorkspaceInstructionPolicyTarget & {
  id: string;
  operationId: string;
  accountId: string;
  workspaceId: string;
  source: WorkspaceInstructionPolicyOnboardingProposalSource;
  baseline: WorkspaceInstructionPolicyHead | null;
  draft: WorkspaceInstructionPolicyRevision;
  status: "proposed";
  createdBySubjectId: string;
  createdAt: string;
};

export type WorkspaceInstructionPolicyOnboardingProposalListOptions = {
  limit?: number;
};

export type WorkspaceInstructionPolicyOnboardingProposalListResponse = {
  proposals: WorkspaceInstructionPolicyOnboardingProposal[];
  truncated: boolean;
};

export type WorkspaceInstructionPolicyOnboardingProposalContentErrorResponse = {
  code:
    | "WORKSPACE_INSTRUCTION_POLICY_ONBOARDING_PROPOSAL_EMPTY"
    | "WORKSPACE_INSTRUCTION_POLICY_ONBOARDING_PROPOSAL_OVERSIZED";
  message: string;
  maxChars: number;
};

export type WorkspaceInstructionPolicyOnboardingProposalStaleResponse = {
  code: "WORKSPACE_INSTRUCTION_POLICY_ONBOARDING_PROPOSAL_STALE";
  message: string;
  currentHead: WorkspaceInstructionPolicyHead | null;
};

export type WorkspaceInstructionPolicyOnboardingProposalConflictResponse = {
  code: "WORKSPACE_INSTRUCTION_POLICY_ONBOARDING_PROPOSAL_CONFLICT";
  message: string;
  existingProposalId: string;
  existingDraftRevisionId: string;
};
