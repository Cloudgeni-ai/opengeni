import type { Settings } from "@opengeni/config";
import type { Document, ScheduledTask } from "@opengeni/contracts";
import type { Database } from "@opengeni/db";
import type { DocumentServices } from "@opengeni/documents";
import type { EventBus } from "@opengeni/events";
import type { Observability } from "@opengeni/observability";
import type { createObjectStorage } from "@opengeni/storage";
import type { ManagedAuth } from "./auth/managed-auth";

export type SessionWorkflowClient = {
  signalUserMessage: (input: { sessionId: string; eventId: string; workflowId: string }) => Promise<void>;
  wakeSessionWorkflow: (input: { accountId: string; workspaceId: string; sessionId: string; workflowId: string }) => Promise<void>;
  signalApprovalDecision: (input: { sessionId: string; eventId: string; workflowId: string }) => Promise<void>;
  signalInterrupt: (input: { sessionId: string; eventId: string; workflowId: string }) => Promise<void>;
  syncScheduledTask: (input: { task: ScheduledTask }) => Promise<void>;
  deleteScheduledTaskSchedule: (input: { temporalScheduleId: string }) => Promise<void>;
  triggerScheduledTask: (input: { task: ScheduledTask }) => Promise<void>;
};

export type DocumentIndexClient = {
  indexDocument: (input: { accountId: string; workspaceId: string; documentId: string }) => Promise<Document | void>;
};

export type AppDependencies = {
  settings: Settings;
  db: Database;
  bus: EventBus;
  workflowClient: SessionWorkflowClient;
  documentIndexer?: DocumentIndexClient;
  documentServices?: DocumentServices;
  observability?: Observability;
  githubStateSecret?: string;
  managedAuth?: ManagedAuth | null;
};

export type ObjectStorageDependency = ReturnType<typeof createObjectStorage>;

export type ApiRouteDeps = AppDependencies & {
  objectStorage: ObjectStorageDependency;
  githubStateSecret: string;
  documentIndexer: DocumentIndexClient;
  getDocumentServices: () => DocumentServices;
};
