import type { Settings } from "@infra-agents/config";
import type { Document, ScheduledTask } from "@infra-agents/contracts";
import type { Database } from "@infra-agents/db";
import type { DocumentServices } from "@infra-agents/documents";
import type { EventBus } from "@infra-agents/events";
import type { createObjectStorage } from "@infra-agents/storage";

export type SessionWorkflowClient = {
  signalUserMessage: (input: { sessionId: string; eventId: string; workflowId: string }) => Promise<void>;
  wakeSessionWorkflow: (input: { sessionId: string; workflowId: string }) => Promise<void>;
  signalApprovalDecision: (input: { sessionId: string; eventId: string; workflowId: string }) => Promise<void>;
  signalInterrupt: (input: { sessionId: string; eventId: string; workflowId: string }) => Promise<void>;
  syncScheduledTask: (input: { task: ScheduledTask }) => Promise<void>;
  deleteScheduledTaskSchedule: (input: { temporalScheduleId: string }) => Promise<void>;
  triggerScheduledTask: (input: { taskId: string }) => Promise<void>;
};

export type DocumentIndexClient = {
  indexDocument: (input: { documentId: string }) => Promise<Document | void>;
};

export type AppDependencies = {
  settings: Settings;
  db: Database;
  bus: EventBus;
  workflowClient: SessionWorkflowClient;
  documentIndexer?: DocumentIndexClient;
  documentServices?: DocumentServices;
  githubStateSecret?: string;
};

export type ObjectStorageDependency = ReturnType<typeof createObjectStorage>;

export type ApiRouteDeps = AppDependencies & {
  objectStorage: ObjectStorageDependency;
  githubStateSecret: string;
  documentIndexer: DocumentIndexClient;
  getDocumentServices: () => DocumentServices;
};
