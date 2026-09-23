import { SkillWriteReceipt, type SkillReviewReference } from "@opengeni/contracts";
import type { SessionEvent } from "@opengeni/sdk";

function receiptFromOutput(value: unknown, depth = 0): SkillWriteReceipt | null {
  if (depth > 4) return null;
  if (typeof value === "string") {
    try {
      return receiptFromOutput(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const output = value as Record<string, unknown>;
  if (output.isError === true) return null;
  const receipt = SkillWriteReceipt.safeParse(output);
  if (receipt.success) return receipt.data;
  if (output.structuredContent) return receiptFromOutput(output.structuredContent, depth + 1);
  if (Array.isArray(output.content)) {
    for (const block of output.content) {
      if (block?.type !== "text") continue;
      const parsed = receiptFromOutput(block.text, depth + 1);
      if (parsed) return parsed;
    }
  }
  return null;
}

/** Receipts are discovery hints, never approval authority. The UI re-reads exact files. */
export function sessionSkillReviews(events: readonly SessionEvent[]): SkillReviewReference[] {
  const reviews = new Map<string, SkillReviewReference>();
  for (const event of events) {
    if (event.type !== "agent.toolCall.output") continue;
    if (!event.payload || typeof event.payload !== "object") continue;
    const receipt = receiptFromOutput((event.payload as Record<string, unknown>).output);
    if (!receipt?.skillReview || receipt.outcome !== "pending" || receipt.decision === "rejected")
      continue;
    const reference = receipt.skillReview;
    if (
      reference.sourceOperationId !== receipt.operationId ||
      reference.skillId !== receipt.skillId ||
      reference.revisionId !== receipt.revisionId
    )
      continue;
    reviews.set(reference.revisionId, reference);
  }
  return [...reviews.values()];
}
