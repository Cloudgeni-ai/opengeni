import { z } from "zod";
import { defineSchema } from "./define-schema";

/**
 * Occasional update messages about Slack agents: one Slack installation's
 * settings, which an organization admin changes, and the admin's own preview.
 */

export const SlackAgentUpdateSettings = /* @__PURE__ */ defineSchema(() =>
  z.object({
    connectionId: z.string().uuid(),
    /** Opengeni sends people direct messages about agents they can use. Off by default. */
    updatesEnabled: z.boolean(),
    /** Opengeni announces agents only through channel intro posts and never sends direct messages. */
    channelPostsOnly: z.boolean(),
    /** The reader is an organization admin and may change these settings. */
    viewerCanManage: z.boolean(),
    updatedAt: z.string().nullable(),
  }),
);
export type SlackAgentUpdateSettings = z.infer<typeof SlackAgentUpdateSettings>;

export const UpdateSlackAgentUpdateSettingsRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      connectionId: z.string().uuid(),
      updatesEnabled: z.boolean(),
      channelPostsOnly: z.boolean(),
    })
    .strict(),
);
export type UpdateSlackAgentUpdateSettingsRequest = z.infer<
  typeof UpdateSlackAgentUpdateSettingsRequest
>;

export const SlackAgentUpdateKind = /* @__PURE__ */ defineSchema(() =>
  z.enum(["update", "welcome", "dormant"]),
);
export type SlackAgentUpdateKind = z.infer<typeof SlackAgentUpdateKind>;

/**
 * Send one update message to yourself now, through your own linked Slack
 * account. It ignores the schedule, the settings and mute, counts toward no
 * one's limits and messages no one else.
 */
export const SlackAgentUpdatePreviewRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      connectionId: z.string().uuid(),
      kind: SlackAgentUpdateKind.default("update"),
    })
    .strict(),
);
export type SlackAgentUpdatePreviewRequest = z.input<typeof SlackAgentUpdatePreviewRequest>;

export const SlackAgentUpdatePreviewResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    kind: SlackAgentUpdateKind,
    slackUserId: z.string(),
    /** Agents named in the message. */
    agentIds: z.array(z.string().uuid()),
  }),
);
export type SlackAgentUpdatePreviewResponse = z.infer<typeof SlackAgentUpdatePreviewResponse>;
