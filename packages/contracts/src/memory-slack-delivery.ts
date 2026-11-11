import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";

export const MemorySlackImportance = /* @__PURE__ */ defineSchema(() =>
  z.enum(["major", "normal", "minor"]),
);
export type MemorySlackImportance = z.infer<typeof MemorySlackImportance>;

export const MemorySlackRequestedMode = /* @__PURE__ */ defineSchema(() =>
  z.enum(["auto", "review", "never"]),
);
export type MemorySlackRequestedMode = z.infer<typeof MemorySlackRequestedMode>;

export const MemorySlackPublicationDistribution = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      importance: MemorySlackImportance,
      audience: z.literal("workspace"),
      slackMode: MemorySlackRequestedMode,
      shareSummary: primitives.string.trim().min(1).max(4_096),
    })
    .strict(),
);
export type MemorySlackPublicationDistribution = z.infer<typeof MemorySlackPublicationDistribution>;

export const MemorySlackPublicationConfiguration = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid,
    workspaceId: primitives.uuid,
    revision: primitives.positiveInteger,
    enabled: primitives.boolean,
    connectionId: primitives.nullableUuid,
    slackTeamId: z.string().min(1).max(64).nullable(),
    slackChannelId: z.string().min(1).max(64).nullable(),
    slackChannelName: z.string().min(1).max(256).nullable(),
    autoImportances: z.array(MemorySlackImportance).max(3),
    reviewImportances: z.array(MemorySlackImportance).max(3),
    createdBySubjectId: z.string().min(1).max(1_024),
    createdAt: primitives.string,
  }),
);
export type MemorySlackPublicationConfiguration = z.infer<
  typeof MemorySlackPublicationConfiguration
>;

export const UpdateMemorySlackPublicationConfigurationRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      expectedRevision: primitives.nonnegativeInteger,
      enabled: primitives.boolean,
      connectionId: primitives.nullableUuid,
      slackChannelId: primitives.string.trim().min(1).max(64).nullable(),
      slackChannelName: primitives.string.trim().min(1).max(256).nullable(),
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
    }),
);
export type UpdateMemorySlackPublicationConfigurationRequest = z.infer<
  typeof UpdateMemorySlackPublicationConfigurationRequest
>;

export const MemorySlackPublicationConfigurationResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    current: MemorySlackPublicationConfiguration.nullable(),
    history: z.array(MemorySlackPublicationConfiguration).max(100),
  }),
);
export type MemorySlackPublicationConfigurationResponse = z.infer<
  typeof MemorySlackPublicationConfigurationResponse
>;

export const MemorySlackPublicationState = /* @__PURE__ */ defineSchema(() =>
  z.enum([
    "review_pending",
    "queued",
    "delivering",
    "retry_wait",
    "delivered",
    "rejected",
    "failed",
    "cancelled",
  ]),
);
export type MemorySlackPublicationState = z.infer<typeof MemorySlackPublicationState>;

export const MemorySlackPublicationReceiptKind = /* @__PURE__ */ defineSchema(() =>
  z.enum([
    "enqueued",
    "review_approved",
    "review_rejected",
    "delivery_claimed",
    "retry_scheduled",
    "delivered",
    "failed",
    "cancelled",
    "manual_retry",
  ]),
);
export type MemorySlackPublicationReceiptKind = z.infer<typeof MemorySlackPublicationReceiptKind>;

export const MemorySlackPublicationReceipt = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid,
    publicationId: primitives.uuid,
    sequence: primitives.positiveInteger,
    kind: MemorySlackPublicationReceiptKind,
    state: MemorySlackPublicationState,
    attemptNumber: primitives.nonnegativeInteger,
    actorKind: z.enum(["human", "agent", "service"]),
    actorSubjectId: z.string().min(1).max(1_024),
    operationId: primitives.uuid,
    errorCode: z.string().min(1).max(128).nullable(),
    retryAt: primitives.nullableString,
    slackChannelId: z.string().min(1).max(64).nullable(),
    slackMessageTimestamp: z.string().min(1).max(64).nullable(),
    createdAt: primitives.string,
  }),
);
export type MemorySlackPublicationReceipt = z.infer<typeof MemorySlackPublicationReceipt>;

export const MemorySlackPublication = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid,
    workspaceId: primitives.uuid,
    configurationRevision: primitives.positiveInteger,
    connectionId: primitives.uuid,
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
    attemptCount: primitives.nonnegativeInteger,
    retryAt: primitives.nullableString,
    lastErrorCode: z.string().min(1).max(128).nullable(),
    slackMessageTimestamp: z.string().min(1).max(64).nullable(),
    deliveredAt: primitives.nullableString,
    terminalAt: primitives.nullableString,
    createdAt: primitives.string,
    updatedAt: primitives.string,
    receipts: z.array(MemorySlackPublicationReceipt).max(100),
  }),
);
export type MemorySlackPublication = z.infer<typeof MemorySlackPublication>;

export const MemorySlackPublicationHistoryResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    publications: z.array(MemorySlackPublication).max(100),
    nextCursor: primitives.nullableUuid,
  }),
);
export type MemorySlackPublicationHistoryResponse = z.infer<
  typeof MemorySlackPublicationHistoryResponse
>;

export const MemorySlackPublicationActionRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      action: z.enum(["approve", "reject", "retry"]),
      expectedState: MemorySlackPublicationState,
    })
    .strict(),
);
export type MemorySlackPublicationActionRequest = z.infer<
  typeof MemorySlackPublicationActionRequest
>;

export const SlackPublicationChannel = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(256).nullable(),
    isPrivate: primitives.boolean,
  }),
);
export type SlackPublicationChannel = z.infer<typeof SlackPublicationChannel>;

export const SlackPublicationChannelListResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    channels: z.array(SlackPublicationChannel).max(200),
    nextCursor: z.string().max(1_024).nullable(),
  }),
);
export type SlackPublicationChannelListResponse = z.infer<
  typeof SlackPublicationChannelListResponse
>;
