import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";

export const PREFERENCE_REGISTRY_CONTENT_MAX_CHARS = 262_144;
export const PREFERENCE_REGISTRY_DESCRIPTOR_DESCRIPTION_MAX_CHARS = 1024;
export const PREFERENCE_REGISTRY_DESCRIPTOR_MAX_COUNT = 64;
export const PREFERENCE_REGISTRY_DESCRIPTOR_MAX_UTF8_BYTES = 16_384;
export const PREFERENCE_REGISTRY_REASON_MAX_CHARS = 4_096;
export const PREFERENCE_REGISTRY_SOURCE_ID_MAX_CHARS = 512;
export const PREFERENCE_REGISTRY_STABLE_KEY_MAX_CHARS = 96;
export const PREFERENCE_REGISTRY_TITLE_MAX_CHARS = 120;

export const PreferenceRegistryScope = /* @__PURE__ */ defineSchema(() =>
  z.enum(["organization", "workspace", "user"]),
);
export type PreferenceRegistryScope = z.infer<typeof PreferenceRegistryScope>;

export const PreferenceRegistryStatus = /* @__PURE__ */ defineSchema(() =>
  z.enum(["proposed", "active", "inactive", "rejected", "superseded", "expired"]),
);
export type PreferenceRegistryStatus = z.infer<typeof PreferenceRegistryStatus>;

export const PreferenceRegistryProvenanceSource = /* @__PURE__ */ defineSchema(() =>
  z.enum([
    "human",
    "onboarding",
    "knowledge_proposal",
    "imported_document",
    "slack",
    "meeting_transcript",
    "call_transcript",
    "agent",
    "portable_skill",
  ]),
);
export type PreferenceRegistryProvenanceSource = z.infer<typeof PreferenceRegistryProvenanceSource>;

export const PreferenceRegistryTrust = /* @__PURE__ */ defineSchema(() =>
  z.enum(["untrusted_proposal", "personal", "workspace_managed", "organization_managed"]),
);
export type PreferenceRegistryTrust = z.infer<typeof PreferenceRegistryTrust>;

export const PreferenceRegistryConflictStrategy = /* @__PURE__ */ defineSchema(() =>
  z.enum(["override", "merge", "reject", "inform"]),
);
export type PreferenceRegistryConflictStrategy = z.infer<typeof PreferenceRegistryConflictStrategy>;

export const PreferenceRegistryEventType = /* @__PURE__ */ defineSchema(() =>
  z.enum([
    "proposal_created",
    "activated",
    "corrected",
    "rejected",
    "deactivated",
    "superseded",
    "scope_changed",
  ]),
);
export type PreferenceRegistryEventType = z.infer<typeof PreferenceRegistryEventType>;

export const PreferenceRegistryStableKey = /* @__PURE__ */ defineSchema(() =>
  primitives.nonEmptyString
    .max(PREFERENCE_REGISTRY_STABLE_KEY_MAX_CHARS)
    .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/),
);
export type PreferenceRegistryStableKey = z.infer<typeof PreferenceRegistryStableKey>;

export function normalizePreferenceRegistryStableKey(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, "-").replace(/-+/g, "-");
}

const RequestStableKey = /* @__PURE__ */ defineSchema(() =>
  primitives.string
    .transform(normalizePreferenceRegistryStableKey)
    .pipe(PreferenceRegistryStableKey),
);

const hash = /* @__PURE__ */ defineSchema(() => primitives.string.regex(/^[0-9a-f]{64}$/));
const boundedActor = /* @__PURE__ */ defineSchema(() => primitives.string.trim().min(1).max(1_024));
const boundedReason = /* @__PURE__ */ defineSchema(() =>
  primitives.string.trim().min(1).max(PREFERENCE_REGISTRY_REASON_MAX_CHARS),
);
const descriptorText = /* @__PURE__ */ defineSchema(() =>
  primitives.nonEmptyString.max(PREFERENCE_REGISTRY_DESCRIPTOR_DESCRIPTION_MAX_CHARS),
);

