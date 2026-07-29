import { z } from "zod";

export const PREFERENCE_REGISTRY_CONTENT_MAX_CHARS = 262_144;
export const PREFERENCE_REGISTRY_DESCRIPTOR_DESCRIPTION_MAX_CHARS = 240;
export const PREFERENCE_REGISTRY_DESCRIPTOR_MAX_COUNT = 64;
export const PREFERENCE_REGISTRY_DESCRIPTOR_MAX_UTF8_BYTES = 16_384;
export const PREFERENCE_REGISTRY_REASON_MAX_CHARS = 4_096;
export const PREFERENCE_REGISTRY_SOURCE_ID_MAX_CHARS = 512;
export const PREFERENCE_REGISTRY_STABLE_KEY_MAX_CHARS = 96;
export const PREFERENCE_REGISTRY_TITLE_MAX_CHARS = 120;

export const PreferenceRegistryScope = z.enum(["organization", "workspace", "user"]);
export type PreferenceRegistryScope = z.infer<typeof PreferenceRegistryScope>;

export const PreferenceRegistryStatus = z.enum([
  "proposed",
  "active",
  "inactive",
  "rejected",
  "superseded",
  "expired",
]);
export type PreferenceRegistryStatus = z.infer<typeof PreferenceRegistryStatus>;

export const PreferenceRegistryProvenanceSource = z.enum([
  "human",
  "onboarding",
  "knowledge_proposal",
  "imported_document",
  "slack",
  "meeting_transcript",
  "call_transcript",
]);
export type PreferenceRegistryProvenanceSource = z.infer<typeof PreferenceRegistryProvenanceSource>;

export const PreferenceRegistryTrust = z.enum([
  "untrusted_proposal",
  "personal",
  "workspace_managed",
  "organization_managed",
]);
export type PreferenceRegistryTrust = z.infer<typeof PreferenceRegistryTrust>;

export const PreferenceRegistryConflictStrategy = z.enum(["override", "merge", "reject", "inform"]);
export type PreferenceRegistryConflictStrategy = z.infer<typeof PreferenceRegistryConflictStrategy>;

export const PreferenceRegistryEventType = z.enum([
  "proposal_created",
  "activated",
  "corrected",
  "rejected",
  "deactivated",
  "superseded",
  "scope_changed",
]);
export type PreferenceRegistryEventType = z.infer<typeof PreferenceRegistryEventType>;

export const PreferenceRegistryStableKey = z
  .string()
  .min(1)
  .max(PREFERENCE_REGISTRY_STABLE_KEY_MAX_CHARS)
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/);
export type PreferenceRegistryStableKey = z.infer<typeof PreferenceRegistryStableKey>;

export function normalizePreferenceRegistryStableKey(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, "-").replace(/-+/g, "-");
}

const RequestStableKey = z
  .string()
  .transform(normalizePreferenceRegistryStableKey)
  .pipe(PreferenceRegistryStableKey);

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const boundedActor = z.string().trim().min(1).max(1_024);
const boundedReason = z.string().trim().min(1).max(PREFERENCE_REGISTRY_REASON_MAX_CHARS);
const descriptorText = z.string().min(1).max(PREFERENCE_REGISTRY_DESCRIPTOR_DESCRIPTION_MAX_CHARS);

export const PreferenceRegistryScopeTarget = z
  .object({
    scope: PreferenceRegistryScope,
    workspaceId: z.string().uuid().nullable(),
    subjectId: z.string().min(1).max(1_024).nullable(),
  })
  .superRefine((value, context) => {
    if (
      value.scope === "organization" &&
      (value.workspaceId !== null || value.subjectId !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "organization scope has no workspace or subject",
      });
    }
    if (value.scope === "workspace" && (value.workspaceId === null || value.subjectId !== null)) {
      context.addIssue({ code: "custom", message: "workspace scope requires only a workspace" });
    }
    if (value.scope === "user" && (value.workspaceId !== null || value.subjectId === null)) {
      context.addIssue({ code: "custom", message: "user scope requires only a subject" });
    }
  });
export type PreferenceRegistryScopeTarget = z.infer<typeof PreferenceRegistryScopeTarget>;

export const PreferenceRegistryPrecedence = z.object({
  tier: PreferenceRegistryScope,
  rank: z.number().int().min(-1_000).max(1_000),
  conflictStrategy: PreferenceRegistryConflictStrategy,
  conflictsWith: z.array(PreferenceRegistryStableKey).max(32),
});
export type PreferenceRegistryPrecedence = z.infer<typeof PreferenceRegistryPrecedence>;

export const PreferenceRegistryProvenance = z.object({
  source: PreferenceRegistryProvenanceSource,
  sourceId: z.string().min(1).max(PREFERENCE_REGISTRY_SOURCE_ID_MAX_CHARS).nullable(),
  trust: PreferenceRegistryTrust,
});
export type PreferenceRegistryProvenance = z.infer<typeof PreferenceRegistryProvenance>;

