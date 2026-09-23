import { z } from "zod";

export const FeedbackSentiment = z.enum(["positive", "negative"]);
export type FeedbackSentiment = z.infer<typeof FeedbackSentiment>;

/** A new key means a new submission; retry the same payload with the same key. */
export const CreateFeedbackRequest = z
  .object({
    idempotencyKey: z.string().uuid(),
    sessionId: z.string().uuid().optional(),
    turnId: z.string().uuid().optional(),
    sentiment: FeedbackSentiment.optional(),
    comment: z.string().max(4000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.turnId && !value.sessionId)
      ctx.addIssue({ code: "custom", path: ["turnId"], message: "turnId requires sessionId" });
    if (value.sentiment && !value.sessionId)
      ctx.addIssue({ code: "custom", path: ["sentiment"], message: "Ratings require a session" });
    if (!value.sentiment && !value.comment?.trim())
      ctx.addIssue({ code: "custom", path: ["comment"], message: "Provide a rating or a comment" });
  });
export type CreateFeedbackRequest = z.infer<typeof CreateFeedbackRequest>;

export const Feedback = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  subjectId: z.string(),
  principalKind: z.string().nullable(),
  sessionId: z.string().uuid().nullable(),
  turnId: z.string().uuid().nullable(),
  sentiment: FeedbackSentiment.nullable(),
  comment: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type Feedback = z.infer<typeof Feedback>;
export const FeedbackSubmissionResponse = z.object({ feedback: Feedback, replayed: z.boolean() });
export type FeedbackSubmissionResponse = z.infer<typeof FeedbackSubmissionResponse>;