export const PreferenceRegistryScopeTarget = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      scope: PreferenceRegistryScope,
      workspaceId: primitives.nullableUuid,
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
    }),
);
export type PreferenceRegistryScopeTarget = z.infer<typeof PreferenceRegistryScopeTarget>;

export const PreferenceRegistryPrecedence = /* @__PURE__ */ defineSchema(() =>
  z.object({
    tier: PreferenceRegistryScope,
    rank: z.number().int().min(-1_000).max(1_000),
    conflictStrategy: PreferenceRegistryConflictStrategy,
    conflictsWith: z.array(PreferenceRegistryStableKey).max(32),
  }),
);
export type PreferenceRegistryPrecedence = z.infer<typeof PreferenceRegistryPrecedence>;

export const PreferenceRegistryProvenance = /* @__PURE__ */ defineSchema(() =>
  z.object({
    source: PreferenceRegistryProvenanceSource,
    sourceId: primitives.nonEmptyString.max(PREFERENCE_REGISTRY_SOURCE_ID_MAX_CHARS).nullable(),
    trust: PreferenceRegistryTrust,
  }),
);
export type PreferenceRegistryProvenance = z.infer<typeof PreferenceRegistryProvenance>;

export const PreferenceRegistryDescriptorProvenance = /* @__PURE__ */ defineSchema(() =>
  z.object({
    source: PreferenceRegistryProvenanceSource,
    sourceIdHash: hash.nullable(),
    trust: PreferenceRegistryTrust,
  }),
);
export type PreferenceRegistryDescriptorProvenance = z.infer<
  typeof PreferenceRegistryDescriptorProvenance
>;

export const PreferenceRegistryRevisionSummary = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid,
    preferenceId: primitives.uuid,
    revision: primitives.positiveInteger,
    contentHash: hash,
    title: primitives.nonEmptyString.max(PREFERENCE_REGISTRY_TITLE_MAX_CHARS),
    description: descriptorText,
    precedence: PreferenceRegistryPrecedence,
    provenance: PreferenceRegistryProvenance,
    expiresAt: z.string().datetime().nullable(),
    correctsRevisionId: primitives.nullableUuid,
    createdBySubjectId: boundedActor,
    createdAt: primitives.dateTime,
  }),
);
export type PreferenceRegistryRevisionSummary = z.infer<typeof PreferenceRegistryRevisionSummary>;

export const PreferenceRegistryRecord = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid,
    accountId: primitives.uuid,
    stableKey: PreferenceRegistryStableKey,
    target: PreferenceRegistryScopeTarget,
    status: PreferenceRegistryStatus,
    scopeVersion: primitives.positiveInteger,
    activationVersion: primitives.nonnegativeInteger,
    activeRevision: PreferenceRegistryRevisionSummary.nullable(),
    supersededByPreferenceId: primitives.nullableUuid,
    createdBySubjectId: boundedActor,
    createdAt: primitives.dateTime,
    updatedAt: primitives.dateTime,
  }),
);
export type PreferenceRegistryRecord = z.infer<typeof PreferenceRegistryRecord>;

export const PreferenceRegistryEvent = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid,
    accountId: primitives.uuid,
    preferenceId: primitives.uuid,
    type: PreferenceRegistryEventType,
    version: primitives.positiveInteger,
    oldRevisionId: primitives.nullableUuid,
    newRevisionId: primitives.nullableUuid,
    oldTarget: PreferenceRegistryScopeTarget.nullable(),
    newTarget: PreferenceRegistryScopeTarget.nullable(),
    relatedPreferenceId: primitives.nullableUuid,
    actorSubjectId: boundedActor,
    reason: boundedReason,
    createdAt: primitives.dateTime,
  }),
);
export type PreferenceRegistryEvent = z.infer<typeof PreferenceRegistryEvent>;

export const PreferenceRegistryActivationAuthority = /* @__PURE__ */ defineSchema(() =>
  z.enum(["human_confirmed", "automatic"]),
);
export type PreferenceRegistryActivationAuthority = z.infer<
  typeof PreferenceRegistryActivationAuthority
