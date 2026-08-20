import { z } from "zod";

import { WorkspaceStateKnowledge } from "./workspace-state";

export const COMPANY_BRAIN_OKF_SCHEMA_VERSION = 1 as const;
export const COMPANY_BRAIN_GUIDANCE_MAX_ENTRIES = 512;
export const COMPANY_BRAIN_GUIDANCE_CONTENT_MAX_CHARS = 262_144;
export const COMPANY_BRAIN_GUIDANCE_MAX_CONTENT_BYTES = 4 * 1024 * 1024;
export const COMPANY_BRAIN_INSPECTOR_DEFAULT_LIMIT = 20;
export const COMPANY_BRAIN_INSPECTOR_MAX_LIMIT = 50;
export const COMPANY_BRAIN_INSPECTOR_CURSOR_MAX_CHARS = 1_024;
export const COMPANY_BRAIN_PROPOSAL_CONTENT_MAX_BYTES = 16 * 1_024;
export const COMPANY_BRAIN_PROPOSAL_RESPONSE_MAX_BYTES = 64 * 1_024;

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;
const boundedUtf8 = (maxBytes: number) =>
  z.string().superRefine((value, context) => {
    if (utf8Bytes(value) > maxBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `must be at most ${maxBytes} UTF-8 bytes`,
      });
    }
  });

export const CompanyBrainContextReceipt = z
  .object({
    id: z.string().uuid(),
    sessionId: z.string().uuid(),
    rootSessionId: z.string().uuid(),
    turnId: z.string().uuid(),
    acceptedAt: z.string().datetime(),
    createdAt: z.string().datetime(),
    sessionRole: z.enum(["root", "child"]),
    memoryEnabled: z.boolean(),
    // Snapshots are immutable: a turn accepted before the standing block was
    // retired recorded `legacy_standing` and still reads back that way. This
    // is a historical fact about that turn, not a mode anyone can select.
    memoryPromptMode: z.enum(["legacy_standing", "retrieval_only"]),
    companyProfileIncluded: z.boolean(),
    instructionPolicyEntryHash: z.string().regex(/^[0-9a-f]{64}$/u),
    preferenceDescriptorHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .nullable(),
    companyProfileSnapshotHash: z.string().regex(/^[0-9a-f]{64}$/u),
    turnContextSnapshotId: z.string().uuid(),
    turnContextSnapshotHash: z.string().regex(/^[0-9a-f]{64}$/u),
    turnContextSnapshotSource: z.enum(["accepted_turn", "legacy_first_claim"]),
    selectionHash: z.string().regex(/^[0-9a-f]{64}$/u),
    selectedMemoryCount: z.number().int().nonnegative().max(50),
    renderedMemoryCount: z.number().int().nonnegative().max(50),
    budgetOmittedMemoryCount: z.number().int().nonnegative().max(50),
  })
  .strict();
export type CompanyBrainContextReceipt = z.infer<typeof CompanyBrainContextReceipt>;

export const CompanyBrainContextReceiptPage = z
  .object({
    receipts: z.array(CompanyBrainContextReceipt).max(COMPANY_BRAIN_INSPECTOR_MAX_LIMIT),
    nextCursor: z.string().min(1).max(COMPANY_BRAIN_INSPECTOR_CURSOR_MAX_CHARS).nullable(),
    hasMore: z.boolean(),
  })
  .strict();
export type CompanyBrainContextReceiptPage = z.infer<typeof CompanyBrainContextReceiptPage>;

export const CompanyBrainKnowledgeProposal = z
  .object({
    id: z.string().uuid(),
    authority: z.object({ kind: z.enum(["organization", "workspace", "personal"]) }).strict(),
    targetKind: z.enum(["instruction_policy", "preference"]),
    targetScope: z.string().min(1).max(96),
    targetKey: z.string().min(1).max(96).nullable(),
    content: boundedUtf8(COMPANY_BRAIN_PROPOSAL_CONTENT_MAX_BYTES),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
    source: z.object({ claimId: z.string().uuid(), evidenceId: z.string().uuid() }).strict(),
    status: z.literal("proposed"),
    createdAt: z.string().datetime(),
    projection: z
      .object({
        truncated: z.boolean(),
        originalContentUtf8Bytes: z.number().int().nonnegative().max(1_048_576),
      })
      .strict(),
  })
  .strict();
export type CompanyBrainKnowledgeProposal = z.infer<typeof CompanyBrainKnowledgeProposal>;

