import { z } from "zod";

/**
 * Request bodies for subscription account actions (Codex, Claude, SuperGrok):
 * renaming, pausing, rotation, extra credits and device sign-in. The routes
 * validate with these, and the agent action catalog shows them as the input.
 */

/** Rename an account. An empty or null label goes back to the account's email. */
export const SubscriptionAccountRenameRequest = z.object({
  label: z.string().trim().max(200).nullable(),
});
export type SubscriptionAccountRenameRequest = z.infer<typeof SubscriptionAccountRenameRequest>;

/**
 * Turn one account setting on or off: "used for new work" (allocator) or extra
 * credits. expectedVersion is the account's current allocatorVersion or
 * extraCreditsVersion; a stale version is refused so concurrent edits don't clash.
 */
export const SubscriptionAccountToggleRequest = z.object({
  enabled: z.boolean(),
  expectedVersion: z.number().int().positive(),
});
export type SubscriptionAccountToggleRequest = z.infer<typeof SubscriptionAccountToggleRequest>;

/** Account picking: true spreads work across every usable account, false uses the primary one only. */
export const SubscriptionRotationSettingsRequest = z.object({
  rotationEnabled: z.boolean(),
});
export type SubscriptionRotationSettingsRequest = z.infer<
  typeof SubscriptionRotationSettingsRequest
>;

/** Check a device sign-in with the state returned by its connect/start call. */
export const SubscriptionConnectPollRequest = z.object({
  state: z.string().min(1).max(16_384),
});
export type SubscriptionConnectPollRequest = z.infer<typeof SubscriptionConnectPollRequest>;

/** Where a workspace SuperGrok sign-in lands: the shared workspace pool or only the person. */
export const SupergrokConnectStartRequest = z.object({
  scope: z.enum(["workspace", "user"]).default("workspace"),
});
export type SupergrokConnectStartRequest = z.infer<typeof SupergrokConnectStartRequest>;

/**
 * Which Codex accounts a workspace uses: automatic (Opengeni picks from the
 * workspace's and the organization's accounts), only the workspace's own, only
 * the organization's, or none (Codex off for the workspace).
 */
export const CodexSourceRequest = z.object({
  mode: z.enum(["automatic", "workspace", "organization", "disabled"]),
});
export type CodexSourceRequest = z.infer<typeof CodexSourceRequest>;

/** Choose the Codex account that serves Codex Apps; expectedVersion is the current designation version. */
export const CodexAppsDesignationRequest = z.object({
  accountId: z.string().uuid(),
  expectedVersion: z.number().int().nonnegative(),
});
export type CodexAppsDesignationRequest = z.infer<typeof CodexAppsDesignationRequest>;

/** Pin one chat to a Codex account by id, or "auto" to let Opengeni pick again. */
export const SessionCodexAccountPinRequest = z.object({
  target: z.string().min(1).describe('"auto" or a Codex account id'),
});
export type SessionCodexAccountPinRequest = z.infer<typeof SessionCodexAccountPinRequest>;