>;

export const PreferenceRegistryDescriptor = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid,
    stableKey: PreferenceRegistryStableKey,
    title: primitives.nonEmptyString.max(PREFERENCE_REGISTRY_TITLE_MAX_CHARS),
    description: descriptorText,
    scope: PreferenceRegistryScope,
    activeVersion: primitives.positiveInteger,
    revisionId: primitives.uuid,
    contentHash: hash,
    precedence: PreferenceRegistryPrecedence,
    provenance: PreferenceRegistryDescriptorProvenance,
    // How the active revision became active, derived from the governed-learning
    // activation receipt rather than stored on the revision. `provenance.trust`
    // stays the frozen creation-time fact - a revision proposed by an agent is
    // `untrusted_proposal` forever, which is correct and immutable - while this
    // says whether a human explicitly confirmed the activation or policy
    // activated it automatically. Null when the revision became active outside
    // governed learning, so no receipt describes it.
    // Defaulted, not merely nullable: snapshots written before this field
    // existed are immutable and their stored JSON simply has no answer. Parsing
    // those as null is the truthful reading, and it keeps their pinned
    // descriptor hash valid because the stored text is untouched.
    activationAuthority: PreferenceRegistryActivationAuthority.nullable().default(null),
    expiresAt: z.string().datetime().nullable(),
    retrievalHandle: z.string().min(1).max(512),
  }),
);
export type PreferenceRegistryDescriptor = z.infer<typeof PreferenceRegistryDescriptor>;

export const PreferenceRegistrySnapshot = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid,
    workspaceId: primitives.uuid,
    sessionId: primitives.uuid,
    turnId: primitives.uuid,
    attemptId: primitives.uuid,
    executionGeneration: primitives.positiveInteger,
    initiatingHumanSubjectId: boundedActor,
    descriptorHash: hash,
    descriptors: z
      .array(PreferenceRegistryDescriptor)
      .max(PREFERENCE_REGISTRY_DESCRIPTOR_MAX_COUNT),
    truncated: primitives.boolean,
    createdAt: primitives.dateTime,
  }),
);
export type PreferenceRegistrySnapshot = z.infer<typeof PreferenceRegistrySnapshot>;

export const PreferenceRegistryFullContent = /* @__PURE__ */ defineSchema(() =>
  z.object({
    descriptor: PreferenceRegistryDescriptor,
    content: primitives.nonEmptyString.max(PREFERENCE_REGISTRY_CONTENT_MAX_CHARS),
  }),
);
export type PreferenceRegistryFullContent = z.infer<typeof PreferenceRegistryFullContent>;

const revisionInput = {
  title: primitives.string.trim().min(1).max(PREFERENCE_REGISTRY_TITLE_MAX_CHARS),
  description: primitives.string
    .trim()
    .min(1)
    .max(PREFERENCE_REGISTRY_DESCRIPTOR_DESCRIPTION_MAX_CHARS),
  content: primitives.nonEmptyString
    .max(PREFERENCE_REGISTRY_CONTENT_MAX_CHARS)
    .refine((value) => value.trim().length > 0, "preference content must not be blank"),
  precedenceRank: z.number().int().min(-1_000).max(1_000).default(0),
  conflictStrategy: PreferenceRegistryConflictStrategy.default("override"),
  conflictsWith: z.array(RequestStableKey).max(32).default([]),
  expiresAt: primitives.string.datetime({ offset: true }).nullable().default(null),
};

const importedSources = new Set<PreferenceRegistryProvenanceSource>([
  "knowledge_proposal",
  "imported_document",
  "slack",
  "meeting_transcript",
  "call_transcript",
]);

export const CreatePreferenceRegistryProposalRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      stableKey: RequestStableKey,
      scope: PreferenceRegistryScope,
      ...revisionInput,
      provenanceSource: PreferenceRegistryProvenanceSource.default("human"),
      provenanceSourceId: primitives.nonEmptyString
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
    }),
);
export type CreatePreferenceRegistryProposalRequest = z.infer<
  typeof CreatePreferenceRegistryProposalRequest
