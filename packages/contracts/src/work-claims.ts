import { z } from "zod";
import { normalizeAutomaticSessionTitle } from "./session-titles";

export const WORK_CLAIM_NAMESPACE_MAX_BYTES = 64;
export const WORK_CLAIM_CANONICAL_KEY_MAX_BYTES = 512;
export const WORK_CLAIM_DISPLAY_LABEL_MAX_BYTES = 256;
export const WORK_CLAIM_VERSION_VALUE_MAX_BYTES = 256;
export const WORK_CLAIM_ACTIVE_SESSION_CAP = 64;
export const WORK_CLAIM_DISCOVERY_LIMIT = 8;
export const WORK_CLAIM_DISCOVERY_DEFAULT_LIMIT = 4;
export const WORK_DISCOVERY_QUERY_MAX_CHARS = 200;
export const WORK_DISCOVERY_RECENT_HOURS_MAX = 24 * 365;

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const NAMESPACE_PATTERN = /^[a-z0-9](?:[a-z0-9._:-]{0,62}[a-z0-9])?$/u;

function boundedCanonicalText(maxBytes: number, label: string) {
  return z
    .string()
    .min(1)
    .superRefine((value, context) => {
      if (value !== value.trim()) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} must not have leading or trailing whitespace`,
        });
      }
      if (value !== value.normalize("NFKC")) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} must use canonical Unicode normalization`,
        });
      }
      if (CONTROL_CHARACTERS.test(value)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} must not contain control characters`,
        });
      }
      if (utf8Bytes(value) > maxBytes) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} must be at most ${maxBytes} UTF-8 bytes`,
        });
      }
    });
}

export function normalizeWorkClaimNamespace(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

export function normalizeWorkClaimCanonicalKey(value: string): string {
  return value.normalize("NFKC").trim();
}

export function normalizeWorkClaimDisplayLabel(value: string): string | null {
  const normalized = normalizeAutomaticSessionTitle(value);
  if (!normalized || utf8Bytes(normalized) > WORK_CLAIM_DISPLAY_LABEL_MAX_BYTES) return null;
  return normalized;
}

export const WorkClaimNamespace = z
  .string()
  .min(1)
  .max(WORK_CLAIM_NAMESPACE_MAX_BYTES)
  .regex(NAMESPACE_PATTERN)
  .refine((value) => value === normalizeWorkClaimNamespace(value), {
    message: "work claim namespace must already be canonical lowercase text",
  });
export type WorkClaimNamespace = z.infer<typeof WorkClaimNamespace>;

export const WorkClaimCanonicalKey = boundedCanonicalText(
  WORK_CLAIM_CANONICAL_KEY_MAX_BYTES,
  "work claim canonical key",
);
export type WorkClaimCanonicalKey = z.infer<typeof WorkClaimCanonicalKey>;

export const WorkClaimDisplayLabel = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    if (utf8Bytes(value) > WORK_CLAIM_DISPLAY_LABEL_MAX_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `work claim display label must be at most ${WORK_CLAIM_DISPLAY_LABEL_MAX_BYTES} UTF-8 bytes`,
      });
    }
    if (normalizeWorkClaimDisplayLabel(value) !== value) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "work claim display label must be a safe concise semantic label",
      });
    }
  });
export type WorkClaimDisplayLabel = z.infer<typeof WorkClaimDisplayLabel>;

export const WorkClaimSubjectType = z.enum([
  "repository",
  "branch",
  "pull_request",
  "issue",
  "artifact",
  "release",
  "ci_run",
  "other",
]);
export type WorkClaimSubjectType = z.infer<typeof WorkClaimSubjectType>;

export const WorkClaimRole = z.enum(["working", "reviewing", "monitoring", "delivering"]);
export type WorkClaimRole = z.infer<typeof WorkClaimRole>;

export const WorkClaimState = z.enum(["active", "released", "superseded", "stale"]);
export type WorkClaimState = z.infer<typeof WorkClaimState>;

export const WorkClaimProvenance = z.enum([
  "explicit_agent",
  "user_api",
  "trusted_integration",
  "session_resource",
  "system_lifecycle",
]);
export type WorkClaimProvenance = z.infer<typeof WorkClaimProvenance>;

export const WorkClaimVersionKind = z.enum([
  "git_commit",
  "branch_head",
  "pull_request_head",
  "artifact_version",
  "release_version",
  "ci_run",
  "other",
]);
export type WorkClaimVersionKind = z.infer<typeof WorkClaimVersionKind>;

