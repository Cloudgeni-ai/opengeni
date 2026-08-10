import { z } from "zod";

export const COMPANY_PROFILE_SCALAR_MAX_CHARS = 2_048;
export const COMPANY_PROFILE_ENTRY_MAX_CHARS = 1_024;
export const COMPANY_PROFILE_ENTRY_MAX_COUNT = 16;
export const COMPANY_PROFILE_STABLE_KEY_MAX_CHARS = 96;
export const COMPANY_PROFILE_REASON_MAX_CHARS = 4_096;
export const COMPANY_PROFILE_SOURCE_ID_MAX_CHARS = 512;
export const COMPANY_PROFILE_CONTENT_MAX_UTF8_BYTES = 28_672;
export const COMPANY_PROFILE_PROMPT_MAX_UTF8_BYTES = 32_768;

export const CompanyProfileStableKey = z
  .string()
  .min(1)
  .max(COMPANY_PROFILE_STABLE_KEY_MAX_CHARS)
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/);
export type CompanyProfileStableKey = z.infer<typeof CompanyProfileStableKey>;

export function normalizeCompanyProfileStableKey(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, "-").replace(/-+/g, "-");
}

export const CompanyProfileStableKeyInput = z
  .string()
  .transform(normalizeCompanyProfileStableKey)
  .pipe(CompanyProfileStableKey);

export const CompanyProfileEntry = z.object({
  key: CompanyProfileStableKeyInput,
  content: z
    .string()
    .min(1)
    .max(COMPANY_PROFILE_ENTRY_MAX_CHARS)
    .refine((value) => value.trim().length > 0, "company-profile entries must not be blank"),
});
export type CompanyProfileEntry = z.infer<typeof CompanyProfileEntry>;

function boundedScalar() {
  return z
    .string()
    .min(1)
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

export const CompanyProfileContent = z
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
  });
export type CompanyProfileContent = z.infer<typeof CompanyProfileContent>;

export const CompanyProfileRevisionIntent = z.enum(["active", "proposal"]);
export type CompanyProfileRevisionIntent = z.infer<typeof CompanyProfileRevisionIntent>;

export const CompanyProfileProvenanceSource = z.enum(["human", "durable_learning", "migration"]);
export type CompanyProfileProvenanceSource = z.infer<typeof CompanyProfileProvenanceSource>;

export const CompanyProfileActivationType = z.enum(["activate", "rollback"]);
export type CompanyProfileActivationType = z.infer<typeof CompanyProfileActivationType>;

export const CompanyProfileRevisionIdentity = z.object({
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type CompanyProfileRevisionIdentity = z.infer<typeof CompanyProfileRevisionIdentity>;

export const CompanyProfileRevision = CompanyProfileRevisionIdentity.extend({
  operationId: z.string().uuid(),
  accountId: z.string().uuid(),
  intent: CompanyProfileRevisionIntent,
  profile: CompanyProfileContent,
  provenance: z.object({
    source: CompanyProfileProvenanceSource,
    sourceId: z.string().min(1).max(COMPANY_PROFILE_SOURCE_ID_MAX_CHARS).nullable(),
  }),
  supersedesRevisionId: z.string().uuid().nullable(),
  createdBySubjectId: z.string().min(1).max(1_024),
  createdAt: z.string().datetime(),
});
export type CompanyProfileRevision = z.infer<typeof CompanyProfileRevision>;

export const CompanyProfileHead = z.object({
  accountId: z.string().uuid(),
  revisionId: z.string().uuid(),
  revision: z.number().int().positive(),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  activationVersion: z.number().int().positive(),
  activatedAt: z.string().datetime(),
});
export type CompanyProfileHead = z.infer<typeof CompanyProfileHead>;

export const CompanyProfileActivationEvent = z.object({
  id: z.string().uuid(),
  operationId: z.string().uuid(),
  accountId: z.string().uuid(),
  type: CompanyProfileActivationType,
  activationVersion: z.number().int().positive(),
  oldRevision: CompanyProfileRevisionIdentity.nullable(),
  newRevision: CompanyProfileRevisionIdentity.nullable(),
  actorSubjectId: z.string().min(1).max(1_024),
  reason: z.string().min(1).max(COMPANY_PROFILE_REASON_MAX_CHARS),
  createdAt: z.string().datetime(),
});
export type CompanyProfileActivationEvent = z.infer<typeof CompanyProfileActivationEvent>;

export const CompanyProfileSnapshotEntry = CompanyProfileRevisionIdentity.extend({
  activationVersion: z.number().int().positive(),
  activatedAt: z.string().datetime(),
  provenance: z.object({
    source: CompanyProfileProvenanceSource,
    sourceIdHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
  }),
});
export type CompanyProfileSnapshotEntry = z.infer<typeof CompanyProfileSnapshotEntry>;

export const CompanyProfileSnapshot = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  sessionId: z.string().uuid(),
  turnId: z.string().uuid(),
  attemptId: z.string().uuid(),
  executionGeneration: z.number().int().positive(),
  profile: CompanyProfileSnapshotEntry.nullable(),
  snapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.string().datetime(),
});
export type CompanyProfileSnapshot = z.infer<typeof CompanyProfileSnapshot>;

