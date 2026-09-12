import { z } from "zod";
import { AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_MAX_CHARS } from "./agent-authored-durable-text";
import { KnowledgeEntryEvidence } from "./knowledge-entries";
import { WorkspaceInstructionPolicyTarget } from "./workspace-instruction-policies";

export const AgentInstructionEditMode = z.enum(["append", "edit", "replace"]);
export type AgentInstructionEditMode = z.infer<typeof AgentInstructionEditMode>;

export const AgentInstructionSaveRequest = z
  .object({
    operationId: z.uuid(),
    target: WorkspaceInstructionPolicyTarget,
    editMode: AgentInstructionEditMode,
    content: z.string().max(AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_MAX_CHARS).optional(),
    oldText: z.string().min(1).max(AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_MAX_CHARS).optional(),
    newText: z.string().max(AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_MAX_CHARS).optional(),
    expectedCurrentRevisionId: z.uuid().nullable(),
    expectedActivationVersion: z.number().int().nonnegative(),
    evidence: z.array(KnowledgeEntryEvidence).max(32).default([]),
    reason: z.string().min(1).max(4096),
  })
  .superRefine((value, context) => {
    if (value.editMode === "edit") {
      if (value.oldText === undefined) {
        context.addIssue({
          code: "custom",
          path: ["oldText"],
          message: "An exact edit requires oldText",
        });
      }
      if (value.newText === undefined) {
        context.addIssue({
          code: "custom",
          path: ["newText"],
          message: "An exact edit requires newText (use an empty string to remove the text)",
        });
      }
      if (value.content !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["content"],
          message: "An exact edit uses oldText and newText, not content",
        });
      }
      return;
    }
    if (value.content === undefined || value.content.trim().length === 0) {
      context.addIssue({
        code: "custom",
        path: ["content"],
        message: "Append and replace changes require non-empty content",
      });
    }
    if (value.oldText !== undefined || value.newText !== undefined) {
      context.addIssue({
        code: "custom",
        path: [value.oldText !== undefined ? "oldText" : "newText"],
        message: "Append and replace changes use content, not oldText or newText",
      });
    }
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