export const WorkClaimVersionValue = boundedCanonicalText(
  WORK_CLAIM_VERSION_VALUE_MAX_BYTES,
  "work claim version value",
);
export type WorkClaimVersionValue = z.infer<typeof WorkClaimVersionValue>;

export const WorkClaimReleaseReason = z.enum([
  "completed",
  "cancelled",
  "failed",
  "superseded",
  "no_longer_active",
  "corrected",
  "external_state_changed",
  "other",
]);
export type WorkClaimReleaseReason = z.infer<typeof WorkClaimReleaseReason>;

export const WorkClaimMutationKind = z.enum([
  "created",
  "updated",
  "released",
  "superseded",
  "stale",
]);
export type WorkClaimMutationKind = z.infer<typeof WorkClaimMutationKind>;

export const WorkClaim = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  rootSessionId: z.string().uuid(),
  subject: z.object({
    namespace: WorkClaimNamespace,
    type: WorkClaimSubjectType,
    canonicalKey: WorkClaimCanonicalKey,
    displayLabel: WorkClaimDisplayLabel.nullable(),
  }),
  role: WorkClaimRole,
  state: WorkClaimState,
  revision: z.number().int().positive(),
  provenance: WorkClaimProvenance,
  version: z
    .object({
      kind: WorkClaimVersionKind,
      value: WorkClaimVersionValue,
    })
    .nullable(),
  observedAt: z.string().datetime({ offset: true }),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  settledAt: z.string().datetime({ offset: true }).nullable(),
});
export type WorkClaim = z.infer<typeof WorkClaim>;

export const WorkClaimMutationResult = z.object({
  claim: WorkClaim,
  mutation: WorkClaimMutationKind,
  replayed: z.boolean(),
});
export type WorkClaimMutationResult = z.infer<typeof WorkClaimMutationResult>;

export const WorkClaimDiscoverySummary = WorkClaim.pick({
  id: true,
  sessionId: true,
  subject: true,
  role: true,
  state: true,
  revision: true,
  provenance: true,
  version: true,
  observedAt: true,
  updatedAt: true,
  settledAt: true,
});
export type WorkClaimDiscoverySummary = z.infer<typeof WorkClaimDiscoverySummary>;

export const WorkClaimSubjectFilter = z
  .object({
    namespace: WorkClaimNamespace,
    type: WorkClaimSubjectType,
    canonicalKey: WorkClaimCanonicalKey,
  })
  .strict();
export type WorkClaimSubjectFilter = z.infer<typeof WorkClaimSubjectFilter>;

export const WorkDiscoveryMatchClass = z.enum(["exact_subject", "title", "goal", "fuzzy"]);
export type WorkDiscoveryMatchClass = z.infer<typeof WorkDiscoveryMatchClass>;

export const WorkDiscoveryMatchedField = z.enum([
  "subject",
  "title",
  "goal",
  "claim_key",
  "claim_label",
]);
export type WorkDiscoveryMatchedField = z.infer<typeof WorkDiscoveryMatchedField>;

/**
 * Deliberately stable bands rather than a raw ranking score. Raw full-text or
 * trigram values are query-relative and become a misleading cross-query API.
 */
export const WorkDiscoveryScoreBand = z.enum(["exact", "strong", "related"]);
export type WorkDiscoveryScoreBand = z.infer<typeof WorkDiscoveryScoreBand>;

export const WorkDiscoveryMatch = z
  .object({
    class: WorkDiscoveryMatchClass,
    field: WorkDiscoveryMatchedField,
    scoreBand: WorkDiscoveryScoreBand,
    claimId: z.string().uuid().nullable(),
  })
  .strict();
export type WorkDiscoveryMatch = z.infer<typeof WorkDiscoveryMatch>;

/**
 * Provider-neutral related-work evidence. The two literal booleans are part of
 * the wire contract so a consumer cannot accidentally present a claim as a
 * lock, authorization grant, ownership transfer, or mandatory instruction.
 */
export const WorkDiscoveryProjection = z
  .object({
    claims: z.array(WorkClaimDiscoverySummary).max(WORK_CLAIM_DISCOVERY_LIMIT),
    claimsTruncated: z.boolean(),
    match: WorkDiscoveryMatch.nullable(),
    possibleOverlap: z.boolean(),
    advisoryOnly: z.literal(true),
    noAdditionalAccess: z.literal(true),
  })
  .strict();
export type WorkDiscoveryProjection = z.infer<typeof WorkDiscoveryProjection>;
