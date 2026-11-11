import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";

export const FeedbackSentiment = /* @__PURE__ */ defineSchema(() =>
  z.enum(["positive", "negative"]),
);
export type FeedbackSentiment = z.infer<typeof FeedbackSentiment>;

/** Screenshots one report may carry, and the largest one accepted. */
export const FEEDBACK_SCREENSHOT_MAX_COUNT = 3;
export const FEEDBACK_SCREENSHOT_MAX_BYTES = 3 * 1024 * 1024;
export const FEEDBACK_RECENT_ERRORS_MAX = 10;
export const FEEDBACK_RECENT_REQUESTS_MAX = 20;
export const FEEDBACK_RECENT_EXCEPTIONS_MAX = 10;
export const FEEDBACK_BREADCRUMBS_MAX = 30;

export const FeedbackScreenshotContentType = /* @__PURE__ */ defineSchema(() =>
  z.enum(["image/jpeg", "image/png"]),
);
export type FeedbackScreenshotContentType = z.infer<typeof FeedbackScreenshotContentType>;

/** A screenshot sent with a report: the image bytes, base64-encoded. */
export const FeedbackScreenshotUpload = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      contentType: FeedbackScreenshotContentType,
      base64: z
        .string()
        .min(1)
        .max(Math.ceil(FEEDBACK_SCREENSHOT_MAX_BYTES / 3) * 4)
        .regex(/^[A-Za-z0-9+/]+={0,2}$/, "Screenshot must be base64"),
    })
    .strict(),
);
export type FeedbackScreenshotUpload = z.infer<typeof FeedbackScreenshotUpload>;

/** A stored screenshot. Its bytes are read separately by index. */
export const FeedbackScreenshot = /* @__PURE__ */ defineSchema(() =>
  z.object({
    index: z.number().int().nonnegative(),
    contentType: FeedbackScreenshotContentType,
    sizeBytes: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
);
export type FeedbackScreenshot = z.infer<typeof FeedbackScreenshot>;

/** An error the person saw shortly before reporting, as the app showed it. */
export const FeedbackRecentError = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      at: z.string().datetime(),
      title: z.string().max(200).optional(),
      message: z.string().min(1).max(1000),
      code: z.string().max(120).optional(),
      status: z.number().int().min(0).max(999).optional(),
      screen: z.string().max(500).optional(),
    })
    .strict(),
);
export type FeedbackRecentError = z.infer<typeof FeedbackRecentError>;

/**
 * One of the app's latest API requests. The path never carries a query string;
 * correlationId is the server's request reference, which finds its logs.
 */
export const FeedbackRecentRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      at: z.string().datetime(),
      method: z.string().regex(/^[A-Z]{1,10}$/),
      path: z.string().min(1).max(300),
      /** 0 when no response arrived (offline, aborted, timed out). */
      status: z.number().int().min(0).max(999),
      durationMs: z.number().int().min(0).max(86_400_000),
      correlationId: z.string().max(128).optional(),
    })
    .strict(),
);
export type FeedbackRecentRequest = z.infer<typeof FeedbackRecentRequest>;

/**
 * Something that broke in the app without the person necessarily seeing it:
 * an uncaught error, an unhandled promise rejection, or an image or file that
 * failed to load (source is then its address, without a query string).
 */
export const FeedbackRecentException = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      at: z.string().datetime(),
      kind: z.enum(["error", "unhandled_rejection", "resource"]),
      message: z.string().min(1).max(1000),
      stack: z.string().max(4000).optional(),
      source: z.string().max(500).optional(),
    })
    .strict(),
);
export type FeedbackRecentException = z.infer<typeof FeedbackRecentException>;

/** A step the person took before reporting: a screen they opened, the app going to the background, the network dropping. */
export const FeedbackBreadcrumb = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      at: z.string().datetime(),
      kind: z.enum(["navigation", "lifecycle", "network"]),
      label: z.string().min(1).max(200),
    })
    .strict(),
);
export type FeedbackBreadcrumb = z.infer<typeof FeedbackBreadcrumb>;

/**
 * Facts about the app and device a report came from, so it can be reproduced
 * without asking. Every field but source is optional; clients send what they know.
 */
export const FeedbackContext = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      source: z.enum(["web", "desktop", "mobile"]),
      /** How the person opened the report: a menu item, or shaking the phone. */
      trigger: z.enum(["menu", "shake"]).optional(),
      platform: z.string().max(32).optional(),
      appVersion: z.string().max(64).optional(),
      buildNumber: z.string().max(64).optional(),
      osVersion: z.string().max(64).optional(),
      deviceModel: z.string().max(120).optional(),
      /** The screen in view, as an app path such as /session/<id>. */
      screen: z.string().max(500).optional(),
      /**
       * The chat in view when the report was sent. Unlike the request's
       * sessionId it does not make the report about that chat; the server
       * records the chat's state with the report when the author can read it.
       */
      sessionId: primitives.uuid.optional(),
      locale: z.string().max(35).optional(),
      timeZone: z.string().max(64).optional(),
      online: z.boolean().optional(),
      recentErrors: z.array(FeedbackRecentError).max(FEEDBACK_RECENT_ERRORS_MAX).optional(),
      recentRequests: z.array(FeedbackRecentRequest).max(FEEDBACK_RECENT_REQUESTS_MAX).optional(),
      recentExceptions: z
        .array(FeedbackRecentException)
        .max(FEEDBACK_RECENT_EXCEPTIONS_MAX)
        .optional(),
      breadcrumbs: z.array(FeedbackBreadcrumb).max(FEEDBACK_BREADCRUMBS_MAX).optional(),
    })
    .strict(),
);
export type FeedbackContext = z.infer<typeof FeedbackContext>;

/** A new key means a new submission; retry the same payload with the same key. */
export const CreateFeedbackRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      idempotencyKey: primitives.uuid,
      sessionId: primitives.optionalUuid,
      turnId: primitives.optionalUuid,
      sentiment: FeedbackSentiment.optional(),
      comment: z.string().max(4000).optional(),
      context: FeedbackContext.optional(),
      screenshots: z.array(FeedbackScreenshotUpload).max(FEEDBACK_SCREENSHOT_MAX_COUNT).optional(),
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
    context: FeedbackContext.nullable(),
    screenshots: z.array(FeedbackScreenshot),
    createdAt: primitives.dateTime,
  }),
);
export type Feedback = z.infer<typeof Feedback>;
export const FeedbackSubmissionResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ feedback: Feedback, replayed: primitives.boolean }),
);
export type FeedbackSubmissionResponse = z.infer<typeof FeedbackSubmissionResponse>;