>;

export const ActivatePreferenceRegistryRevisionRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    revisionId: primitives.uuid,
    expectedCurrentRevisionId: primitives.nullableUuid,
    expectedScopeVersion: primitives.positiveInteger,
    reason: boundedReason,
  }),
);
export type ActivatePreferenceRegistryRevisionRequest = z.infer<
  typeof ActivatePreferenceRegistryRevisionRequest
>;

export const CorrectPreferenceRegistryRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    expectedCurrentRevisionId: primitives.uuid,
    expectedScopeVersion: primitives.positiveInteger,
    ...revisionInput,
    reason: boundedReason,
  }),
);
export type CorrectPreferenceRegistryRequest = z.infer<typeof CorrectPreferenceRegistryRequest>;

export const DeactivatePreferenceRegistryRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    expectedCurrentRevisionId: primitives.uuid,
    expectedScopeVersion: primitives.positiveInteger,
    reason: boundedReason,
  }),
);
export type DeactivatePreferenceRegistryRequest = z.infer<
  typeof DeactivatePreferenceRegistryRequest
>;

export const ChangePreferenceRegistryScopeRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    scope: PreferenceRegistryScope,
    expectedScopeVersion: primitives.positiveInteger,
    reason: boundedReason,
  }),
);
export type ChangePreferenceRegistryScopeRequest = z.infer<
  typeof ChangePreferenceRegistryScopeRequest
>;

export const SupersedePreferenceRegistryRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    replacementPreferenceId: primitives.uuid,
    expectedCurrentRevisionId: primitives.uuid,
    expectedScopeVersion: primitives.positiveInteger,
    reason: boundedReason,
  }),
);
export type SupersedePreferenceRegistryRequest = z.infer<typeof SupersedePreferenceRegistryRequest>;

export const RejectPreferenceRegistryProposalRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    revisionId: primitives.uuid,
    expectedScopeVersion: primitives.positiveInteger,
    reason: boundedReason,
  }),
);
export type RejectPreferenceRegistryProposalRequest = z.infer<
  typeof RejectPreferenceRegistryProposalRequest
>;

export const PreferenceRegistryListQuery = /* @__PURE__ */ defineSchema(() =>
  z.object({
    scope: PreferenceRegistryScope.optional(),
    status: PreferenceRegistryStatus.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
);
export type PreferenceRegistryListQuery = z.infer<typeof PreferenceRegistryListQuery>;

export const PreferenceRegistryListResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    preferences: z.array(PreferenceRegistryRecord),
  }),
);
export type PreferenceRegistryListResponse = z.infer<typeof PreferenceRegistryListResponse>;

export const PreferenceRegistryDetailResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    preference: PreferenceRegistryRecord,
    revisions: z.array(PreferenceRegistryRevisionSummary),
    events: z.array(PreferenceRegistryEvent),
  }),
);
export type PreferenceRegistryDetailResponse = z.infer<typeof PreferenceRegistryDetailResponse>;

export const PreferenceRegistryMutationResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    preference: PreferenceRegistryRecord,
    event: PreferenceRegistryEvent,
  }),
);
export type PreferenceRegistryMutationResponse = z.infer<typeof PreferenceRegistryMutationResponse>;

export const PreferenceRegistryConflictResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    code: z.literal("PREFERENCE_REGISTRY_CONFLICT"),
    message: primitives.string,
    currentRevisionId: primitives.nullableUuid,
    scopeVersion: z.number().int().positive().nullable(),
  }),
);
export type PreferenceRegistryConflictResponse = z.infer<typeof PreferenceRegistryConflictResponse>;

export const PreferenceRegistryFullContentRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    retrievalHandle: z.string().min(1).max(512),
  }),
);
export type PreferenceRegistryFullContentRequest = z.infer<
  typeof PreferenceRegistryFullContentRequest
>;
