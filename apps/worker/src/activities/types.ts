import type { Settings } from "@opengeni/config";
import type { ScheduledTaskTriggerType } from "@opengeni/contracts";
import type { Database } from "@opengeni/db";
import type { DocumentServices } from "@opengeni/documents";
import type { EventBus } from "@opengeni/events";
import type { Observability } from "@opengeni/observability";
import type { OpenGeniRuntime } from "@opengeni/runtime";
import type { ObjectStorage } from "@opengeni/storage";

export type ActivityServices = {
  settings: Settings;
  db: Database;
  bus: EventBus;
  runtime: OpenGeniRuntime;
  objectStorage: ObjectStorage | null;
  documentServices: DocumentServices;
  observability: Observability;
};

export type ActivityDependencies = Partial<ActivityServices>;

export type RunAgentSegmentInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  triggerEventId: string;
  workflowId: string;
  turnId?: string;
};

export type ClaimNextQueuedTurnInput = {
  workspaceId: string;
  sessionId: string;
  workflowId: string;
};

export type MarkSessionIdleInput = {
  workspaceId: string;
  sessionId: string;
};

export type MaybeContinueGoalInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  workflowId: string;
};

export type MaybeContinueGoalResult = {
  action: "none" | "queue" | "continue" | "paused";
};

export type PauseGoalForInterruptInput = {
  workspaceId: string;
  sessionId: string;
};

export type DispatchScheduledTaskRunInput = {
  workspaceId: string;
  taskId: string;
  triggerType: ScheduledTaskTriggerType;
  agentRunUsageIdempotencyKey?: string;
};

export type DispatchScheduledTaskRunResult = {
  action: "start" | "signal";
  accountId: string;
  workspaceId: string;
  sessionId: string;
  triggerEventId: string;
  workflowId: string;
};

export type IndexDocumentInput = {
  accountId: string;
  workspaceId: string;
  documentId: string;
};

export type RunAgentSegmentResult = {
  status: "idle" | "requires_action" | "failed" | "cancelled";
  // Provider backpressure pacing: when set on an idle result, the session
  // workflow holds the loop this long before admitting the next turn (an
  // active goal's continuation would otherwise immediately re-hit the limit).
  continueDelayMs?: number;
};
