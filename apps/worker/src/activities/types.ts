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
  sessionId: string;
  triggerEventId: string;
  workflowId: string;
  turnId?: string;
};

export type ClaimNextQueuedTurnInput = {
  sessionId: string;
  workflowId: string;
};

export type MarkSessionIdleInput = {
  sessionId: string;
};

export type DispatchScheduledTaskRunInput = {
  taskId: string;
  triggerType: ScheduledTaskTriggerType;
};

export type DispatchScheduledTaskRunResult = {
  action: "start" | "signal";
  sessionId: string;
  triggerEventId: string;
  workflowId: string;
};

export type IndexDocumentInput = {
  documentId: string;
};

export type RunAgentSegmentResult = {
  status: "idle" | "requires_action" | "failed" | "cancelled";
};