export const ResolvedCompanyProfileSnapshot = CompanyProfileSnapshot.extend({
  profile: CompanyProfileSnapshotEntry.extend({ profile: CompanyProfileContent }).nullable(),
});
export type ResolvedCompanyProfileSnapshot = z.infer<typeof ResolvedCompanyProfileSnapshot>;

export const CompanyProfileListQuery = z.object({
  afterRevision: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type CompanyProfileListQuery = z.infer<typeof CompanyProfileListQuery>;

export const CompanyProfileListResponse = z.object({
  current: CompanyProfileHead.nullable(),
  revisions: z.array(CompanyProfileRevision),
  activationEvents: z.array(CompanyProfileActivationEvent),
  nextAfterRevision: z.number().int().positive().nullable(),
});
export type CompanyProfileListResponse = z.infer<typeof CompanyProfileListResponse>;

export const UpdateCompanyProfileRequest = z.object({
  operationId: z.string().uuid().optional(),
  profile: CompanyProfileContent,
  expectedCurrentRevisionId: z.string().uuid().nullable(),
  expectedActivationVersion: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(COMPANY_PROFILE_REASON_MAX_CHARS),
});
export type UpdateCompanyProfileRequest = z.infer<typeof UpdateCompanyProfileRequest>;

export const ActivateCompanyProfileRevisionRequest = z.object({
  operationId: z.string().uuid().optional(),
  expectedCurrentRevisionId: z.string().uuid().nullable(),
  expectedActivationVersion: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(COMPANY_PROFILE_REASON_MAX_CHARS),
});
export type ActivateCompanyProfileRevisionRequest = z.infer<
  typeof ActivateCompanyProfileRevisionRequest
>;

export const RollbackCompanyProfileRequest = z.object({
  operationId: z.string().uuid().optional(),
  targetRevisionId: z.string().uuid(),
  expectedCurrentRevisionId: z.string().uuid(),
  expectedActivationVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(COMPANY_PROFILE_REASON_MAX_CHARS),
});
export type RollbackCompanyProfileRequest = z.infer<typeof RollbackCompanyProfileRequest>;

export const CompanyProfileMutationResponse = z.object({
  revision: CompanyProfileRevision.nullable(),
  head: CompanyProfileHead.nullable(),
  event: CompanyProfileActivationEvent.nullable(),
});
export type CompanyProfileMutationResponse = z.infer<typeof CompanyProfileMutationResponse>;

export const CompanyProfileDiffRequest = z
  .object({ fromRevisionId: z.string().uuid(), toRevisionId: z.string().uuid() })
  .refine((value) => value.fromRevisionId !== value.toRevisionId, {
    path: ["toRevisionId"],
    message: "diff revisions must be different",
  });
export type CompanyProfileDiffRequest = z.infer<typeof CompanyProfileDiffRequest>;

export const CompanyProfileDiffResponse = z.object({
  from: CompanyProfileRevision,
  to: CompanyProfileRevision,
  format: z.literal("unified_json"),
  diff: z.string(),
});
export type CompanyProfileDiffResponse = z.infer<typeof CompanyProfileDiffResponse>;

export const CompanyProfileConflictResponse = z.object({
  code: z.literal("COMPANY_PROFILE_CONFLICT"),
  message: z.string(),
  currentHead: CompanyProfileHead.nullable(),
});

export const CompanyProfileOperationReuseResponse = z.object({
  code: z.literal("COMPANY_PROFILE_OPERATION_REUSED"),
  message: z.string(),
});

export const CompanyProfileLearningSubjectKind = z.enum([
  "company_identity",
  "company_mission",
  "company_product",
  "company_customer",
  "company_goal",
  "company_constraint",
]);
export type CompanyProfileLearningSubjectKind = z.infer<typeof CompanyProfileLearningSubjectKind>;

const CompanyProfileScalarLearningSubject = z.object({
  kind: z.enum(["company_identity", "company_mission"]),
  content: z.string().trim().min(1).max(COMPANY_PROFILE_SCALAR_MAX_CHARS),
  stableKey: z.null(),
});

const CompanyProfileRepeatableLearningSubject = z.object({
  kind: z.enum(["company_product", "company_customer", "company_goal", "company_constraint"]),
  content: z.string().trim().min(1).max(COMPANY_PROFILE_ENTRY_MAX_CHARS),
  stableKey: CompanyProfileStableKeyInput,
});

/** Authority-native seam invoked only by the canonical durable-learning router adapter. */
export const CompanyProfileLearningWrite = z.object({
  operationId: z.string().uuid(),
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  actorSubjectId: z.string().min(1).max(1_024),
  authority: z.enum(["active", "proposal"]),
  subject: z.discriminatedUnion("kind", [
    CompanyProfileScalarLearningSubject,
    CompanyProfileRepeatableLearningSubject,
  ]),
  sourceId: z.string().min(1).max(COMPANY_PROFILE_SOURCE_ID_MAX_CHARS),
});
export type CompanyProfileLearningWrite = z.infer<typeof CompanyProfileLearningWrite>;
