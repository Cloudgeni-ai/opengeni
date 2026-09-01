import {
  createFileAttachmentStore,
  createGoalStore,
  createHumanInputStore,
  createSessionComposerRuntimeStore,
  createSessionControlStore,
  createSessionEventStore,
  createSessionLineageStore,
  createSessionResourceStore,
  createTurnQueueStore,
  type FileAttachmentStore,
  type GoalStore,
  type HumanInputStore,
  type SessionComposerRuntimeStore,
  type SessionControlStore,
  type SessionEventStore,
  type SessionLineageStore,
  type SessionResourceStore,
  type TurnQueueStore,
} from "@opengeni/sdk/session";
import type { OpenGeniSvelteContext } from "./context";
import { controllerStore, type OpenGeniControllerStore } from "./store";

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

type ReconciledSessionControllers = Pick<
  SessionSurfaceControllers,
  "session" | "composer" | "queue" | "goal" | "humanInput" | "lineage"
>;

/** @internal Refresh every authoritative projection when the shared SSE feed opens. */
export async function reconcileSessionControllerComposition(
  controllers: ReconciledSessionControllers,
): Promise<void> {
  const refreshes = [
    () => controllers.session.controller.refresh(),
    () => controllers.composer.controller.refresh(),
    () => controllers.queue.controller.refresh(),
    ...(controllers.goal ? [() => controllers.goal!.controller.refresh()] : []),
    ...(controllers.humanInput ? [() => controllers.humanInput!.controller.refresh()] : []),
    ...(controllers.lineage ? [() => controllers.lineage!.controller.refresh()] : []),
  ];
  await Promise.all(refreshes.map(async (refresh) => await refresh()));
}

/** @internal Framework-native composition behind the context convenience API. */
export function createSessionControllerComposition(
  context: OpenGeniSvelteContext,
  sessionId: string,
): SessionSurfaceControllers {
  const common = { workspaceId: context.workspaceId, sessionId };
  const sharedEvents = [] as const;
  const session = controllerStore(
    createSessionResourceStore({
      client: context.sessionClient ?? context.client,
      ...common,
      events: sharedEvents,
    }),
  );
  const composer = controllerStore(
    createSessionComposerRuntimeStore({
      client: context.client,
      ...common,
      events: sharedEvents,
    }),
  );
  const attachments = controllerStore(
    createFileAttachmentStore({
      client: context.fileAttachmentClient ?? context.client,
      workspaceId: context.workspaceId,
    }),
  );
  const queue = controllerStore(
    createTurnQueueStore({ client: context.client, ...common, events: sharedEvents }),
  );
  const control = controllerStore(createSessionControlStore({ client: context.client, ...common }));
  const goal =
    context.goalClient || "getGoal" in context.client
      ? controllerStore(
          createGoalStore({
            client: context.goalClient ?? (context.client as never),
            ...common,
            events: sharedEvents,
          }),
        )
      : undefined;
  const humanInput =
    context.humanInputClient || "listHumanInputRequests" in context.client
      ? controllerStore(
          createHumanInputStore({
            client: context.humanInputClient ?? (context.client as never),
            ...common,
            events: sharedEvents,
          }),
        )
      : undefined;
  const lineage =
    context.lineageClient || "getSessionLineage" in context.client
      ? controllerStore(
          createSessionLineageStore({
            client: context.lineageClient ?? (context.client as never),
            ...common,
            events: sharedEvents,
          }),
        )
      : undefined;
  const reconciled = { session, composer, queue, goal, humanInput, lineage };
  let destroyed = false;
  const events = controllerStore(
    createSessionEventStore({
      client: context.client,
      ...common,
      reconcile: async () => {
        if (destroyed) return;
        await reconcileSessionControllerComposition(reconciled);
      },
    }),
  );
  const controllers = {
    session,
    events,
    composer,
    attachments,
    queue,
    control,
    ...(goal ? { goal } : {}),
    ...(humanInput ? { humanInput } : {}),
    ...(lineage ? { lineage } : {}),
  };
  const applySharedEvents = () => {
    const retained = [...events.controller.getSnapshot().events];
    controllers.session.controller.applyEvents(retained);
    controllers.composer.controller.applyEvents(retained);
    controllers.queue.controller.applyEvents(retained);
    controllers.goal?.controller.applyEvents(retained);
    controllers.humanInput?.controller.applyEvents(retained);
    controllers.lineage?.controller.applyEvents(retained);
  };
  const unsubscribeEvents = events.controller.subscribe(applySharedEvents);
  const unsubscribeQueue = queue.controller.subscribe(() => {
    composer.controller.setEffectiveControl(queue.controller.getSnapshot().effectiveControl);
  });
  applySharedEvents();
  composer.controller.setEffectiveControl(queue.controller.getSnapshot().effectiveControl);
  return Object.freeze({
    ...controllers,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsubscribeEvents();
      unsubscribeQueue();
      controllers.events.destroy();
      controllers.session.destroy();
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
