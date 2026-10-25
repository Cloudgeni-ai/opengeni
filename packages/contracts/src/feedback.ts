import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";

export const FeedbackSentiment = /* @__PURE__ */ defineSchema(() =>
  z.enum(["positive", "negative"]),
);
export type FeedbackSentiment = z.infer<typeof FeedbackSentiment>;

/** A new key means a new submission; retry the same payload with the same key. */
export const CreateFeedbackRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      idempotencyKey: primitives.uuid,
      sessionId: primitives.optionalUuid,
      turnId: primitives.optionalUuid,
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
        ctx.addIssue({
          code: "custom",
          path: ["comment"],
          message: "Provide a rating or a comment",
        });
    }),
);
export type CreateFeedbackRequest = z.infer<typeof CreateFeedbackRequest>;

export const Feedback = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid,
    workspaceId: primitives.uuid,
    subjectId: primitives.string,
    principalKind: primitives.nullableString,
    sessionId: primitives.nullableUuid,
    turnId: primitives.nullableUuid,
    sentiment: FeedbackSentiment.nullable(),
    comment: primitives.nullableString,
    createdAt: primitives.dateTime,
  }),
);
export type Feedback = z.infer<typeof Feedback>;
export const FeedbackSubmissionResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ feedback: Feedback, replayed: primitives.boolean }),
);
export type FeedbackSubmissionResponse = z.infer<typeof FeedbackSubmissionResponse>;
