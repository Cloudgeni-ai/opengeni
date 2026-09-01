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
  type FileAttachmentClientLike,
  type GoalStore,
  type GoalClientLike,
  type HumanInputStore,
  type HumanInputSessionClientLike,
  type OpenGeniExternalStore,
  type SessionClientLike,
  type SessionComposerRuntimeStore,
  type SessionControlStore,
  type SessionEventStore,
  type SessionLineageClientLike,
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
  attachments?: OpenGeniControllerStore<FileAttachmentStore> | undefined;
  queue: OpenGeniControllerStore<TurnQueueStore>;
  control: OpenGeniControllerStore<SessionControlStore>;
  goal?: OpenGeniControllerStore<GoalStore> | undefined;
  humanInput?: OpenGeniControllerStore<HumanInputStore> | undefined;
  lineage?: OpenGeniControllerStore<SessionLineageStore> | undefined;
  /** Hold the shared composition while a raw-controller adapter is mounted. */
  acquire(): () => void;
  destroy(): void;
}>;

export type SessionControllerCompositionFeatures = Readonly<{
  attachments?: boolean;
  goal?: boolean;
  humanInput?: boolean;
  lineage?: boolean;
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
  features: SessionControllerCompositionFeatures = {},
): SessionSurfaceControllers {
  const common = { workspaceId: context.workspaceId, sessionId };
  const sharedEvents = [] as const;
  const attachmentClient =
    features.attachments === false
      ? undefined
      : (context.fileAttachmentClient ??
        clientCapability<FileAttachmentClientLike>(context.client, ["uploadFile"]));
  const goalClient =
    features.goal === false
      ? undefined
      : (context.goalClient ??
        clientCapability<GoalClientLike>(context.client, ["getGoal", "updateGoal", "deleteGoal"]));
  const humanInputClient =
    features.humanInput === false
      ? undefined
      : (context.humanInputClient ??
        clientCapability<HumanInputSessionClientLike>(context.client, [
          "listHumanInputRequests",
          "submitHumanInputResponse",
        ]));
  const lineageClient =
    features.lineage === false
      ? undefined
      : (context.lineageClient ??
        clientCapability<SessionLineageClientLike>(context.client, ["getSessionLineage"]));
  const sessionController = createSessionResourceStore({
    client: context.sessionClient ?? context.client,
    ...common,
    events: sharedEvents,
  });
  const composerController = createSessionComposerRuntimeStore({
    client: context.client,
    ...common,
    events: sharedEvents,
  });
  const attachmentController = attachmentClient
    ? createFileAttachmentStore({
        client: attachmentClient,
        workspaceId: context.workspaceId,
      })
    : undefined;
  const queueController = createTurnQueueStore({
    client: context.client,
    ...common,
    events: sharedEvents,
  });
  const controlController = createSessionControlStore({ client: context.client, ...common });
  const goalController = goalClient
    ? createGoalStore({ client: goalClient, ...common, events: sharedEvents })
    : undefined;
  const humanInputController = humanInputClient
    ? createHumanInputStore({ client: humanInputClient, ...common, events: sharedEvents })
    : undefined;
  const lineageController = lineageClient
    ? createSessionLineageStore({ client: lineageClient, ...common, events: sharedEvents })
    : undefined;
  let destroyed = false;
  let reconciled: ReconciledSessionControllers | undefined;
  const eventController = createSessionEventStore({
    client: context.client,
    ...common,
    reconcile: async () => {
      if (destroyed || !reconciled) return;
      await reconcileSessionControllerComposition(reconciled);
    },
  });
  let owners = 0;
  const acquireComposition = (): (() => void) => {
    if (destroyed) return () => undefined;
    owners += 1;
    if (owners === 1) void eventController.start();
    let released = false;
    return () => {
      if (released || destroyed) return;
      released = true;
      owners = Math.max(0, owners - 1);
      if (owners === 0) destroyComposition();
    };
  };
  const linkedStore = <Controller extends OpenGeniExternalStore<unknown>>(
    controller: Controller,
  ): OpenGeniControllerStore<Controller> =>
    controllerStore(controller, { acquire: acquireComposition, owned: false });
  const session = linkedStore(sessionController);
  const composer = linkedStore(composerController);
  const attachments = attachmentController ? linkedStore(attachmentController) : undefined;
  const queue = linkedStore(queueController);
  const control = linkedStore(controlController);
  const goal = goalController ? linkedStore(goalController) : undefined;
  const humanInput = humanInputController ? linkedStore(humanInputController) : undefined;
  const lineage = lineageController ? linkedStore(lineageController) : undefined;
  const events = controllerStore(eventController, { acquire: acquireComposition, owned: false });
  reconciled = { session, composer, queue, goal, humanInput, lineage };
  const controllers = {
    session,
    events,
    composer,
    queue,
    control,
    ...(attachments ? { attachments } : {}),
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
  function destroyComposition() {
    if (destroyed) return;
    destroyed = true;
    owners = 0;
    unsubscribeEvents();
    unsubscribeQueue();
    controllers.events.destroy();
    controllers.session.destroy();
    controllers.composer.destroy();
    controllers.attachments?.destroy();
    controllers.queue.destroy();
    controllers.control.destroy();
    controllers.goal?.destroy();
    controllers.humanInput?.destroy();
    controllers.lineage?.destroy();
    eventController.destroy();
    sessionController.destroy();
    composerController.destroy();
    attachmentController?.destroy();
    queueController.destroy();
    controlController.destroy();
    goalController?.destroy();
    humanInputController?.destroy();
    lineageController?.destroy();
  }
  return Object.freeze({
    ...controllers,
    acquire: acquireComposition,
    destroy: destroyComposition,
  });
}

function clientCapability<Capability>(
  client: SessionClientLike,
  methods: readonly string[],
): Capability | undefined {
  const candidate = client as unknown as Record<string, unknown>;
  return methods.every((method) => typeof candidate[method] === "function")
    ? (client as unknown as Capability)
    : undefined;
}
