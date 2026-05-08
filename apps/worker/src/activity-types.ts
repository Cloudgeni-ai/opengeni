import type { Settings } from "@infra-agents/config";
import type { ScheduledTaskTriggerType } from "@infra-agents/contracts";
import type { Database } from "@infra-agents/db";
import type { DocumentServices } from "@infra-agents/documents";
import type { EventBus } from "@infra-agents/events";
import type { InfraAgentRuntime } from "@infra-agents/runtime";
import type { ObjectStorage } from "@infra-agents/storage";

export type ActivityServices = {
  settings: Settings;
  db: Database;
  bus: EventBus;
  runtime: InfraAgentRuntime;
  objectStorage: ObjectStorage | null;
  documentServices: DocumentServices;
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
