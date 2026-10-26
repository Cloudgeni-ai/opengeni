import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";

/**
 * Read-only share links for a chat. A link shows a snapshot of the visible
 * conversation, taken when the link was created or last refreshed: the
 * person's messages and the replies shown to them, as text. Tool calls, tool
 * output, files, attachments and hidden context are never part of it.
 */

/** The most a snapshot keeps; the earliest messages are left out beyond it. */
export const SHARED_SESSION_MAX_MESSAGES = 1_000;
export const SHARED_SESSION_MAX_BYTES = 2 * 1024 * 1024;

export const SharedSessionMessage = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      role: z.enum(["user", "assistant"]),
      text: z.string(),
    })
    .strict(),
);
export type SharedSessionMessage = z.infer<typeof SharedSessionMessage>;

/** What a link stores and shows. */
export const SharedSessionSnapshot = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      messages: z.array(SharedSessionMessage).max(SHARED_SESSION_MAX_MESSAGES),
      /** Earlier messages left out to keep the snapshot within its size. */
      omittedMessageCount: primitives.nonnegativeInteger,
    })
    .strict(),
);
export type SharedSessionSnapshot = z.infer<typeof SharedSessionSnapshot>;

/** A chat's live share link, as its owner sees it. */
export const SessionShareLink = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      shareId: primitives.nonEmptyString,
      /** The page anyone with the link opens. */
      url: z.string().url(),
      workspaceId: primitives.uuid,
      sessionId: primitives.uuid,
      title: z.string(),
      /** Messages the link shows. */
      messageCount: primitives.nonnegativeInteger,
      createdAt: primitives.dateTime,
      /** When the snapshot was last taken. */
      updatedAt: primitives.dateTime,
    })
    .strict(),
);
export type SessionShareLink = z.infer<typeof SessionShareLink>;

/** A chat's sharing state for the person asking: whether they can share it, and their live link. */
export const SessionShareLinkState = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      /** False when this deployment has turned share links off. */
      enabled: z.boolean(),
      link: SessionShareLink.nullable(),
    })
    .strict(),
);
export type SessionShareLinkState = z.infer<typeof SessionShareLinkState>;

export const SessionShareLinkList = /* @__PURE__ */ defineSchema(() =>
  z.object({ links: z.array(SessionShareLink) }).strict(),
);
export type SessionShareLinkList = z.infer<typeof SessionShareLinkList>;

/** What anyone holding a link reads, without signing in. */
export const SharedSession = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      title: z.string(),
      /** When the snapshot was taken. */
      sharedAt: primitives.dateTime,
      messages: z.array(SharedSessionMessage),
      omittedMessageCount: primitives.nonnegativeInteger,
    })
    .strict(),
);
export type SharedSession = z.infer<typeof SharedSession>;
