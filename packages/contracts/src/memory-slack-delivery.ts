import { z } from "zod";

export const MemorySlackImportance = z.enum(["major", "normal", "minor"]);
export type MemorySlackImportance = z.infer<typeof MemorySlackImportance>;

export const MemorySlackRequestedMode = z.enum(["auto", "review", "never"]);
export type MemorySlackRequestedMode = z.infer<typeof MemorySlackRequestedMode>;

export const MemorySlackPublicationDistribution = z
  .object({
    importance: MemorySlackImportance,
    audience: z.literal("workspace"),
    slackMode: MemorySlackRequestedMode,
    shareSummary: z.string().trim().min(1).max(4_096),
  })
  .strict();
export type MemorySlackPublicationDistribution = z.infer<typeof MemorySlackPublicationDistribution>;

export const MemorySlackPublicationConfiguration = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  revision: z.number().int().positive(),
  enabled: z.boolean(),
  connectionId: z.string().uuid().nullable(),
  slackTeamId: z.string().min(1).max(64).nullable(),
  slackChannelId: z.string().min(1).max(64).nullable(),
  slackChannelName: z.string().min(1).max(256).nullable(),
  autoImportances: z.array(MemorySlackImportance).max(3),
  reviewImportances: z.array(MemorySlackImportance).max(3),
  createdBySubjectId: z.string().min(1).max(1_024),
  createdAt: z.string(),
});
export type MemorySlackPublicationConfiguration = z.infer<
  typeof MemorySlackPublicationConfiguration
>;

export const UpdateMemorySlackPublicationConfigurationRequest = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    enabled: z.boolean(),
    connectionId: z.string().uuid().nullable(),
    slackChannelId: z.string().trim().min(1).max(64).nullable(),
    slackChannelName: z.string().trim().min(1).max(256).nullable(),
    autoImportances: z.array(MemorySlackImportance).max(3),
    reviewImportances: z.array(MemorySlackImportance).max(3),
  })
  .strict()
  .superRefine((value, context) => {
    const overlap = value.autoImportances.filter((importance) =>
      value.reviewImportances.includes(importance),
    );
    if (overlap.length > 0) {
      context.addIssue({
        code: "custom",
        message: "auto and review importance policies must not overlap",
        path: ["reviewImportances"],
      });
    }
    if (value.enabled && (!value.connectionId || !value.slackChannelId)) {
      context.addIssue({
        code: "custom",
        message: "an enabled Slack publication configuration requires a connection and channel",
      });
    }
  });
export type UpdateMemorySlackPublicationConfigurationRequest = z.infer<
  typeof UpdateMemorySlackPublicationConfigurationRequest
>;

export const MemorySlackPublicationConfigurationResponse = z.object({
  current: MemorySlackPublicationConfiguration.nullable(),
  history: z.array(MemorySlackPublicationConfiguration).max(100),
});
export type MemorySlackPublicationConfigurationResponse = z.infer<
  typeof MemorySlackPublicationConfigurationResponse
>;

export const MemorySlackPublicationState = z.enum([
  "review_pending",
  "queued",
  "delivering",
  "retry_wait",
  "delivered",
  "rejected",
  "failed",
  "cancelled",
]);
export type MemorySlackPublicationState = z.infer<typeof MemorySlackPublicationState>;

export const MemorySlackPublicationReceiptKind = z.enum([
  "enqueued",
  "review_approved",
  "review_rejected",
  "delivery_claimed",
  "retry_scheduled",
  "delivered",
  "failed",
  "cancelled",
  "manual_retry",
]);
export type MemorySlackPublicationReceiptKind = z.infer<typeof MemorySlackPublicationReceiptKind>;

export const MemorySlackPublicationReceipt = z.object({
  id: z.string().uuid(),
  publicationId: z.string().uuid(),
  sequence: z.number().int().positive(),
  kind: MemorySlackPublicationReceiptKind,
  state: MemorySlackPublicationState,
  attemptNumber: z.number().int().nonnegative(),
  actorKind: z.enum(["human", "agent", "service"]),
  actorSubjectId: z.string().min(1).max(1_024),
  operationId: z.string().uuid(),
  errorCode: z.string().min(1).max(128).nullable(),
  retryAt: z.string().nullable(),
  slackChannelId: z.string().min(1).max(64).nullable(),
  slackMessageTimestamp: z.string().min(1).max(64).nullable(),
  createdAt: z.string(),
});
export type MemorySlackPublicationReceipt = z.infer<typeof MemorySlackPublicationReceipt>;

export const MemorySlackPublication = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  configurationRevision: z.number().int().positive(),
  connectionId: z.string().uuid(),
  slackTeamId: z.string().min(1).max(64),
  slackChannelId: z.string().min(1).max(64),
  sourceType: z.enum(["workspace_memory", "durable_learning"]),
  sourceId: z.string().min(1).max(1_024),
  sourceVersion: z.string().min(1).max(512).nullable(),
  importance: MemorySlackImportance,
  deliveryMode: z.enum(["auto", "review"]),
  state: MemorySlackPublicationState,
  summary: z.string().max(512),
  sourceLabel: z.string().max(128),
  authoritativePath: z.string().max(2_048).nullable(),
  initiatorKind: z.enum(["human", "agent", "service"]),
  initiatorSubjectId: z.string().min(1).max(1_024),
  initiatingHumanSubjectId: z.string().min(1).max(1_024).nullable(),
  attemptCount: z.number().int().nonnegative(),
  retryAt: z.string().nullable(),
  lastErrorCode: z.string().min(1).max(128).nullable(),
  slackMessageTimestamp: z.string().min(1).max(64).nullable(),
  deliveredAt: z.string().nullable(),
  terminalAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  receipts: z.array(MemorySlackPublicationReceipt).max(100),
});
export type MemorySlackPublication = z.infer<typeof MemorySlackPublication>;

export const MemorySlackPublicationHistoryResponse = z.object({
  publications: z.array(MemorySlackPublication).max(100),
  nextCursor: z.string().uuid().nullable(),
});
export type MemorySlackPublicationHistoryResponse = z.infer<
  typeof MemorySlackPublicationHistoryResponse
>;

export const MemorySlackPublicationActionRequest = z
  .object({
    action: z.enum(["approve", "reject", "retry"]),
    expectedState: MemorySlackPublicationState,
  })
  .strict();
export type MemorySlackPublicationActionRequest = z.infer<
  typeof MemorySlackPublicationActionRequest
>;

export const SlackPublicationChannel = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(256).nullable(),
  isPrivate: z.boolean(),
});
export type SlackPublicationChannel = z.infer<typeof SlackPublicationChannel>;

export const SlackPublicationChannelListResponse = z.object({
  channels: z.array(SlackPublicationChannel).max(200),
  nextCursor: z.string().max(1_024).nullable(),
});
export type SlackPublicationChannelListResponse = z.infer<
  typeof SlackPublicationChannelListResponse
>;
