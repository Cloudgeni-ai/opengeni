import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";

/**
 * Request bodies for subscription account actions (Codex, Claude, SuperGrok):
 * renaming, pausing, rotation, extra credits and device sign-in. The routes
 * validate with these, and the agent action catalog shows them as the input.
 */

/** Rename an account. An empty or null label goes back to the account's email. */
export const SubscriptionAccountRenameRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    label: primitives.string.trim().max(200).nullable(),
  }),
);
export type SubscriptionAccountRenameRequest = z.infer<typeof SubscriptionAccountRenameRequest>;

/**
 * Turn one account setting on or off: "used for new work" (allocator) or extra
 * credits. expectedVersion is the account's current allocatorVersion or
 * extraCreditsVersion; a stale version is refused so concurrent edits don't clash.
 */
export const SubscriptionAccountToggleRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    enabled: primitives.boolean,
    expectedVersion: primitives.positiveInteger,
  }),
);
export type SubscriptionAccountToggleRequest = z.infer<typeof SubscriptionAccountToggleRequest>;

/** Account picking: true spreads work across every usable account, false uses the primary one only. */
export const SubscriptionRotationSettingsRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    rotationEnabled: primitives.boolean,
  }),
);
export type SubscriptionRotationSettingsRequest = z.infer<
  typeof SubscriptionRotationSettingsRequest
>;

/** Check a device sign-in with the state returned by its connect/start call. */
export const SubscriptionConnectPollRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    state: z.string().min(1).max(16_384),
  }),
);
export type SubscriptionConnectPollRequest = z.infer<typeof SubscriptionConnectPollRequest>;

/** Where a workspace SuperGrok sign-in lands: the shared workspace pool or only the person. */
export const SupergrokConnectStartRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    scope: z.enum(["workspace", "user"]).default("workspace"),
  }),
);
export type SupergrokConnectStartRequest = z.infer<typeof SupergrokConnectStartRequest>;

/**
 * A started device sign-in (Codex or SuperGrok): the person enters userCode at
 * verificationUri (or opens verificationUriComplete), then the caller polls
 * connect/poll with state every intervalSeconds.
 */
export const SubscriptionDeviceSignInStart = /* @__PURE__ */ defineSchema(() =>
  z.object({
    userCode: primitives.string,
    verificationUri: primitives.string,
    verificationUriComplete: primitives.string.nullable().optional(),
    intervalSeconds: primitives.positiveInteger,
    expiresInSeconds: primitives.positiveInteger.optional(),
    scope: z.enum(["workspace", "user", "organization"]).optional(),
    state: primitives.string,
  }),
);
export type SubscriptionDeviceSignInStart = z.infer<typeof SubscriptionDeviceSignInStart>;

/**
 * Which Codex accounts a workspace uses: automatic (Opengeni picks from the
 * workspace's and the organization's accounts), only the workspace's own, only
 * the organization's, or none (Codex off for the workspace).
 */
export const CodexSourceRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    mode: z.enum(["automatic", "workspace", "organization", "disabled"]),
  }),
);
export type CodexSourceRequest = z.infer<typeof CodexSourceRequest>;

/** Choose the Codex account that serves Codex Apps; expectedVersion is the current designation version. */
export const CodexAppsDesignationRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    accountId: primitives.uuid,
    expectedVersion: primitives.nonnegativeInteger,
  }),
);
export type CodexAppsDesignationRequest = z.infer<typeof CodexAppsDesignationRequest>;

/** Pin one chat to a Codex account by id, or "auto" to let Opengeni pick again. */
export const SessionCodexAccountPinRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    target: primitives.nonEmptyString.describe('"auto" or a Codex account id'),
  }),
);
export type SessionCodexAccountPinRequest = z.infer<typeof SessionCodexAccountPinRequest>;
