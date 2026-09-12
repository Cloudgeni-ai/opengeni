import { z } from "zod";
import { KnowledgeEntryEvidence } from "./knowledge-entries";
import { WorkspaceInstructionPolicyTarget } from "./workspace-instruction-policies";

export const AgentInstructionSaveRequest = z
  .object({
    operationId: z.uuid(),
    target: WorkspaceInstructionPolicyTarget,
    content: z
      .string()
      .min(1)
      .max(600)
      .refine((value) => value.trim().length > 0, "Instruction content is empty"),
    expectedCurrentRevisionId: z.uuid().nullable(),
    expectedActivationVersion: z.number().int().nonnegative(),
    evidence: z.array(KnowledgeEntryEvidence).max(32).default([]),
    reason: z.string().min(1).max(4096),
  })
  .strict();
export type AgentInstructionSaveRequest = z.input<typeof AgentInstructionSaveRequest>;

export const AgentInstructionReviewRequest = z
  .object({
    operationId: z.uuid(),
    revisionId: z.uuid(),
    decision: z.enum(["approve", "reject"]),
    reason: z.string().min(1).max(4096),
  })
  .strict();
export type AgentInstructionReviewRequest = z.infer<typeof AgentInstructionReviewRequest>;

export const AgentInstructionReceipt = z.object({
  operationId: z.uuid(),
  revisionId: z.uuid(),
  outcome: z.enum(["published", "pending", "rejected"]),
  reviewBatchId: z.uuid().nullable(),
  replayed: z.boolean(),
});
export type AgentInstructionReceipt = z.infer<typeof AgentInstructionReceipt>;

export const AgentInstructionReviewItem = z.object({
  revisionId: z.uuid(),
  content: z.string(),
  target: WorkspaceInstructionPolicyTarget,
  reviewBatchId: z.uuid().nullable(),
  sessionId: z.uuid().nullable(),
  reason: z.string(),
  createdAt: z.string(),
});
export type AgentInstructionReviewItem = z.infer<typeof AgentInstructionReviewItem>;
export const AgentInstructionReviewListResponse = z.object({
  entries: z.array(AgentInstructionReviewItem),
  nextCursor: z.string().nullable(),
});
export type AgentInstructionReviewListResponse = z.infer<typeof AgentInstructionReviewListResponse>;
