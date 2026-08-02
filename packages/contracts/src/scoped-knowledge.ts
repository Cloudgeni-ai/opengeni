import { z } from "zod";

/** Tenant scope for normalized knowledge and source provenance. */
export const ScopedKnowledgeScopeKind = z.enum(["organization", "workspace", "personal"]);
export type ScopedKnowledgeScopeKind = z.infer<typeof ScopedKnowledgeScopeKind>;

export type ScopedKnowledgeScope =
  | { kind: "organization"; workspaceId: null; subjectId: null }
  | { kind: "workspace"; workspaceId: string; subjectId: null }
  | { kind: "personal"; workspaceId: string | null; subjectId: string };

export const ScopedKnowledgeActorKind = z.enum(["human", "service"]);
export type ScopedKnowledgeActorKind = z.infer<typeof ScopedKnowledgeActorKind>;

/**
 * Immutable write provenance. A service actor may retain a causal human, but
 * the service identity never substitutes for that human on personal reads.
 */
export type ScopedKnowledgeActor = {
  kind: ScopedKnowledgeActorKind;
  subjectId: string;
  initiatingHumanSubjectId: string | null;
};

export const KnowledgeLifecycleState = z.enum(["active", "deleted", "revoked"]);
export type KnowledgeLifecycleState = z.infer<typeof KnowledgeLifecycleState>;

export const KnowledgeLifecycleEventType = z.enum([
  "deleted",
  "revoked",
  "restored",
  "acl_changed",
  "sync_succeeded",
  "sync_failed",
  "object_version_added",
]);
export type KnowledgeLifecycleEventType = z.infer<typeof KnowledgeLifecycleEventType>;

export const KnowledgeSyncRunState = z.enum(["started", "succeeded", "failed"]);
export type KnowledgeSyncRunState = z.infer<typeof KnowledgeSyncRunState>;

export const KnowledgeClaimOrigin = z.enum(["explicit", "inferred"]);
export type KnowledgeClaimOrigin = z.infer<typeof KnowledgeClaimOrigin>;

export const KnowledgeClaimRelationType = z.enum(["supersedes", "conflicts_with"]);
export type KnowledgeClaimRelationType = z.infer<typeof KnowledgeClaimRelationType>;

export const KnowledgeClaimEvidencePolarity = z.enum(["supports", "contradicts"]);
export type KnowledgeClaimEvidencePolarity = z.infer<typeof KnowledgeClaimEvidencePolarity>;

export const KnowledgeClaimReviewState = z.enum(["proposed", "approved", "rejected", "revoked"]);
export type KnowledgeClaimReviewState = z.infer<typeof KnowledgeClaimReviewState>;

export const KnowledgeFactObjectKind = z.enum([
  "entity",
  "text",
  "number",
  "boolean",
  "json",
  "timestamp",
]);
export type KnowledgeFactObjectKind = z.infer<typeof KnowledgeFactObjectKind>;

export const KnowledgeChangeProposalTargetKind = z.enum(["instruction_policy", "preference"]);
export type KnowledgeChangeProposalTargetKind = z.infer<typeof KnowledgeChangeProposalTargetKind>;

export type KnowledgeProviderRecord = {
  id: string;
  accountId: string;
  scope: ScopedKnowledgeScope;
  providerKey: string;
  externalTenantId: string;
  lifecycleState: KnowledgeLifecycleState;
  lifecycleGeneration: number;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeSourceRecord = {
  id: string;
  accountId: string;
  providerId: string;
  scope: ScopedKnowledgeScope;
  externalSourceId: string;
  sourceKind: string;
  sourceUri: string | null;
  currentAclGeneration: number | null;
  syncGeneration: number;
  syncCursor: string | null;
  lifecycleState: KnowledgeLifecycleState;
  lifecycleGeneration: number;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeSourceAclVersionRecord = {
  id: string;
  accountId: string;
  sourceId: string;
  generation: number;
  aclVersion: string | null;
  aclHash: string;
  audience: ScopedKnowledgeScope;
  agentAccess: boolean;
  createdAt: string;
};

export type KnowledgeSyncRunRecord = {
  id: string;
  accountId: string;
  sourceId: string;
  operationId: string;
  state: KnowledgeSyncRunState;
  inputSyncGeneration: number;
  inputLifecycleGeneration: number;
  inputCursor: string | null;
  outputCursor: string | null;
  watermark: string | null;
  metadata: Record<string, unknown>;
  errorCode: string | null;
  startedAt: string;
  completedAt: string | null;
};

export type KnowledgeSourceObjectRecord = {
  id: string;
  accountId: string;
  sourceId: string;
  scope: ScopedKnowledgeScope;
  externalObjectId: string;
  documentId: string | null;
  lifecycleState: KnowledgeLifecycleState;
  lifecycleGeneration: number;
  versionGeneration: number;
  currentVersionId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeDocumentVersionRecord = {
  id: string;
  accountId: string;
  sourceId: string;
  objectId: string;
  scope: ScopedKnowledgeScope;
  versionGeneration: number;
  externalVersionId: string;
  contentSha256: string;
  ingestionKey: string;
  aclVersionId: string;
  aclGeneration: number;
  documentId: string | null;
  fileId: string | null;
  createdAt: string;
};

export type KnowledgeEntityRecord = {
  id: string;
  accountId: string;
  scope: ScopedKnowledgeScope;
  entityType: string;
  normalizedKey: string;
  displayName: string;
  createdAt: string;
};

export type KnowledgeFactRecord = {
  id: string;
  accountId: string;
  scope: ScopedKnowledgeScope;
  subjectEntityId: string;
  predicateKey: string;
  objectKind: KnowledgeFactObjectKind;
  objectEntityId: string | null;
  objectValue: unknown | null;
  objectHash: string;
  createdAt: string;
};

export type KnowledgeClaimRecord = {
  id: string;
  accountId: string;
  scope: ScopedKnowledgeScope;
  factId: string;
  origin: KnowledgeClaimOrigin;
  confidenceBps: number;
  effectiveAt: string;
  expiresAt: string | null;
  extractionMethod: string;
  modelProvider: string | null;
  modelName: string | null;
  modelVersion: string | null;
  createdAt: string;
};

export type EligibleKnowledgeClaim = {
  claim: KnowledgeClaimRecord;
  fact: KnowledgeFactRecord;
  reviewState: "approved";
  supportingEvidenceCount: number;
};

export type KnowledgeChangeProposalRecord = {
  id: string;
  accountId: string;
  scope: ScopedKnowledgeScope;
  targetKind: KnowledgeChangeProposalTargetKind;
  targetScope: string;
  targetKey: string | null;
  content: string;
  contentHash: string;
  claimId: string;
  evidenceId: string;
  status: "proposed";
  createdAt: string;
};
