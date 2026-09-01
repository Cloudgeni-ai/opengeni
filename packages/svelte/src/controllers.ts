import {
  createFileAttachmentStore,
  createGoalStore,
  createHumanInputStore,
  createSessionControlStore,
  createSessionEventStore,
  createSessionLineageStore,
  createSessionMcpApprovalPolicyStore,
  createSessionResourceStore,
  createSessionComposerRuntimeStore,
  createTurnQueueStore,
  projectPendingApprovals,
  type FileAttachmentStore,
  type GoalStore,
  type HumanInputStore,
  type SessionControlStore,
  type SessionEventStore,
  type SessionLineageStore,
  type SessionMcpApprovalPolicyStore,
  type SessionResourceStore,
  type SessionComposerRuntimeStore,
  type TurnQueueStore,
} from "@opengeni/sdk/session";
import { derived, type Readable } from "svelte/store";
import { getOpenGeniContext } from "./context";
import {
  createSessionControllerComposition,
  type SessionSurfaceControllers,
} from "./session-controller-composition";
import { controllerStore } from "./store";

export type { SessionSurfaceControllers } from "./session-controller-composition";

export function createSessionEvents(options: Parameters<typeof createSessionEventStore>[0]) {
  return controllerStore<SessionEventStore>(createSessionEventStore(options));
}
export function createSessionResource(options: Parameters<typeof createSessionResourceStore>[0]) {
  return controllerStore<SessionResourceStore>(createSessionResourceStore(options));
}
export function createComposer(options: Parameters<typeof createSessionComposerRuntimeStore>[0]) {
  return controllerStore<SessionComposerRuntimeStore>(createSessionComposerRuntimeStore(options));
}
export function createAttachments(options: Parameters<typeof createFileAttachmentStore>[0]) {
  return controllerStore<FileAttachmentStore>(createFileAttachmentStore(options));
}
export function createTurnQueue(options: Parameters<typeof createTurnQueueStore>[0]) {
  return controllerStore<TurnQueueStore>(createTurnQueueStore(options));
}
export function createSessionControl(options: Parameters<typeof createSessionControlStore>[0]) {
  return controllerStore<SessionControlStore>(createSessionControlStore(options));
}
export function createGoal(options: Parameters<typeof createGoalStore>[0]) {
  return controllerStore<GoalStore>(createGoalStore(options));
}
export function createHumanInput(options: Parameters<typeof createHumanInputStore>[0]) {
  return controllerStore<HumanInputStore>(createHumanInputStore(options));
}
export function createMcpApprovalPolicy(
  options: Parameters<typeof createSessionMcpApprovalPolicyStore>[0],
) {
  return controllerStore<SessionMcpApprovalPolicyStore>(
    createSessionMcpApprovalPolicyStore(options),
  );
}
export function createLineage(options: Parameters<typeof createSessionLineageStore>[0]) {
  return controllerStore<SessionLineageStore>(createSessionLineageStore(options));
}

export function createContextSessionControllers(sessionId: string): SessionSurfaceControllers {
  return createSessionControllerComposition(getOpenGeniContext(), sessionId);
}

export function approvalsFromEventStore(
  events: Readable<ReturnType<SessionEventStore["getSnapshot"]>>,
) {
  return derived(events, (snapshot) => projectPendingApprovals([...snapshot.events]));
}
