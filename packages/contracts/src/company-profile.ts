import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";
import {
  AGENT_AUTHORED_COMPANY_PROFILE_CONTENT_MAX_UTF8_BYTES,
  AGENT_AUTHORED_COMPANY_PROFILE_ENTRY_MAX_CHARS,
  AGENT_AUTHORED_COMPANY_PROFILE_SCALAR_MAX_CHARS,
  AGENT_AUTHORED_COMPANY_PROFILE_TOO_LONG_MESSAGE,
} from "./agent-authored-durable-text";
import { HumanInputQuestion } from "./index";

export const COMPANY_PROFILE_SCALAR_MAX_CHARS = 2_048;
export const COMPANY_PROFILE_ENTRY_MAX_CHARS = 1_024;
export const COMPANY_PROFILE_ENTRY_MAX_COUNT = 16;
export const COMPANY_PROFILE_STABLE_KEY_MAX_CHARS = 96;
export const COMPANY_PROFILE_REASON_MAX_CHARS = 4_096;
export const COMPANY_PROFILE_SOURCE_ID_MAX_CHARS = 512;
export const COMPANY_PROFILE_CONTENT_MAX_UTF8_BYTES = 28_672;
export const COMPANY_PROFILE_PROMPT_MAX_UTF8_BYTES = 32_768;

export const CompanyProfileStableKey = /* @__PURE__ */ defineSchema(() =>
  primitives.nonEmptyString
    .max(COMPANY_PROFILE_STABLE_KEY_MAX_CHARS)
    .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/),
);
export type CompanyProfileStableKey = z.infer<typeof CompanyProfileStableKey>;

export function normalizeCompanyProfileStableKey(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, "-").replace(/-+/g, "-");
}

export const CompanyProfileStableKeyInput = /* @__PURE__ */ defineSchema(() =>
  primitives.string.transform(normalizeCompanyProfileStableKey).pipe(CompanyProfileStableKey),
);

export const CompanyProfileEntry = /* @__PURE__ */ defineSchema(() =>
  z.object({
    key: CompanyProfileStableKeyInput,
    content: primitives.nonEmptyString
      .max(COMPANY_PROFILE_ENTRY_MAX_CHARS)
      .refine((value) => value.trim().length > 0, "company-profile entries must not be blank"),
  }),
);
export type CompanyProfileEntry = z.infer<typeof CompanyProfileEntry>;

function boundedScalar() {
  return primitives.nonEmptyString
    .max(COMPANY_PROFILE_SCALAR_MAX_CHARS)
    .refine((value) => value.trim().length > 0, "company-profile scalar content must not be blank")
    .nullable();
}

function uniqueEntryKeys(
  entries: CompanyProfileEntry[],
  field: "products" | "customers" | "goals" | "constraints",
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (seen.has(entry.key)) {
      context.addIssue({
        code: "custom",
        path: [field, index, "key"],
        message: `duplicate company-profile ${field} key`,
      });
    }
    seen.add(entry.key);
  }
}

export const CompanyProfileContent = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      identity: boundedScalar(),
      mission: boundedScalar(),
      products: z.array(CompanyProfileEntry).max(COMPANY_PROFILE_ENTRY_MAX_COUNT),
      customers: z.array(CompanyProfileEntry).max(COMPANY_PROFILE_ENTRY_MAX_COUNT),
      goals: z.array(CompanyProfileEntry).max(COMPANY_PROFILE_ENTRY_MAX_COUNT),
      constraints: z.array(CompanyProfileEntry).max(COMPANY_PROFILE_ENTRY_MAX_COUNT),
    })
    .strict()
    .superRefine((value, context) => {
      uniqueEntryKeys(value.products, "products", context);
      uniqueEntryKeys(value.customers, "customers", context);
      uniqueEntryKeys(value.goals, "goals", context);
      uniqueEntryKeys(value.constraints, "constraints", context);
      if (
        value.identity === null &&
        value.mission === null &&
        value.products.length === 0 &&
        value.customers.length === 0 &&
        value.goals.length === 0 &&
        value.constraints.length === 0
      ) {
        context.addIssue({
          code: "custom",
          message: "a company profile must contain at least one field",
        });
      }
      const contentBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
      if (contentBytes > COMPANY_PROFILE_CONTENT_MAX_UTF8_BYTES) {
        context.addIssue({
          code: "custom",
          message: `company profile is ${contentBytes} UTF-8 bytes; limit is ${COMPANY_PROFILE_CONTENT_MAX_UTF8_BYTES}`,
        });
      }
    }),
);
export type CompanyProfileContent = z.infer<typeof CompanyProfileContent>;