export const PreferenceRegistryDescriptorProvenance = z.object({
  source: PreferenceRegistryProvenanceSource,
  sourceIdHash: hash.nullable(),
  trust: PreferenceRegistryTrust,
});
export type PreferenceRegistryDescriptorProvenance = z.infer<
  typeof PreferenceRegistryDescriptorProvenance
>;

export const PreferenceRegistryRevisionSummary = z.object({
  id: z.string().uuid(),
  preferenceId: z.string().uuid(),
  revision: z.number().int().positive(),
  contentHash: hash,
  title: z.string().min(1).max(PREFERENCE_REGISTRY_TITLE_MAX_CHARS),
  description: descriptorText,
  precedence: PreferenceRegistryPrecedence,
  provenance: PreferenceRegistryProvenance,
  expiresAt: z.string().datetime().nullable(),
  correctsRevisionId: z.string().uuid().nullable(),
  createdBySubjectId: boundedActor,
  createdAt: z.string().datetime(),
});
export type PreferenceRegistryRevisionSummary = z.infer<typeof PreferenceRegistryRevisionSummary>;

export const PreferenceRegistryRecord = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  stableKey: PreferenceRegistryStableKey,
  target: PreferenceRegistryScopeTarget,
  status: PreferenceRegistryStatus,
  scopeVersion: z.number().int().positive(),
  activationVersion: z.number().int().nonnegative(),
  activeRevision: PreferenceRegistryRevisionSummary.nullable(),
  supersededByPreferenceId: z.string().uuid().nullable(),
  createdBySubjectId: boundedActor,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type PreferenceRegistryRecord = z.infer<typeof PreferenceRegistryRecord>;

export const PreferenceRegistryEvent = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  preferenceId: z.string().uuid(),
  type: PreferenceRegistryEventType,
  version: z.number().int().positive(),
  oldRevisionId: z.string().uuid().nullable(),
  newRevisionId: z.string().uuid().nullable(),
  oldTarget: PreferenceRegistryScopeTarget.nullable(),
  newTarget: PreferenceRegistryScopeTarget.nullable(),
  relatedPreferenceId: z.string().uuid().nullable(),
  actorSubjectId: boundedActor,
  reason: boundedReason,
  createdAt: z.string().datetime(),
});
export type PreferenceRegistryEvent = z.infer<typeof PreferenceRegistryEvent>;

export const PreferenceRegistryDescriptor = z.object({
  id: z.string().uuid(),
  stableKey: PreferenceRegistryStableKey,
  title: z.string().min(1).max(PREFERENCE_REGISTRY_TITLE_MAX_CHARS),
  description: descriptorText,
  scope: PreferenceRegistryScope,
  activeVersion: z.number().int().positive(),
  revisionId: z.string().uuid(),
  contentHash: hash,
  precedence: PreferenceRegistryPrecedence,
  provenance: PreferenceRegistryDescriptorProvenance,
  expiresAt: z.string().datetime().nullable(),
  retrievalHandle: z.string().min(1).max(512),
});
export type PreferenceRegistryDescriptor = z.infer<typeof PreferenceRegistryDescriptor>;

export const PreferenceRegistrySnapshot = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  sessionId: z.string().uuid(),
  turnId: z.string().uuid(),
  attemptId: z.string().uuid(),
  executionGeneration: z.number().int().positive(),
  initiatingHumanSubjectId: boundedActor,
  descriptorHash: hash,
  descriptors: z.array(PreferenceRegistryDescriptor).max(PREFERENCE_REGISTRY_DESCRIPTOR_MAX_COUNT),
  truncated: z.boolean(),
  createdAt: z.string().datetime(),
});
export type PreferenceRegistrySnapshot = z.infer<typeof PreferenceRegistrySnapshot>;

export const PreferenceRegistryFullContent = z.object({
  descriptor: PreferenceRegistryDescriptor,
  content: z.string().min(1).max(PREFERENCE_REGISTRY_CONTENT_MAX_CHARS),
});
export type PreferenceRegistryFullContent = z.infer<typeof PreferenceRegistryFullContent>;

const revisionInput = {
  title: z.string().trim().min(1).max(PREFERENCE_REGISTRY_TITLE_MAX_CHARS),
  description: z.string().trim().min(1).max(PREFERENCE_REGISTRY_DESCRIPTOR_DESCRIPTION_MAX_CHARS),
  content: z
    .string()
    .min(1)
    .max(PREFERENCE_REGISTRY_CONTENT_MAX_CHARS)
    .refine((value) => value.trim().length > 0, "preference content must not be blank"),
  precedenceRank: z.number().int().min(-1_000).max(1_000).default(0),
  conflictStrategy: PreferenceRegistryConflictStrategy.default("override"),
  conflictsWith: z.array(RequestStableKey).max(32).default([]),
  expiresAt: z.string().datetime({ offset: true }).nullable().default(null),
};

