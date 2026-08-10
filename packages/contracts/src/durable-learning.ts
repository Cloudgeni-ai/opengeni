import { z } from "zod";
import {
  COMPANY_PROFILE_ENTRY_MAX_CHARS,
  COMPANY_PROFILE_SCALAR_MAX_CHARS,
  CompanyProfileLearningSubjectKind,
  CompanyProfileStableKeyInput,
} from "./company-profile";
import {
  PREFERENCE_REGISTRY_CONTENT_MAX_CHARS,
  PREFERENCE_REGISTRY_DESCRIPTOR_DESCRIPTION_MAX_CHARS,
  PREFERENCE_REGISTRY_REASON_MAX_CHARS,
  PREFERENCE_REGISTRY_TITLE_MAX_CHARS,
  PreferenceRegistryConflictStrategy,
  PreferenceRegistryScope,
  PreferenceRegistryStableKey,
  normalizePreferenceRegistryStableKey,
} from "./preference-registry";
import {
  WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS,
  WorkspaceInstructionPolicyTarget,
} from "./workspace-instruction-policies";

export const DURABLE_LEARNING_INPUT_MAX_UTF8_BYTES = 524_288;

export const DurableLearningExecutionAuthority = z.object({
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  sessionId: z.string().uuid(),
  turnId: z.string().uuid(),
  attemptId: z.string().uuid(),
  executionGeneration: z.number().int().positive().max(2_147_483_647),
});
export type DurableLearningExecutionAuthority = z.infer<typeof DurableLearningExecutionAuthority>;

const CompanyProfileLearningSubject = z
  .object({
    kind: CompanyProfileLearningSubjectKind,
    content: z.string().trim().min(1).max(COMPANY_PROFILE_SCALAR_MAX_CHARS),
    stableKey: CompanyProfileStableKeyInput.nullable(),
  })
  .superRefine((value, context) => {
    const repeatable = [
      "company_product",
      "company_customer",
      "company_goal",
      "company_constraint",
    ].includes(value.kind);
    if (repeatable && value.stableKey === null) {
      context.addIssue({
        code: "custom",
        path: ["stableKey"],
        message: "repeatable company-profile subjects require a stable key",
      });
    }
    if (!repeatable && value.stableKey !== null) {
      context.addIssue({
        code: "custom",
        path: ["stableKey"],
        message: "scalar company-profile subjects must not have a stable key",
      });
    }
    if (repeatable && value.content.length > COMPANY_PROFILE_ENTRY_MAX_CHARS) {
      context.addIssue({
        code: "too_big",
        origin: "string",
        maximum: COMPANY_PROFILE_ENTRY_MAX_CHARS,
        inclusive: true,
        path: ["content"],
        message: "company-profile entry content is too long",
      });
    }
  });

const WorkspaceInstructionLearningSubject = z.object({
  kind: z.literal("workspace_instruction"),
  target: WorkspaceInstructionPolicyTarget,
  content: z
    .string()
    .min(1)
    .max(WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS)
    .refine((value) => value.trim().length > 0, "workspace instructions must not be blank"),
});

const preferenceRevisionInput = {
  title: z.string().trim().min(1).max(PREFERENCE_REGISTRY_TITLE_MAX_CHARS),
  description: z.string().trim().min(1).max(PREFERENCE_REGISTRY_DESCRIPTOR_DESCRIPTION_MAX_CHARS),
  content: z
    .string()
    .min(1)
    .max(PREFERENCE_REGISTRY_CONTENT_MAX_CHARS)
    .refine((value) => value.trim().length > 0, "preference content must not be blank"),
  precedenceRank: z.number().int().min(-1_000).max(1_000).default(0),
  conflictStrategy: PreferenceRegistryConflictStrategy.default("override"),
  conflictsWith: z
    .array(
      z.string().transform(normalizePreferenceRegistryStableKey).pipe(PreferenceRegistryStableKey),
    )
    .max(32)
    .default([]),
  expiresAt: z.string().datetime({ offset: true }).nullable().default(null),
};

const PreferenceCreateLearningSubject = z.object({
  kind: z.literal("preference"),
  action: z.literal("create"),
  scope: PreferenceRegistryScope,
  stableKey: z
    .string()
    .transform(normalizePreferenceRegistryStableKey)
    .pipe(PreferenceRegistryStableKey),
  ...preferenceRevisionInput,
});

