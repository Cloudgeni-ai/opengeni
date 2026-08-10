export type MemorySlackImportance = "major" | "normal" | "minor";
export type MemorySlackRequestedMode = "auto" | "review" | "never";

export type MemorySlackPublicationDistribution = {
  importance: MemorySlackImportance;
  audience: "workspace";
  slackMode: MemorySlackRequestedMode;
  shareSummary: string;
};

export type MemorySlackPublicationConfiguration = {
  id: string;
  workspaceId: string;
  revision: number;
  enabled: boolean;
  connectionId: string | null;
  slackTeamId: string | null;
  slackChannelId: string | null;
  slackChannelName: string | null;
  autoImportances: MemorySlackImportance[];
  reviewImportances: MemorySlackImportance[];
  createdBySubjectId: string;
  createdAt: string;
};

export type UpdateMemorySlackPublicationConfigurationRequest = {
  expectedRevision: number;
  enabled: boolean;
  connectionId: string | null;
  slackChannelId: string | null;
  slackChannelName: string | null;
  autoImportances: MemorySlackImportance[];
  reviewImportances: MemorySlackImportance[];
};

export type MemorySlackPublicationConfigurationResponse = {
  current: MemorySlackPublicationConfiguration | null;
  history: MemorySlackPublicationConfiguration[];
};

export type MemorySlackPublicationState =
  | "review_pending"
  | "queued"
  | "delivering"
  | "retry_wait"
  | "delivered"
  | "rejected"
  | "failed"
  | "cancelled";

export type MemorySlackPublicationReceiptKind =
  | "enqueued"
  | "review_approved"
  | "review_rejected"
  | "delivery_claimed"
  | "retry_scheduled"
  | "delivered"
  | "failed"
  | "cancelled"
  | "manual_retry";

export type MemorySlackPublicationReceipt = {
  id: string;
  publicationId: string;
  sequence: number;
  kind: MemorySlackPublicationReceiptKind;
  state: MemorySlackPublicationState;
  attemptNumber: number;
  actorKind: "human" | "agent" | "service";
  actorSubjectId: string;
  operationId: string;
  errorCode: string | null;
  retryAt: string | null;
  slackChannelId: string | null;
  slackMessageTimestamp: string | null;
  createdAt: string;
};

export type MemorySlackPublication = {
  id: string;
  workspaceId: string;
  configurationRevision: number;
  connectionId: string;
  slackTeamId: string;
  slackChannelId: string;
  sourceType: "workspace_memory" | "durable_learning";
  sourceId: string;
  sourceVersion: string | null;
  importance: MemorySlackImportance;
  deliveryMode: "auto" | "review";
  state: MemorySlackPublicationState;
  summary: string;
  sourceLabel: string;
  authoritativePath: string | null;
  initiatorKind: "human" | "agent" | "service";
  initiatorSubjectId: string;
  initiatingHumanSubjectId: string | null;
  attemptCount: number;
  retryAt: string | null;
  lastErrorCode: string | null;
  slackMessageTimestamp: string | null;
  deliveredAt: string | null;
  terminalAt: string | null;
  createdAt: string;
  updatedAt: string;
  receipts: MemorySlackPublicationReceipt[];
};

export type MemorySlackPublicationHistoryResponse = {
  publications: MemorySlackPublication[];
  nextCursor: string | null;
};

export type MemorySlackPublicationActionRequest = {
  action: "approve" | "reject" | "retry";
  expectedState: MemorySlackPublicationState;
};

export type SlackPublicationChannel = {
  id: string;
  name: string | null;
  isPrivate: boolean;
};

export type SlackPublicationChannelListResponse = {
  channels: SlackPublicationChannel[];
  nextCursor: string | null;
};
