export type WorkspaceLearningMode = "off" | "suggest" | "automatic";
export type WorkspaceLearningOverrideMode = WorkspaceLearningMode | "inherit";

export type WorkspaceLearningSourceOverrideInput = {
  kind: string;
  id: string;
  mode: WorkspaceLearningOverrideMode;
};

export type WorkspaceLearningSourceOverride = Omit<WorkspaceLearningSourceOverrideInput, "mode"> & {
  mode: WorkspaceLearningMode;
};

export type WorkspaceLearningPolicyRevisionIdentity = {
  id: string;
  revision: number;
  policyHash: string;
};

export type WorkspaceLearningPolicyRevision = WorkspaceLearningPolicyRevisionIdentity & {
  operationId: string;
  accountId: string;
  workspaceId: string;
  workspaceMode: WorkspaceLearningMode;
  sourceOverrides: WorkspaceLearningSourceOverride[];
  supersedesRevisionId: string | null;
  createdBySubjectId: string;
  createdAt: string;
};

export type WorkspaceLearningPolicyHead = Omit<WorkspaceLearningPolicyRevisionIdentity, "id"> & {
  accountId: string;
  workspaceId: string;
  revisionId: string;
  activationVersion: number;
  activatedAt: string;
};

export type WorkspaceLearningPolicyEvent = {
  id: string;
  operationId: string;
  accountId: string;
  workspaceId: string;
  type: "activate" | "rollback";
  activationVersion: number;
  oldRevision: WorkspaceLearningPolicyRevisionIdentity | null;
  newRevision: WorkspaceLearningPolicyRevisionIdentity;
  actorSubjectId: string;
  reason: string;
  createdAt: string;
};

export type GovernedLearningDecisionReceipt = {
  id: string;
  sourceKind: "scoped-knowledge-evidence" | "task-note";
  sourceId: string;
  proposalId: string;
  policySnapshotId: string;
  policyRevisionId: string | null;
  policyActivationVersion: number;
  effectiveMode: WorkspaceLearningMode;
  confidenceBps: number;
  conflictCount: number;
  outcome: "off" | "suggest" | "automatic" | "confidence" | "conflict" | "stale" | "revoked";
  reasons: string[];
  automaticEligible: boolean;
  createdAt: string;
};

export type GovernedLearningActivationReceipt = {
  id: string;
  decisionReceiptId: string;
  initiatingHumanSubjectId: string;
  serviceActorSubjectId: string;
  sourceKind: "scoped-knowledge-evidence" | "task-note";
  sourceId: string;
  destination: "instruction_policy" | "preference";
  destinationRevisionId: string;
  destinationOldRevisionId: string | null;
  destinationOldContentHash: string | null;
  destinationOldVersion: number;
  destinationNewContentHash: string;
  destinationNewVersion: number;
  effectiveAt: string;
  createdAt: string;
};

export type GovernedLearningActivationUndoReceipt = {
  id: string;
  activationReceiptId: string;
  initiatingHumanSubjectId: string;
  serviceActorSubjectId: string;
  destination: "instruction_policy" | "preference";
  destinationActivatedRevisionId: string;
  destinationRestoredRevisionId: string | null;
  destinationOldVersion: number;
  destinationNewVersion: number;
  effectiveAt: string;
  createdAt: string;
};

export type WorkspaceLearningHistoryResponse = {
  head: WorkspaceLearningPolicyHead | null;
  revisions: WorkspaceLearningPolicyRevision[];
  policyEvents: WorkspaceLearningPolicyEvent[];
  decisions: GovernedLearningDecisionReceipt[];
  activations: GovernedLearningActivationReceipt[];
  undos: GovernedLearningActivationUndoReceipt[];
  truncated: boolean;
  effectiveBoundary: "next_accepted_attempt";
};

export type CreateWorkspaceLearningPolicyRevisionRequest = {
  operationId?: string;
  workspaceMode: WorkspaceLearningMode;
  sourceOverrides?: WorkspaceLearningSourceOverrideInput[];
  supersedesRevisionId?: string | null;
};

export type ActivateWorkspaceLearningPolicyRevisionRequest = {
  operationId?: string;
  expectedCurrentRevisionId: string | null;
  expectedActivationVersion: number;
  reason: string;
};

export type RollbackWorkspaceLearningPolicyRevisionRequest =
  ActivateWorkspaceLearningPolicyRevisionRequest & {
    targetRevisionId: string;
    expectedCurrentRevisionId: string;
  };

export type WorkspaceLearningPolicyMutationResponse = {
  head: WorkspaceLearningPolicyHead;
  event: WorkspaceLearningPolicyEvent;
};

export type WorkspaceLearningHistoryOptions = { limit?: number };