export const CompanyBrainKnowledgeProposalPage = z
  .object({
    proposals: z.array(CompanyBrainKnowledgeProposal).max(COMPANY_BRAIN_INSPECTOR_MAX_LIMIT),
    truncatedForCount: z.boolean(),
    truncatedForResponseBytes: z.boolean(),
    responseBytes: z.number().int().nonnegative().max(COMPANY_BRAIN_PROPOSAL_RESPONSE_MAX_BYTES),
  })
  .strict();
export type CompanyBrainKnowledgeProposalPage = z.infer<typeof CompanyBrainKnowledgeProposalPage>;

export const CompanyBrainGuidanceClassification = z.enum([
  "company_profile",
  "mandatory_rule",
  "guide",
]);
export type CompanyBrainGuidanceClassification = z.infer<typeof CompanyBrainGuidanceClassification>;

export const CompanyBrainGuidanceScope = z.enum(["organization", "workspace", "personal"]);
export type CompanyBrainGuidanceScope = z.infer<typeof CompanyBrainGuidanceScope>;

export const CompanyBrainGuidanceLifecycle = z.enum([
  "active",
  "proposal",
  "inactive",
  "rejected",
  "superseded",
  "expired",
  "historical",
]);
export type CompanyBrainGuidanceLifecycle = z.infer<typeof CompanyBrainGuidanceLifecycle>;

export const CompanyBrainGuidanceRelationship = z
  .object({
    type: z.enum(["corrects", "supersedes", "superseded_by"]),
    targetId: z.string().min(1).max(512),
  })
  .strict();
export type CompanyBrainGuidanceRelationship = z.infer<typeof CompanyBrainGuidanceRelationship>;

export const CompanyBrainGuidanceEntry = z
  .object({
    id: z.string().min(1).max(512),
    revisionId: z.string().uuid(),
    path: z.string().min(1).max(512),
    scope: CompanyBrainGuidanceScope,
    classification: CompanyBrainGuidanceClassification,
    title: z.string().min(1).max(160),
    description: z.string().max(512).nullable(),
    content: z.string().min(1).max(COMPANY_BRAIN_GUIDANCE_CONTENT_MAX_CHARS),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    revision: z.number().int().positive(),
    active: z.boolean(),
    lifecycle: CompanyBrainGuidanceLifecycle,
    provenance: z
      .object({
        source: z.string().min(1).max(96),
        sourceId: z.string().min(1).max(512).nullable(),
        trust: z.string().min(1).max(96).nullable(),
      })
      .strict(),
    relationships: z.array(CompanyBrainGuidanceRelationship).max(32),
    createdAt: z.string().datetime(),
  })
  .strict();
export type CompanyBrainGuidanceEntry = z.infer<typeof CompanyBrainGuidanceEntry>;

export const CompanyBrainGuidanceTruncationReason = z.enum([
  "company_profile_history",
  "instruction_policy_history",
  "preference_count",
  "preference_history",
  "aggregate_item_count",
  "aggregate_content_bytes",
]);
export type CompanyBrainGuidanceTruncationReason = z.infer<
  typeof CompanyBrainGuidanceTruncationReason
>;

export const CompanyBrainOkfPackage = z
  .object({
    kind: z.literal("opengeni.company_brain.okf"),
    schemaVersion: z.literal(COMPANY_BRAIN_OKF_SCHEMA_VERSION),
    workspaceId: z.string().uuid(),
    generatedAt: z.string().datetime(),
    permissions: z
      .object({
        guidance: z.literal("available"),
        knowledge: z.enum(["available", "unavailable"]),
      })
      .strict(),
    guidance: z
      .object({
        entries: z.array(CompanyBrainGuidanceEntry).max(COMPANY_BRAIN_GUIDANCE_MAX_ENTRIES),
        truncated: z.boolean(),
        truncationReasons: z.array(CompanyBrainGuidanceTruncationReason).max(6),
      })
      .strict(),
    knowledge: WorkspaceStateKnowledge,
    omissions: z
      .array(
        z.enum([
          "inaccessible_knowledge",
          "document_bodies_use_documents_export",
          "memory_bodies_and_provenance",
          "secret_values_and_credentials",
          "session_messages_and_task_notes",
          "policy_and_preference_actor_identifiers",
        ]),
      )
      .max(6),
  })
  .strict();
export type CompanyBrainOkfPackage = z.infer<typeof CompanyBrainOkfPackage>;