const PreferenceCorrectLearningSubject = z.object({
  kind: z.literal("preference"),
  action: z.literal("correct"),
  scope: PreferenceRegistryScope,
  preferenceId: z.string().uuid(),
  expectedCurrentRevisionId: z.string().uuid(),
  expectedScopeVersion: z.number().int().positive(),
  ...preferenceRevisionInput,
  reason: z.string().trim().min(1).max(PREFERENCE_REGISTRY_REASON_MAX_CHARS),
});

export const DurableLearningSubject = z.union([
  CompanyProfileLearningSubject,
  WorkspaceInstructionLearningSubject,
  PreferenceCreateLearningSubject,
  PreferenceCorrectLearningSubject,
]);
export type DurableLearningSubject = z.infer<typeof DurableLearningSubject>;

export const DurableLearningWriteRequest = z
  .object({
    operationId: z.string().uuid(),
    authority: DurableLearningExecutionAuthority,
    confirmation: z.object({ state: z.literal("confirmed") }),
    activation: z.enum(["active", "proposal"]),
    subject: DurableLearningSubject,
  })
  .superRefine((value, context) => {
    if (
      value.subject.kind === "preference" &&
      value.subject.action === "correct" &&
      value.activation !== "active"
    ) {
      context.addIssue({
        code: "custom",
        path: ["activation"],
        message: "preference corrections must use active authority",
      });
    }
  });
export type DurableLearningWriteRequest = z.infer<typeof DurableLearningWriteRequest>;

export const DurableLearningRollbackRequest = z.object({
  operationId: z.string().uuid(),
  authority: DurableLearningExecutionAuthority,
  confirmation: z.object({ state: z.literal("confirmed") }),
  targetAttemptId: z.string().uuid(),
  rollbackToken: z.string().min(1).max(2_048),
  reason: z.string().trim().min(1).max(4_096),
});
export type DurableLearningRollbackRequest = z.infer<typeof DurableLearningRollbackRequest>;

export const DurableLearningScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("organization") }),
  z.object({ kind: z.literal("workspace") }),
  z.object({ kind: z.literal("user") }),
]);
export type DurableLearningScope = z.infer<typeof DurableLearningScope>;

export const DurableLearningRouteDecision = z.object({
  disposition: z.literal("route"),
  destination: z.enum(["company_profile", "workspace_instruction_policy", "preference_registry"]),
  scope: DurableLearningScope,
  authority: z.enum(["active", "proposal"]),
});
export type DurableLearningRouteDecision = z.infer<typeof DurableLearningRouteDecision>;

export const DurableLearningResource = z.object({
  surface: z.enum(["company_profile", "workspace_instruction_policy", "preference_registry"]),
  id: z.string().uuid(),
  version: z.string().min(1).max(128).nullable(),
  status: z.string().min(1).max(64),
});
export type DurableLearningResource = z.infer<typeof DurableLearningResource>;

export const DurableLearningRollbackReceipt = z.object({
  supported: z.boolean(),
  targetAttemptId: z.string().uuid().nullable(),
  token: z.string().min(1).max(2_048).nullable(),
});
export type DurableLearningRollbackReceipt = z.infer<typeof DurableLearningRollbackReceipt>;

export const DurableLearningAttemptReceipt = z.object({
  attemptId: z.string().uuid(),
  inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  operation: z.enum(["write", "rollback"]),
  outcome: z.enum(["applied", "proposed", "rolled_back"]),
  resource: DurableLearningResource.nullable(),
  effectiveBoundary: z.literal("next_accepted_attempt"),
  rollback: DurableLearningRollbackReceipt,
  createdAt: z.string().datetime(),
});
export type DurableLearningAttemptReceipt = z.infer<typeof DurableLearningAttemptReceipt>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

export function canonicalDurableLearningInput(value: unknown): string {
  const canonical = JSON.stringify(canonicalize(value));
  const bytes = new TextEncoder().encode(canonical).byteLength;
  if (bytes > DURABLE_LEARNING_INPUT_MAX_UTF8_BYTES) {
    throw new Error(
      `durable-learning input is ${bytes} UTF-8 bytes; limit is ${DURABLE_LEARNING_INPUT_MAX_UTF8_BYTES}`,
    );
  }
  return canonical;
}