/**
 * The same profile, bounded for an **agent** author. The human `account:admin`
 * route keeps `CompanyProfileContent` and its wider limits; this is the shape
 * persisted by the first-party `company_profile_propose` tool. The current tool
 * accepts only identity and mission and writes empty compatibility lists, but
 * the validator must still read historical revisions without rewriting them.
 */
export const AgentAuthoredCompanyProfileContent = /* @__PURE__ */ defineSchema(() =>
  CompanyProfileContent.superRefine((value, context) => {
    for (const field of ["identity", "mission"] as const) {
      const scalar = value[field];
      if (scalar !== null && scalar.length > AGENT_AUTHORED_COMPANY_PROFILE_SCALAR_MAX_CHARS) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} is ${scalar.length} characters. ${AGENT_AUTHORED_COMPANY_PROFILE_TOO_LONG_MESSAGE}`,
        });
      }
    }
    for (const field of ["products", "customers", "goals", "constraints"] as const) {
      for (const [index, entry] of value[field].entries()) {
        if (entry.content.length > AGENT_AUTHORED_COMPANY_PROFILE_ENTRY_MAX_CHARS) {
          context.addIssue({
            code: "custom",
            path: [field, index, "content"],
            message: `this entry is ${entry.content.length} characters. ${AGENT_AUTHORED_COMPANY_PROFILE_TOO_LONG_MESSAGE}`,
          });
        }
      }
    }
    const contentBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (contentBytes > AGENT_AUTHORED_COMPANY_PROFILE_CONTENT_MAX_UTF8_BYTES) {
      context.addIssue({
        code: "custom",
        message: `this profile is ${contentBytes} UTF-8 bytes. ${AGENT_AUTHORED_COMPANY_PROFILE_TOO_LONG_MESSAGE}`,
      });
    }
  }),
);
export type AgentAuthoredCompanyProfileContent = z.infer<typeof AgentAuthoredCompanyProfileContent>;

export const CompanyProfileRevisionIntent = /* @__PURE__ */ defineSchema(() =>
  z.enum(["active", "proposal"]),
);
export type CompanyProfileRevisionIntent = z.infer<typeof CompanyProfileRevisionIntent>;

export const CompanyProfileProvenanceSource = /* @__PURE__ */ defineSchema(() =>
  z.enum(["human", "agent_admin", "durable_learning", "migration"]),
);
export type CompanyProfileProvenanceSource = z.infer<typeof CompanyProfileProvenanceSource>;

export const CompanyProfilePrincipalKind = /* @__PURE__ */ defineSchema(() =>
  z.enum(["human_session", "agent_attempt", "service"]),
);
export type CompanyProfilePrincipalKind = z.infer<typeof CompanyProfilePrincipalKind>;

export const CompanyProfileActivationType = /* @__PURE__ */ defineSchema(() =>
  z.enum(["activate", "rollback"]),
);
export type CompanyProfileActivationType = z.infer<typeof CompanyProfileActivationType>;

export const CompanyProfileRevisionIdentity = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid,
    revision: primitives.positiveInteger,
    contentHash: primitives.string.regex(/^[0-9a-f]{64}$/),
  }),
);
export type CompanyProfileRevisionIdentity = z.infer<typeof CompanyProfileRevisionIdentity>;

export const CompanyProfileRevision = /* @__PURE__ */ defineSchema(() =>
  CompanyProfileRevisionIdentity.extend({
    operationId: primitives.uuid,
    accountId: primitives.uuid,
    intent: CompanyProfileRevisionIntent,
    profile: CompanyProfileContent,
    provenance: z.object({
      source: CompanyProfileProvenanceSource,
      sourceId: primitives.nonEmptyString.max(COMPANY_PROFILE_SOURCE_ID_MAX_CHARS).nullable(),
    }),
    supersedesRevisionId: primitives.nullableUuid,
    createdBySubjectId: z.string().min(1).max(1_024),
    createdAt: primitives.dateTime,
  }),
);
export type CompanyProfileRevision = z.infer<typeof CompanyProfileRevision>;

export const CompanyProfileHead = /* @__PURE__ */ defineSchema(() =>
  z.object({
    accountId: primitives.uuid,
    revisionId: primitives.uuid,
    revision: primitives.positiveInteger,
    contentHash: primitives.string.regex(/^[0-9a-f]{64}$/),
    activationVersion: primitives.positiveInteger,
    activatedAt: primitives.dateTime,
  }),
);
export type CompanyProfileHead = z.infer<typeof CompanyProfileHead>;

export const CompanyProfileActivationEvent = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid,
    operationId: primitives.uuid,
    accountId: primitives.uuid,
    type: CompanyProfileActivationType,
    activationVersion: primitives.positiveInteger,
    oldRevision: CompanyProfileRevisionIdentity.nullable(),
    newRevision: CompanyProfileRevisionIdentity.nullable(),
    actorSubjectId: z.string().min(1).max(1_024),
    reason: primitives.nonEmptyString.max(COMPANY_PROFILE_REASON_MAX_CHARS),
    createdAt: primitives.dateTime,
  }),
);
export type CompanyProfileActivationEvent = z.infer<typeof CompanyProfileActivationEvent>;

export const CompanyProfileSnapshotEntry = /* @__PURE__ */ defineSchema(() =>
  CompanyProfileRevisionIdentity.extend({
    activationVersion: primitives.positiveInteger,
    activatedAt: primitives.dateTime,
    provenance: z.object({
      source: CompanyProfileProvenanceSource,
      sourceIdHash: primitives.string.regex(/^[0-9a-f]{64}$/).nullable(),
    }),
  }),
);
export type CompanyProfileSnapshotEntry = z.infer<typeof CompanyProfileSnapshotEntry>;

export const CompanyProfileSnapshot = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid,
    accountId: primitives.uuid,
    workspaceId: primitives.uuid,
    sessionId: primitives.uuid,
    turnId: primitives.uuid,
    attemptId: primitives.uuid,
    executionGeneration: primitives.positiveInteger,
    profile: CompanyProfileSnapshotEntry.nullable(),
    snapshotHash: primitives.string.regex(/^[0-9a-f]{64}$/),
    createdAt: primitives.dateTime,
  }),
);
export type CompanyProfileSnapshot = z.infer<typeof CompanyProfileSnapshot>;

export const ResolvedCompanyProfileSnapshot = /* @__PURE__ */ defineSchema(() =>
  CompanyProfileSnapshot.extend({
    profile: CompanyProfileSnapshotEntry.extend({ profile: CompanyProfileContent }).nullable(),
  }),
);
export type ResolvedCompanyProfileSnapshot = z.infer<typeof ResolvedCompanyProfileSnapshot>;

export const CompanyProfileListQuery = /* @__PURE__ */ defineSchema(() =>
  z.object({
    afterRevision: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
);
export type CompanyProfileListQuery = z.infer<typeof CompanyProfileListQuery>;

export const CompanyProfileListResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    current: CompanyProfileHead.nullable(),
    activeRevision: CompanyProfileRevision.nullable(),
    revisions: z.array(CompanyProfileRevision),
    activationEvents: z.array(CompanyProfileActivationEvent),
    nextAfterRevision: z.number().int().positive().nullable(),
  }),
);
export type CompanyProfileListResponse = z.infer<typeof CompanyProfileListResponse>;

export const UpdateCompanyProfileRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    operationId: primitives.optionalUuid,
    profile: CompanyProfileContent,
    expectedCurrentRevisionId: primitives.nullableUuid,
    expectedActivationVersion: primitives.nonnegativeInteger,
    reason: primitives.string.trim().min(1).max(COMPANY_PROFILE_REASON_MAX_CHARS),
  }),
);
export type UpdateCompanyProfileRequest = z.infer<typeof UpdateCompanyProfileRequest>;

export const ActivateCompanyProfileRevisionRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    operationId: primitives.optionalUuid,
    expectedCurrentRevisionId: primitives.nullableUuid,
    expectedActivationVersion: primitives.nonnegativeInteger,
    reason: primitives.string.trim().min(1).max(COMPANY_PROFILE_REASON_MAX_CHARS),
  }),
);
export type ActivateCompanyProfileRevisionRequest = z.infer<
  typeof ActivateCompanyProfileRevisionRequest
>;

export const RollbackCompanyProfileRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    operationId: primitives.optionalUuid,
    targetRevisionId: primitives.uuid,
    expectedCurrentRevisionId: primitives.uuid,
    expectedActivationVersion: primitives.positiveInteger,
    reason: primitives.string.trim().min(1).max(COMPANY_PROFILE_REASON_MAX_CHARS),
  }),
);
export type RollbackCompanyProfileRequest = z.infer<typeof RollbackCompanyProfileRequest>;

export const CompanyProfileMutationResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    revision: CompanyProfileRevision.nullable(),
    head: CompanyProfileHead.nullable(),
    event: CompanyProfileActivationEvent.nullable(),
  }),
);
export type CompanyProfileMutationResponse = z.infer<typeof CompanyProfileMutationResponse>;

export const COMPANY_PROFILE_AGENT_APPROVE_OPTION = "activate" as const;
export const COMPANY_PROFILE_AGENT_REJECT_OPTION = "skip" as const;

export const CompanyProfileAgentPolicyMode = /* @__PURE__ */ defineSchema(() =>
  z.enum(["off", "suggest", "automatic"]),
);
export type CompanyProfileAgentPolicyMode = z.infer<typeof CompanyProfileAgentPolicyMode>;

export const CompanyProfileAgentPolicy = /* @__PURE__ */ defineSchema(() =>
  z.object({
    organizationId: primitives.uuid,
    mode: CompanyProfileAgentPolicyMode,
    version: primitives.nonnegativeInteger,
    updatedAt: primitives.string.datetime({ offset: true }),
    changed: primitives.optionalBoolean,
  }),
);
export type CompanyProfileAgentPolicy = z.infer<typeof CompanyProfileAgentPolicy>;

export const UpdateCompanyProfileAgentPolicyRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      mode: CompanyProfileAgentPolicyMode,
      expectedVersion: primitives.nonnegativeInteger,
      operationId: primitives.uuid,
    })
    .strict(),
);
export type UpdateCompanyProfileAgentPolicyRequest = z.infer<
  typeof UpdateCompanyProfileAgentPolicyRequest
>;

export const CompanyProfileAgentAttempt = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      accountId: primitives.uuid,
      workspaceId: primitives.uuid,
      sessionId: primitives.uuid,
      turnId: primitives.uuid,
      attemptId: primitives.uuid,
      executionGeneration: primitives.positiveInteger,
      agentSubjectId: primitives.string.trim().min(1).max(1_024),
    })
    .strict(),
);
export type CompanyProfileAgentAttempt = z.infer<typeof CompanyProfileAgentAttempt>;

export const CompanyProfileAgentProposalRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      operationId: primitives.uuid,
      profile: CompanyProfileContent,
      reason: primitives.string.trim().min(1).max(COMPANY_PROFILE_REASON_MAX_CHARS),
    })
    .strict(),
);
export type CompanyProfileAgentProposalRequest = z.infer<typeof CompanyProfileAgentProposalRequest>;

// z.lazy avoids an import cycle because HumanInputQuestion is declared in the
// root contracts module that re-exports this file.
export const CompanyProfileAgentHumanInputPrompt = /* @__PURE__ */ defineSchema(() =>
  z.object({
    questions: z.array(z.lazy(() => HumanInputQuestion)).length(1),
    allowSkip: z.literal(false),
  }),
);
export type CompanyProfileAgentHumanInputPrompt = z.infer<
  typeof CompanyProfileAgentHumanInputPrompt
>;

export const CompanyProfileAgentReviewRequiredReceipt = /* @__PURE__ */ defineSchema(() =>
  z.object({
    status: z.literal("confirmation_required"),
    operationId: primitives.uuid,
    proposalReceiptId: primitives.uuid,
    revision: CompanyProfileRevision,
    policyMode: z.literal("suggest"),
    humanInput: CompanyProfileAgentHumanInputPrompt,
    confirmWith: z.literal("company_profile_confirm"),
    replayed: primitives.boolean,
  }),
);
export type CompanyProfileAgentReviewRequiredReceipt = z.infer<
  typeof CompanyProfileAgentReviewRequiredReceipt
>;

export const CompanyProfileAgentAutomaticActivationReceipt = /* @__PURE__ */ defineSchema(() =>
  z.object({
    status: z.literal("activated"),
    operationId: primitives.uuid,
    proposalReceiptId: primitives.uuid,
    automaticActivationReceiptId: primitives.uuid,
    policyMode: z.literal("automatic"),
    mutation: CompanyProfileMutationResponse,
    replayed: primitives.boolean,
  }),
);
export type CompanyProfileAgentAutomaticActivationReceipt = z.infer<
  typeof CompanyProfileAgentAutomaticActivationReceipt
>;

export const CompanyProfileAgentProposalReceipt = /* @__PURE__ */ defineSchema(() =>
  z.discriminatedUnion("status", [
    CompanyProfileAgentReviewRequiredReceipt,
    CompanyProfileAgentAutomaticActivationReceipt,
  ]),
);
export type CompanyProfileAgentProposalReceipt = z.infer<typeof CompanyProfileAgentProposalReceipt>;

export const CompanyProfileAgentConfirmRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      operationId: primitives.uuid,
      proposalReceiptId: primitives.uuid,
      humanInputRequestId: primitives.uuid,
    })
    .strict(),
);
export type CompanyProfileAgentConfirmRequest = z.infer<typeof CompanyProfileAgentConfirmRequest>;

export const CompanyProfileAgentConfirmationReceipt = /* @__PURE__ */ defineSchema(() =>
  z.object({
    status: z.literal("activated"),
    operationId: primitives.uuid,
    confirmationReceiptId: primitives.uuid,
    proposalReceiptId: primitives.uuid,
    humanInputRequestId: primitives.uuid,
    mutation: CompanyProfileMutationResponse,
    replayed: primitives.boolean,
  }),
);
export type CompanyProfileAgentConfirmationReceipt = z.infer<
  typeof CompanyProfileAgentConfirmationReceipt
>;

export const CompanyProfileDiffRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({ fromRevisionId: primitives.uuid, toRevisionId: primitives.uuid })
    .refine((value) => value.fromRevisionId !== value.toRevisionId, {
      path: ["toRevisionId"],
      message: "diff revisions must be different",
    }),
);
export type CompanyProfileDiffRequest = z.infer<typeof CompanyProfileDiffRequest>;

export const CompanyProfileDiffResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    from: CompanyProfileRevision,
    to: CompanyProfileRevision,
    format: z.literal("unified_json"),
    diff: primitives.string,
  }),
);
export type CompanyProfileDiffResponse = z.infer<typeof CompanyProfileDiffResponse>;

export const CompanyProfileConflictResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    code: z.literal("COMPANY_PROFILE_CONFLICT"),
    message: primitives.string,
    currentHead: CompanyProfileHead.nullable(),
  }),
);

export const CompanyProfileOperationReuseResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    code: z.literal("COMPANY_PROFILE_OPERATION_REUSED"),
    message: primitives.string,
  }),
);

export const CompanyProfileLearningSubjectKind = /* @__PURE__ */ defineSchema(() =>
  z.enum([
    "company_identity",
    "company_mission",
    "company_product",
    "company_customer",
    "company_goal",
    "company_constraint",
  ]),
);
export type CompanyProfileLearningSubjectKind = z.infer<typeof CompanyProfileLearningSubjectKind>;

const CompanyProfileScalarLearningSubject = /* @__PURE__ */ defineSchema(() =>
  z.object({
    kind: z.enum(["company_identity", "company_mission"]),
    content: primitives.string.trim().min(1).max(COMPANY_PROFILE_SCALAR_MAX_CHARS),
    stableKey: z.null(),
  }),
);

const CompanyProfileRepeatableLearningSubject = /* @__PURE__ */ defineSchema(() =>
  z.object({
    kind: z.enum(["company_product", "company_customer", "company_goal", "company_constraint"]),
    content: primitives.string.trim().min(1).max(COMPANY_PROFILE_ENTRY_MAX_CHARS),
    stableKey: CompanyProfileStableKeyInput,
  }),
);

/** Authority-native seam invoked only by the canonical durable-learning router adapter. */
export const CompanyProfileLearningWrite = /* @__PURE__ */ defineSchema(() =>
  z.object({
    operationId: primitives.uuid,
    accountId: primitives.uuid,
    workspaceId: primitives.uuid,
    actorSubjectId: z.string().min(1).max(1_024),
    actorKind: z.enum(["human", "agent", "service"]),
    authority: z.enum(["active", "proposal"]),
    subject: z.discriminatedUnion("kind", [
      CompanyProfileScalarLearningSubject,
      CompanyProfileRepeatableLearningSubject,
    ]),
    sourceId: primitives.nonEmptyString.max(COMPANY_PROFILE_SOURCE_ID_MAX_CHARS),
  }),
);
export type CompanyProfileLearningWrite = z.infer<typeof CompanyProfileLearningWrite>;
