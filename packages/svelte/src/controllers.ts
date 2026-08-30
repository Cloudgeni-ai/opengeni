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
import { controllerStore, type OpenGeniControllerStore } from "./store";

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

export type SessionSurfaceControllers = Readonly<{
  session: OpenGeniControllerStore<SessionResourceStore>;
  events: OpenGeniControllerStore<SessionEventStore>;
  composer: OpenGeniControllerStore<SessionComposerRuntimeStore>;
  attachments: OpenGeniControllerStore<FileAttachmentStore>;
  queue: OpenGeniControllerStore<TurnQueueStore>;
  control: OpenGeniControllerStore<SessionControlStore>;
  goal?: OpenGeniControllerStore<GoalStore> | undefined;
  humanInput?: OpenGeniControllerStore<HumanInputStore> | undefined;
  lineage?: OpenGeniControllerStore<SessionLineageStore> | undefined;
  destroy(): void;
}>;

export function createContextSessionControllers(sessionId: string): SessionSurfaceControllers {
  const context = getOpenGeniContext();
  const common = { workspaceId: context.workspaceId, sessionId };
  const session = createSessionResource({
    client: context.sessionClient ?? context.client,
    ...common,
  });
  const events = createSessionEvents({ client: context.client, ...common });
  const composer = createComposer({ client: context.client, ...common, events: [] });
  const attachments = createAttachments({
    client: context.fileAttachmentClient ?? context.client,
    workspaceId: context.workspaceId,
  });
  const queue = createTurnQueue({ client: context.client, ...common });
  const control = createSessionControl({ client: context.client, ...common });
  const unsubscribeEvents = events.controller.subscribe(() => {
    composer.controller.applyEvents([...events.controller.getSnapshot().events]);
  });
  const unsubscribeQueue = queue.controller.subscribe(() => {
    composer.controller.setEffectiveControl(queue.controller.getSnapshot().effectiveControl);
  });
  composer.controller.applyEvents([...events.controller.getSnapshot().events]);
  composer.controller.setEffectiveControl(queue.controller.getSnapshot().effectiveControl);
  const controllers = {
    session,
    events,
    composer,
    attachments,
    queue,
    control,
    ...(context.goalClient || "getGoal" in context.client
      ? { goal: createGoal({ client: context.goalClient ?? (context.client as never), ...common }) }
      : {}),
    ...(context.humanInputClient || "listHumanInputRequests" in context.client
      ? {
          humanInput: createHumanInput({
            client: context.humanInputClient ?? (context.client as never),
            ...common,
          }),
        }
      : {}),
    ...(context.lineageClient || "getSessionLineage" in context.client
      ? {
          lineage: createLineage({
            client: context.lineageClient ?? (context.client as never),
            ...common,
          }),
        }
      : {}),
  };
  return Object.freeze({
    ...controllers,
    destroy() {
      unsubscribeEvents();
      unsubscribeQueue();
      controllers.session.destroy();
      controllers.events.destroy();
      controllers.composer.destroy();
      controllers.attachments.destroy();
      controllers.queue.destroy();
      controllers.control.destroy();
      controllers.goal?.destroy();
      controllers.humanInput?.destroy();
      controllers.lineage?.destroy();
    },
  });
}

export function approvalsFromEventStore(
  events: Readable<ReturnType<SessionEventStore["getSnapshot"]>>,
) {
  return derived(events, (snapshot) => projectPendingApprovals([...snapshot.events]));
}
