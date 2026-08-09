import { z } from "zod";
import {
  DURABLE_LEARNING_CONTRACT_VERSION,
  DURABLE_LEARNING_CONTENT_MAX_CHARS,
  DURABLE_LEARNING_REASON_MAX_CHARS,
  DurableLearningDecisionCode,
  DurableLearningResolvedAuthority,
  DurableLearningResolvedSurface,
  DurableLearningResource,
  DurableLearningScope,
  DurableLearningSubjectKind,
} from "./durable-learning";

export const EXPLICIT_DURABLE_WRITE_CONTRACT_VERSION = "explicit-durable-write.v1" as const;
export const EXPLICIT_DURABLE_WRITE_SUMMARY_MAX_CHARS = 240;
export const EXPLICIT_DURABLE_WRITE_SOURCE_ID_MAX_CHARS = 1_024;
export const EXPLICIT_DURABLE_WRITE_SOURCE_VERSION_MAX_CHARS = 256;

/**
 * The model selects one explicit scope. Subject ids, workspace ids, and
 * organization ids are never model input; the host binds them from the exact
 * accepted turn before calling the durable-learning router.
 */
export const ExplicitRememberScope = z.enum(["unspecified", "personal", "workspace", "company"]);
export type ExplicitRememberScope = z.infer<typeof ExplicitRememberScope>;

/**
 * Explicit remember writes activate existing knowledge authorities. Documents,
 * connector payloads, and transcripts stay on their evidence ingestion paths.
 */
export const ExplicitRememberIntent = DurableLearningSubjectKind.exclude([
  "document",
  "connector_content",
  "transcript",
]);
export type ExplicitRememberIntent = z.infer<typeof ExplicitRememberIntent>;

export const ExplicitRememberSubject = z.object({
  intent: ExplicitRememberIntent,
  content: z
    .string()
    .min(1)
    .max(DURABLE_LEARNING_CONTENT_MAX_CHARS)
    .refine((value) => value.trim().length > 0, "explicit remember content must not be blank"),
  stableKey: z.string().min(1).max(96).nullable().default(null),
  title: z.string().min(1).max(120).nullable().default(null),
  summary: z.string().min(1).max(512).nullable().default(null),
  replacesResourceId: z.string().min(1).max(512).nullable().default(null),
});
export type ExplicitRememberSubject = z.infer<typeof ExplicitRememberSubject>;

export const ExplicitRememberCommand = z.object({
  contractVersion: z.literal(EXPLICIT_DURABLE_WRITE_CONTRACT_VERSION),
  operation: z.literal("remember"),
  scope: ExplicitRememberScope,
  subject: ExplicitRememberSubject,
});
export type ExplicitRememberCommand = z.infer<typeof ExplicitRememberCommand>;

export const ExplicitRememberUndoCommand = z.object({
  contractVersion: z.literal(EXPLICIT_DURABLE_WRITE_CONTRACT_VERSION),
  operation: z.literal("undo"),
  targetAttemptId: z.string().uuid(),
  reason: z.string().trim().min(1).max(DURABLE_LEARNING_REASON_MAX_CHARS),
});
export type ExplicitRememberUndoCommand = z.infer<typeof ExplicitRememberUndoCommand>;

export const ExplicitDurableWriteCommand = z.discriminatedUnion("operation", [
  ExplicitRememberCommand,
  ExplicitRememberUndoCommand,
]);
export type ExplicitDurableWriteCommand = z.infer<typeof ExplicitDurableWriteCommand>;

/**
 * Trusted host binding. None of these fields belong in the model-visible tool
 * schema. Retries of one accepted tool call reuse the same attempt id and exact
 * source binding.
 */
export const ExplicitDurableWriteBinding = z.object({
  attemptId: z.string().uuid(),
  sessionId: z.string().uuid(),
  sourceMessage: z
    .object({
      id: z.string().min(1).max(EXPLICIT_DURABLE_WRITE_SOURCE_ID_MAX_CHARS),
      version: z.string().min(1).max(EXPLICIT_DURABLE_WRITE_SOURCE_VERSION_MAX_CHARS).nullable(),
      contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .nullable(),
});
export type ExplicitDurableWriteBinding = z.infer<typeof ExplicitDurableWriteBinding>;

const ExplicitDurableWriteOutcome = z.enum([
  "applied",
  "proposed",
  "evidence_recorded",
  "noop",
  "clarification_required",
  "rejected",
  "rolled_back",
  "failed",
]);

/**
 * Concise, user-visible projection of the canonical router receipt. The
 * authority-owned rollback token is intentionally absent; undo references the
 * immutable write attempt and must re-enter the router.
 */
export const ExplicitDurableWriteReceipt = z.object({
  contractVersion: z.literal(EXPLICIT_DURABLE_WRITE_CONTRACT_VERSION),
  routerContractVersion: z.literal(DURABLE_LEARNING_CONTRACT_VERSION),
  operation: z.enum(["remember", "undo"]),
  attemptId: z.string().uuid(),
  inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  idempotency: z.enum(["created", "replayed"]),
  outcome: ExplicitDurableWriteOutcome,
  decision: z.object({
    disposition: z.enum(["route", "clarification_required", "rejected"]),
    code: DurableLearningDecisionCode,
    reasons: z.array(z.string().min(1).max(512)).max(16),
    clarificationFields: z
      .array(z.enum(["requestedScope", "requestedAuthority", "targetSurface"]))
      .max(3),
  }),
  saved: z
    .object({
      summary: z.string().min(1).max(EXPLICIT_DURABLE_WRITE_SUMMARY_MAX_CHARS),
      destination: DurableLearningResolvedSurface,
      scope: DurableLearningScope,
      authority: DurableLearningResolvedAuthority,
      resource: DurableLearningResource.nullable(),
    })
    .nullable(),
  effectiveBoundary: z.enum(["immediate", "next_accepted_attempt", "not_applicable"]),
  inspect: z
    .object({
      surface: DurableLearningResolvedSurface,
      resourceId: z.string().min(1).max(512),
      version: z.string().min(1).max(512).nullable(),
    })
    .nullable(),
  undo: z
    .object({
      supported: z.boolean(),
      targetAttemptId: z.string().uuid().nullable(),
    })
    .nullable(),
  audit: z.object({
    sourceEvidence: z
      .array(
        z.object({
          sourceId: z.string().min(1).max(EXPLICIT_DURABLE_WRITE_SOURCE_ID_MAX_CHARS),
          contentHash: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .nullable(),
        }),
      )
      .max(32),
  }),
  createdAt: z.string().datetime(),
});
export type ExplicitDurableWriteReceipt = z.infer<typeof ExplicitDurableWriteReceipt>;
