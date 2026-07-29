export type PreferenceRegistryScope = "organization" | "workspace" | "user";
export type PreferenceRegistryStatus =
  | "proposed"
  | "active"
  | "inactive"
  | "rejected"
  | "superseded"
  | "expired";
export type PreferenceRegistryProvenanceSource =
  | "human"
  | "onboarding"
  | "knowledge_proposal"
  | "imported_document"
  | "slack"
  | "meeting_transcript"
  | "call_transcript";
export type PreferenceRegistryTrust =
  | "untrusted_proposal"
  | "personal"
  | "workspace_managed"
  | "organization_managed";
export type PreferenceRegistryConflictStrategy = "override" | "merge" | "reject" | "inform";

export function normalizePreferenceRegistryStableKey(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, "-").replace(/-+/g, "-");
}

export type PreferenceRegistryScopeTarget = {
  scope: PreferenceRegistryScope;
  workspaceId: string | null;
  subjectId: string | null;
};

export type PreferenceRegistryPrecedence = {
  tier: PreferenceRegistryScope;
  rank: number;
  conflictStrategy: PreferenceRegistryConflictStrategy;
  conflictsWith: string[];
};

export type PreferenceRegistryRevisionSummary = {
  id: string;
  preferenceId: string;
  revision: number;
  contentHash: string;
  title: string;
  description: string;
  precedence: PreferenceRegistryPrecedence;
  provenance: {
    source: PreferenceRegistryProvenanceSource;
    sourceId: string | null;
    trust: PreferenceRegistryTrust;
  };
  expiresAt: string | null;
  correctsRevisionId: string | null;
  createdBySubjectId: string;
  createdAt: string;
};

export type PreferenceRegistryDescriptorProvenance = {
  source: PreferenceRegistryProvenanceSource;
  sourceIdHash: string | null;
  trust: PreferenceRegistryTrust;
};

export type PreferenceRegistryRecord = {
  id: string;
  accountId: string;
  stableKey: string;
  target: PreferenceRegistryScopeTarget;
  status: PreferenceRegistryStatus;
  scopeVersion: number;
  activationVersion: number;
  activeRevision: PreferenceRegistryRevisionSummary | null;
  supersededByPreferenceId: string | null;
  createdBySubjectId: string;
  createdAt: string;
  updatedAt: string;
};

export type PreferenceRegistryEvent = {
  id: string;
  accountId: string;
  preferenceId: string;
  type:
    | "proposal_created"
    | "activated"
    | "corrected"
    | "rejected"
    | "deactivated"
    | "superseded"
    | "scope_changed";
  version: number;
  oldRevisionId: string | null;
  newRevisionId: string | null;
  oldTarget: PreferenceRegistryScopeTarget | null;
  newTarget: PreferenceRegistryScopeTarget | null;
  relatedPreferenceId: string | null;
  actorSubjectId: string;
  reason: string;
  createdAt: string;
};

export type PreferenceRegistryDescriptor = {
  id: string;
  stableKey: string;
  title: string;
  description: string;
  scope: PreferenceRegistryScope;
  activeVersion: number;
  revisionId: string;
  contentHash: string;
  precedence: PreferenceRegistryPrecedence;
  provenance: PreferenceRegistryDescriptorProvenance;
  expiresAt: string | null;
  retrievalHandle: string;
};

export type PreferenceRegistrySnapshot = {
  id: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
  initiatingHumanSubjectId: string;
  descriptorHash: string;
  descriptors: PreferenceRegistryDescriptor[];
  truncated: boolean;
  createdAt: string;
};

export type PreferenceRegistryFullContent = {
  descriptor: PreferenceRegistryDescriptor;
  content: string;
};

export type CreatePreferenceRegistryProposalRequest = {
  stableKey: string;
  scope: PreferenceRegistryScope;
  title: string;
  description: string;
  content: string;
  precedenceRank?: number;
  conflictStrategy?: PreferenceRegistryConflictStrategy;
  conflictsWith?: string[];
  expiresAt?: string | null;
  provenanceSource?: PreferenceRegistryProvenanceSource;
  provenanceSourceId?: string | null;
};

export type ActivatePreferenceRegistryRevisionRequest = {
  revisionId: string;
  expectedCurrentRevisionId: string | null;
  reason: string;
};

export type CorrectPreferenceRegistryRequest = {
  expectedCurrentRevisionId: string;
  title: string;
  description: string;
  content: string;
  precedenceRank?: number;
  conflictStrategy?: PreferenceRegistryConflictStrategy;
  conflictsWith?: string[];
  expiresAt?: string | null;
  reason: string;
};

export type DeactivatePreferenceRegistryRequest = {
  expectedCurrentRevisionId: string;
  reason: string;
};

export type ChangePreferenceRegistryScopeRequest = {
  scope: PreferenceRegistryScope;
  expectedScopeVersion: number;
  reason: string;
};

export type SupersedePreferenceRegistryRequest = {
  replacementPreferenceId: string;
  expectedCurrentRevisionId: string;
  reason: string;
};

export type RejectPreferenceRegistryProposalRequest = { revisionId: string; reason: string };
export type PreferenceRegistryListOptions = {
  scope?: PreferenceRegistryScope;
  status?: PreferenceRegistryStatus;
  limit?: number;
};
export type PreferenceRegistryListResponse = { preferences: PreferenceRegistryRecord[] };
export type PreferenceRegistryDetailResponse = {
  preference: PreferenceRegistryRecord;
  revisions: PreferenceRegistryRevisionSummary[];
  events: PreferenceRegistryEvent[];
};
export type PreferenceRegistryMutationResponse = {
  preference: PreferenceRegistryRecord;
  event: PreferenceRegistryEvent;
};