const importedSources = new Set<PreferenceRegistryProvenanceSource>([
  "knowledge_proposal",
  "imported_document",
  "slack",
  "meeting_transcript",
  "call_transcript",
]);

export const CreatePreferenceRegistryProposalRequest = z
  .object({
    stableKey: RequestStableKey,
    scope: PreferenceRegistryScope,
    ...revisionInput,
    provenanceSource: PreferenceRegistryProvenanceSource.default("human"),
    provenanceSourceId: z
      .string()
      .min(1)
      .max(PREFERENCE_REGISTRY_SOURCE_ID_MAX_CHARS)
      .nullable()
      .default(null),
  })
  .superRefine((value, context) => {
    if (importedSources.has(value.provenanceSource) && value.provenanceSourceId === null) {
      context.addIssue({
        code: "custom",
        path: ["provenanceSourceId"],
        message: "imported preference proposals require a provenance source id",
      });
    }
  });
export type CreatePreferenceRegistryProposalRequest = z.infer<
  typeof CreatePreferenceRegistryProposalRequest
>;

export const ActivatePreferenceRegistryRevisionRequest = z.object({
  revisionId: z.string().uuid(),
  expectedCurrentRevisionId: z.string().uuid().nullable(),
  expectedScopeVersion: z.number().int().positive(),
  reason: boundedReason,
});
export type ActivatePreferenceRegistryRevisionRequest = z.infer<
  typeof ActivatePreferenceRegistryRevisionRequest
>;

export const CorrectPreferenceRegistryRequest = z.object({
  expectedCurrentRevisionId: z.string().uuid(),
  expectedScopeVersion: z.number().int().positive(),
  ...revisionInput,
  reason: boundedReason,
});
export type CorrectPreferenceRegistryRequest = z.infer<typeof CorrectPreferenceRegistryRequest>;

export const DeactivatePreferenceRegistryRequest = z.object({
  expectedCurrentRevisionId: z.string().uuid(),
  expectedScopeVersion: z.number().int().positive(),
  reason: boundedReason,
});
export type DeactivatePreferenceRegistryRequest = z.infer<
  typeof DeactivatePreferenceRegistryRequest
>;

export const ChangePreferenceRegistryScopeRequest = z.object({
  scope: PreferenceRegistryScope,
  expectedScopeVersion: z.number().int().positive(),
  reason: boundedReason,
});
export type ChangePreferenceRegistryScopeRequest = z.infer<
  typeof ChangePreferenceRegistryScopeRequest
>;

export const SupersedePreferenceRegistryRequest = z.object({
  replacementPreferenceId: z.string().uuid(),
  expectedCurrentRevisionId: z.string().uuid(),
  expectedScopeVersion: z.number().int().positive(),
  reason: boundedReason,
});
export type SupersedePreferenceRegistryRequest = z.infer<typeof SupersedePreferenceRegistryRequest>;

export const RejectPreferenceRegistryProposalRequest = z.object({
  revisionId: z.string().uuid(),
  expectedScopeVersion: z.number().int().positive(),
  reason: boundedReason,
});
export type RejectPreferenceRegistryProposalRequest = z.infer<
  typeof RejectPreferenceRegistryProposalRequest
>;

export const PreferenceRegistryListQuery = z.object({
  scope: PreferenceRegistryScope.optional(),
  status: PreferenceRegistryStatus.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type PreferenceRegistryListQuery = z.infer<typeof PreferenceRegistryListQuery>;

export const PreferenceRegistryListResponse = z.object({
  preferences: z.array(PreferenceRegistryRecord),
});
export type PreferenceRegistryListResponse = z.infer<typeof PreferenceRegistryListResponse>;

export const PreferenceRegistryDetailResponse = z.object({
  preference: PreferenceRegistryRecord,
  revisions: z.array(PreferenceRegistryRevisionSummary),
  events: z.array(PreferenceRegistryEvent),
});
export type PreferenceRegistryDetailResponse = z.infer<typeof PreferenceRegistryDetailResponse>;

export const PreferenceRegistryMutationResponse = z.object({
  preference: PreferenceRegistryRecord,
  event: PreferenceRegistryEvent,
});
export type PreferenceRegistryMutationResponse = z.infer<typeof PreferenceRegistryMutationResponse>;

export const PreferenceRegistryConflictResponse = z.object({
  code: z.literal("PREFERENCE_REGISTRY_CONFLICT"),
  message: z.string(),
  currentRevisionId: z.string().uuid().nullable(),
  scopeVersion: z.number().int().positive().nullable(),
});
export type PreferenceRegistryConflictResponse = z.infer<typeof PreferenceRegistryConflictResponse>;

export const PreferenceRegistryFullContentRequest = z.object({
  retrievalHandle: z.string().min(1).max(512),
});
export type PreferenceRegistryFullContentRequest = z.infer<
  typeof PreferenceRegistryFullContentRequest
>;
