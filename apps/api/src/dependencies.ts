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
  // Interrupt must reach the workflow whether or not an execution is currently
  // running: a long-lived session that has gone idle (its workflow returned
  // after markSessionIdle) has NO running execution, so a plain
  // getHandle().signal() throws WorkflowNotFoundError -> a 500 that leaves an
  // operator unable to stop a session. signalWithStart start-or-signals, so it
  // needs the session-workflow args (accountId/workspaceId) to start a fresh
  // run when none is live; the buffered `interrupt` signal is then honored by
  // the workflow's idle-interrupt path (pause goal + mark idle).
  signalInterrupt: (input: { accountId: string; workspaceId: string; sessionId: string; eventId: string; workflowId: string }) => Promise<void>;
  syncScheduledTask: (input: { task: ScheduledTask }) => Promise<void>;
  deleteScheduledTaskSchedule: (input: { temporalScheduleId: string }) => Promise<void>;
  triggerScheduledTask: (input: { task: ScheduledTask; agentRunUsageIdempotencyKey?: string }) => Promise<void>;
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
