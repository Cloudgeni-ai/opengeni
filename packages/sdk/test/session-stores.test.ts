import { describe, expect, test } from "bun:test";
import type { SendMessageInput } from "../src/client";
import { OpenGeniApiError } from "../src/errors";
import {
  SESSION_EVENT_BROWSER_MAX_COUNT,
  SESSION_EVENT_BROWSER_SINGLE_EVENT_MAX_BYTES,
  acquireSessionController,
  boundSessionEventWindow,
  clearSharedSessionControllers,
  composeSendInput,
  createExternalStore,
  createFileAttachmentStore,
  createGoalStore,
  createHumanInputStore,
  createResourceController,
  createSessionComposerRuntimeStore,
  createSessionControlStore,
  createSessionEventStore,
  createSessionLineageStore,
  createSessionResourceStore,
  createTurnQueueStore,
  mergeSessionEvents,
  sessionEventWindowBytes,
  sharedSessionControllerDiagnostics,
  FILE_ONLY_MESSAGE_TEXT,
  type SessionComposerSendExtras,
  type SessionRuntimeEnvironment,
} from "../src/session";
import type {
  ComposerDraft,
  FileAsset,
  Session,
  SessionEvent,
  SessionGoal,
  SessionHumanInputRequest,
  SessionControlResponse,
  SessionQueueMutationResponse,
  SessionQueueSnapshot,
  SessionTurn,
  SaveComposerDraftRequest,
} from "../src/types";

const WORKSPACE_ID = "99999999-9999-4999-8999-999999999999";
const SESSION_ID = "88888888-8888-4888-8888-888888888888";

describe("framework-neutral session stores", () => {
  test("resource-only composer text matches the frozen React wire contract", () => {
    expect(FILE_ONLY_MESSAGE_TEXT).toBe("(see attached context)");
    expect(composeSendInput("   ", [{ type: "repository", id: "repo-1" } as never])).toBe(
      FILE_ONLY_MESSAGE_TEXT,
    );
  });

  test("composer runtime clears rapid Sends synchronously and settles each optimistic row from events", async () => {
    const firstGate = deferred<void>();
    const attempts: Array<{ text: string; clientEventId?: string }> = [];
    let calls = 0;
    const store = createSessionComposerRuntimeStore({
      client: {
        sendMessage: async (_workspaceId: string, _sessionId: string, input: SendMessageInput) => {
          attempts.push(input);
          calls += 1;
          if (calls === 1) await firstGate.promise;
          return {
            ...event(calls),
            type: "user.message",
            clientEventId: input.clientEventId ?? null,
            payload: { ...input, routing: "accepted_for_execution" },
          };
        },
      } as never,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      draftPersistence: "disabled",
      initialPolicy: {
        model: "model-a",
        reasoningEffort: "medium",
        latencyMode: "standard",
      },
      events: [],
      environment: deterministicEnvironment(["send-1", "send-2"]),
    });
    await store.start();

    store.setValue("first");
    expect(await store.send()).toBe(true);
    expect(store.getSnapshot().value).toBe("");
    store.setValue("second");
    expect(await store.send()).toBe(true);
    expect(store.getSnapshot().optimisticMessages.map((message) => message.text)).toEqual([
      "first",
      "second",
    ]);
    await flushMicrotasks();
    expect(attempts.map((attempt) => attempt.text)).toEqual(["first"]);

    firstGate.resolve();
    await flushMicrotasks();
    expect(attempts.map((attempt) => attempt.text)).toEqual(["first", "second"]);
    const accepted = attempts.map((attempt, index) => ({
      ...event(index + 1, { routing: "accepted_for_execution" }),
      type: "user.message",
      clientEventId: attempt.clientEventId ?? null,
    }));
    const started = accepted.map((acceptedEvent, index) => ({
      ...event(index + 3, { triggerEventId: acceptedEvent.id }),
      type: "turn.started",
      turnId: `turn-${index + 1}`,
    }));
    store.applyEvents([accepted[0]!, started[0]!]);
    expect(store.getSnapshot().optimisticMessages.map((message) => message.text)).toEqual([
      "second",
    ]);
    store.applyEvents([...accepted, ...started]);
    expect(store.getSnapshot().optimisticMessages).toEqual([]);
    store.destroy();
  });

  test("composer runtime preserves typing before hydrate and autosaves against the fetched OCC base", async () => {
    const firstRead = deferred<ComposerDraft>();
    const savedRequests: SaveComposerDraftRequest[] = [];
    const runtime = fakeClock();
    const store = createSessionComposerRuntimeStore({
      client: {
        getComposerDraft: async () => await firstRead.promise,
        saveComposerDraft: async (
          _workspaceId: string,
          _sessionId: string,
          request: SaveComposerDraftRequest,
        ) => {
          savedRequests.push(request);
          return { ...draft(request.expectedRevision + 1, request.text), ...request };
        },
      } as never,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      events: [],
      environment: runtime.environment,
    });
    const starting = store.start();
    store.setValue("typed before hydrate");
    firstRead.resolve(draft(7, "remote text"));
    await starting;

    expect(store.getSnapshot()).toMatchObject({
      value: "typed before hydrate",
      draftRevision: 7,
      draftLoading: false,
      policy: { model: "model-a", reasoningEffort: "medium", latencyMode: "standard" },
    });
    const autosave = [...runtime.timers.values()].find((timer) => timer.delayMs === 500);
    expect(autosave).toBeDefined();
    autosave!.callback();
    await flushMicrotasks();
    expect(savedRequests).toHaveLength(1);
    expect(savedRequests[0]).toMatchObject({
      expectedRevision: 7,
      text: "typed before hydrate",
    });
    expect(store.getSnapshot().draftRevision).toBe(8);
    store.destroy();
  });

  test("composer runtime remount retry reconciles and replays an uncertain Send with the same key", async () => {
    const storage = memoryStorage();
    const ids = ["uncertain-key"];
    const attemptedKeys: string[] = [];
    let attempt = 0;
    const environment = {
      ...deterministicEnvironment(ids),
      draftStorage: storage,
    } satisfies SessionRuntimeEnvironment;
    const client = {
      listEvents: async () => [],
      sendMessage: async (
        _workspaceId: string,
        _sessionId: string,
        input: { clientEventId?: string },
      ) => {
        attemptedKeys.push(input.clientEventId ?? "");
        attempt += 1;
        if (attempt === 1) throw outcomeUnknownError();
        return { ...event(2), type: "user.message", clientEventId: input.clientEventId ?? null };
      },
    } as never;
    const first = createSessionComposerRuntimeStore({
      client,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      draftPersistence: "disabled",
      initialPolicy: {
        model: "model-a",
        reasoningEffort: "medium",
        latencyMode: "standard",
      },
      events: [],
      environment,
    });
    await first.start();
    first.setValue("uncertain message");
    expect(await first.send()).toBe(true);
    await flushMicrotasks();
    const failed = first.getSnapshot().optimisticMessages[0]!;
    expect(failed).toMatchObject({ state: "failed", outcomeUnknown: true });
    first.destroy();

    const second = createSessionComposerRuntimeStore({
      client,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      draftPersistence: "disabled",
      initialPolicy: {
        model: "model-a",
        reasoningEffort: "medium",
        latencyMode: "standard",
      },
      events: [],
      environment,
    });
    await second.start();
    const restored = second.getSnapshot().optimisticMessages[0]!;
    expect(restored).toMatchObject({ state: "failed", outcomeUnknown: true });
    second.retryOptimisticMessage(restored.clientEventId);
    await flushMicrotasks();
    expect(attemptedKeys).toEqual(["uncertain-key", "uncertain-key"]);
    second.destroy();
  });

  test("composer runtime clears its synchronous draft authority before onSubmitted", async () => {
    const observedDraftContent: boolean[] = [];
    let store!: ReturnType<typeof createSessionComposerRuntimeStore>;
    store = createSessionComposerRuntimeStore({
      client: {
        sendMessage: async (_workspaceId: string, _sessionId: string, input: SendMessageInput) => ({
          ...event(1),
          type: "user.message",
          clientEventId: input.clientEventId ?? null,
        }),
      } as never,
      workspaceId: WORKSPACE_ID,
      sessionId: "22222222-2222-4222-8222-222222222223",
      draftPersistence: "disabled",
      initialPolicy: {
        model: "model-a",
        reasoningEffort: "medium",
        latencyMode: "standard",
      },
      events: [],
      onSubmitted: () => observedDraftContent.push(store.hasDraftContent()),
      environment: deterministicEnvironment(["callback-key"]),
    });
    await store.start();

    store.setValue("clear before callback");
    expect(await store.send()).toBe(true);
    expect(observedDraftContent).toEqual([false]);
    expect(store.getSnapshot().value).toBe("");
    store.destroy();
  });

  test("composer runtime promotes ordinary Sends from queue to chat through HTTP and shared events", async () => {
    const httpStore = createSessionComposerRuntimeStore({
      client: {
        sendMessage: async (_workspaceId: string, _sessionId: string, input: SendMessageInput) => ({
          ...event(1, { routing: "accepted_for_steering" }),
          type: "user.message",
          clientEventId: input.clientEventId ?? null,
        }),
      } as never,
      workspaceId: WORKSPACE_ID,
      sessionId: "22222222-2222-4222-8222-222222222224",
      draftPersistence: "disabled",
      initialPolicy: {
        model: "model-a",
        reasoningEffort: "medium",
        latencyMode: "standard",
      },
      events: [],
      sendDestination: () => "queue",
      environment: deterministicEnvironment(["http-promotion-key"]),
    });
    await httpStore.start();
    expect(await httpStore.send("promote from HTTP")).toBe(true);
    await flushMicrotasks();
    expect(httpStore.getSnapshot().optimisticMessages[0]).toMatchObject({
      destination: "chat",
      state: "queued",
    });
    httpStore.destroy();

    const pendingHttp = deferred<SessionEvent>();
    let streamedClientEventId: string | null = null;
    const eventStore = createSessionComposerRuntimeStore({
      client: {
        sendMessage: async (_workspaceId: string, _sessionId: string, input: SendMessageInput) => {
          streamedClientEventId = input.clientEventId ?? null;
          return await pendingHttp.promise;
        },
      } as never,
      workspaceId: WORKSPACE_ID,
      sessionId: "22222222-2222-4222-8222-222222222225",
      draftPersistence: "disabled",
      initialPolicy: {
        model: "model-a",
        reasoningEffort: "medium",
        latencyMode: "standard",
      },
      events: [],
      sendDestination: () => "queue",
      environment: deterministicEnvironment(["event-promotion-key"]),
    });
    await eventStore.start();
    expect(await eventStore.send("promote from event")).toBe(true);
    await flushMicrotasks();
    const accepted = {
      ...event(2, { routing: "accepted_for_steering" }),
      type: "user.message" as const,
      clientEventId: streamedClientEventId,
    };
    eventStore.applyEvents([
      accepted,
      {
        ...event(3, { triggerEventId: accepted.id, turnId: "turn-promoted" }),
        type: "turn.queued",
        turnId: "turn-promoted",
      },
    ]);
    expect(eventStore.getSnapshot().optimisticMessages[0]).toMatchObject({
      destination: "chat",
      state: "queued",
      turnId: "turn-promoted",
      outcomeUnknown: false,
    });
    pendingHttp.reject(outcomeUnknownError());
    await flushMicrotasks();
    expect(eventStore.getSnapshot().optimisticMessages[0]).toMatchObject({
      destination: "chat",
      state: "queued",
    });
    eventStore.destroy();
  });

  test("composer runtime projects an explicit Steer through acceptance and durable settlement", async () => {
    const accepted = {
      ...event(1, { routing: "accepted_for_steering" }),
      type: "user.message" as const,
      clientEventId: "steer-key",
    };
    const store = createSessionComposerRuntimeStore({
      client: {
        steerMessage: async () =>
          ({
            accepted,
            turn: { id: "turn-steered" },
            routing: "accepted_for_steering",
            interruptionCount: 1,
            replay: false,
          }) as never,
      } as never,
      workspaceId: WORKSPACE_ID,
      sessionId: "22222222-2222-4222-8222-222222222226",
      draftPersistence: "disabled",
      initialPolicy: {
        model: "model-a",
        reasoningEffort: "medium",
        latencyMode: "standard",
      },
      events: [],
      environment: deterministicEnvironment(["steer-key"]),
    });
    await store.start();

    expect(await store.steer("change direction")).toBe(true);
    expect(store.getSnapshot()).toMatchObject({
      steering: {
        phase: "accepted",
        triggerEventId: accepted.id,
        turnId: "turn-steered",
        stoppingPreviousAttempt: true,
      },
      stoppingAttempt: "previous",
    });
    store.applyEvents([
      accepted,
      {
        ...event(2, { triggerEventId: accepted.id }),
        type: "turn.started",
        turnId: "turn-steered",
      },
    ]);
    expect(store.getSnapshot()).toMatchObject({ steering: null, stoppingAttempt: null });
    store.destroy();
  });

  test("composer runtime preserves local text across OCC conflict and supports both resolutions", async () => {
    const conflict = () =>
      new OpenGeniApiError(
        409,
        JSON.stringify({ code: "DRAFT_CHANGED", message: "Composer draft changed" }),
      );
    const keepClock = fakeClock();
    let keepReads = 0;
    const keepSaves: SaveComposerDraftRequest[] = [];
    const keepStore = createSessionComposerRuntimeStore({
      client: {
        getComposerDraft: async () =>
          keepReads++ === 0 ? draft(1, "remote one") : draft(2, "remote two"),
        saveComposerDraft: async (
          _workspaceId: string,
          _sessionId: string,
          request: SaveComposerDraftRequest,
        ) => {
          keepSaves.push(request);
          if (keepSaves.length === 1) throw conflict();
          return { ...draft(request.expectedRevision + 1, request.text), ...request };
        },
      } as never,
      workspaceId: WORKSPACE_ID,
      sessionId: "22222222-2222-4222-8222-222222222227",
      events: [],
      environment: keepClock.environment,
    });
    await keepStore.start();
    keepStore.setValue("mine remains");
    const keepAutosave = [...keepClock.timers.values()].find((timer) => timer.delayMs === 500);
    keepAutosave!.callback();
    await flushMicrotasks();
    expect(keepStore.getSnapshot()).toMatchObject({
      value: "mine remains",
      draftRevision: 1,
    });
    expect(keepStore.getSnapshot().draftConflict?.message).toContain("Composer draft changed");
    await keepStore.resolveDraftConflict("keep_mine");
    expect(keepSaves[1]).toMatchObject({ expectedRevision: 2, text: "mine remains" });
    expect(keepStore.getSnapshot()).toMatchObject({
      value: "mine remains",
      draftRevision: 3,
      draftConflict: null,
    });
    keepStore.destroy();

    const remoteClock = fakeClock();
    let remoteReads = 0;
    const remoteStore = createSessionComposerRuntimeStore({
      client: {
        getComposerDraft: async () =>
          remoteReads++ === 0 ? draft(1, "remote one") : draft(2, "remote wins"),
        saveComposerDraft: async () => {
          throw conflict();
        },
      } as never,
      workspaceId: WORKSPACE_ID,
      sessionId: "22222222-2222-4222-8222-222222222228",
      events: [],
      environment: remoteClock.environment,
    });
    await remoteStore.start();
    remoteStore.setValue("discard mine");
    const remoteAutosave = [...remoteClock.timers.values()].find((timer) => timer.delayMs === 500);
    remoteAutosave!.callback();
    await flushMicrotasks();
    await remoteStore.resolveDraftConflict("use_remote");
    expect(remoteStore.getSnapshot()).toMatchObject({
      value: "remote wins",
      draftRevision: 2,
      draftConflict: null,
      error: null,
    });
    remoteStore.destroy();
  });

  test("composer runtime ignores stale read and submit completions after destruction", async () => {
    const readGate = deferred<ComposerDraft>();
    const readStore = createSessionComposerRuntimeStore({
      client: { getComposerDraft: async () => await readGate.promise } as never,
      workspaceId: WORKSPACE_ID,
      sessionId: "22222222-2222-4222-8222-222222222229",
      events: [],
    });
    const starting = readStore.start();
    const readSnapshot = readStore.getSnapshot();
    readStore.destroy();
    readGate.resolve(draft(9, "stale private draft"));
    await starting;
    expect(readStore.getSnapshot()).toBe(readSnapshot);
    expect(readStore.getSnapshot().draft).toBeNull();

    const submitGate = deferred<SessionEvent>();
    const sentCallbacks: string[] = [];
    const submitStore = createSessionComposerRuntimeStore({
      client: { sendMessage: async () => await submitGate.promise } as never,
      workspaceId: WORKSPACE_ID,
      sessionId: "22222222-2222-4222-8222-222222222230",
      draftPersistence: "disabled",
      initialPolicy: {
        model: "model-a",
        reasoningEffort: "medium",
        latencyMode: "standard",
      },
      events: [],
      onSent: (text) => sentCallbacks.push(text),
      environment: deterministicEnvironment(["stale-submit-key"]),
    });
    await submitStore.start();
    expect(await submitStore.send("stale submit")).toBe(true);
    await flushMicrotasks();
    const submitSnapshot = submitStore.getSnapshot();
    submitStore.destroy();
    submitGate.resolve(event(1));
    await flushMicrotasks();
    expect(submitStore.getSnapshot()).toBe(submitSnapshot);
    expect(sentCallbacks).toEqual([]);
  });

  test("composer runtime never replays credential-bearing uncertain Sends after remount", async () => {
    const storage = memoryStorage();
    const attempts: SendMessageInput[] = [];
    const environment = {
      ...deterministicEnvironment(["credential-key"]),
      draftStorage: storage,
    } satisfies SessionRuntimeEnvironment;
    const client = {
      listEvents: async () => [],
      sendMessage: async (_workspaceId: string, _sessionId: string, input: SendMessageInput) => {
        attempts.push(input);
        throw outcomeUnknownError();
      },
    } as never;
    const create = () =>
      createSessionComposerRuntimeStore({
        client,
        workspaceId: WORKSPACE_ID,
        sessionId: "22222222-2222-4222-8222-222222222231",
        draftPersistence: "disabled",
        initialPolicy: {
          model: "model-a",
          reasoningEffort: "medium",
          latencyMode: "standard",
        },
        events: [],
        sendExtras: {
          mcpCredentialUpdates: [{ serverName: "private", credential: "secret" }] as never,
        },
        environment,
      });

    const first = create();
    await first.start();
    expect(await first.send("credential-bound request")).toBe(true);
    await flushMicrotasks();
    expect(first.getSnapshot().optimisticMessages[0]).toMatchObject({
      state: "failed",
      outcomeUnknown: true,
    });
    first.destroy();

    const second = create();
    await second.start();
    const restored = second.getSnapshot().optimisticMessages[0]!;
    second.retryOptimisticMessage(restored.clientEventId);
    await flushMicrotasks();
    expect(attempts).toHaveLength(1);
    expect(second.getSnapshot().optimisticMessages[0]).toMatchObject({
      state: "failed",
      outcomeUnknown: true,
      error: expect.stringContaining("cannot safely retry"),
    });
    second.destroy();
  });

  test("composer runtime reconciles dynamic attachment extras without duplicate durable resources", async () => {
    const fileId = "33333333-3333-4333-8333-333333333333";
    const canonical = {
      kind: "file" as const,
      fileId,
      mountPath: `.opengeni/files/${fileId}`,
    };
    let extras: SessionComposerSendExtras = {};
    let blocked = true;
    const saved: SaveComposerDraftRequest[] = [];
    const runtime = fakeClock();
    const store = createSessionComposerRuntimeStore({
      client: {
        getComposerDraft: async () => ({ ...draft(4, "inspect it"), resources: [canonical] }),
        saveComposerDraft: async (
          _workspaceId: string,
          _sessionId: string,
          request: SaveComposerDraftRequest,
        ) => {
          saved.push(request);
          return { ...draft(request.expectedRevision + 1, request.text), ...request };
        },
      } as never,
      workspaceId: WORKSPACE_ID,
      sessionId: "22222222-2222-4222-8222-222222222232",
      events: [],
      sendExtras: () => extras,
      sendBlocked: () => blocked,
      environment: runtime.environment,
    });
    await store.start();
    expect(store.getSnapshot().canSend).toBe(false);
    blocked = false;
    store.syncExternalInputs();
    expect(store.getSnapshot().canSend).toBe(true);
    extras = { resources: [{ kind: "file", fileId }] };
    store.syncExternalInputs();
    expect(store.getSnapshot().canSend).toBe(true);
    expect([...runtime.timers.values()].filter((timer) => timer.delayMs === 500)).toEqual([]);
    expect(await store.saveNow()).toMatchObject({ resources: [canonical] });
    expect(saved).toEqual([]);
    store.destroy();
  });

  test("durable composer submission snapshots explicit attachment resources into save and submit", async () => {
    const fileId = "33333333-3333-4333-8333-333333333334";
    const resource = { kind: "file" as const, fileId };
    const saved: SaveComposerDraftRequest[] = [];
    const submitted: Array<{ resources: readonly unknown[] }> = [];
    const submittedGate = deferred<void>();
    const store = createSessionComposerRuntimeStore({
      client: {
        getComposerDraft: async () => draft(4, "send with attachment"),
        saveComposerDraft: async (
          _workspaceId: string,
          _sessionId: string,
          request: SaveComposerDraftRequest,
        ) => {
          saved.push(request);
          return { ...draft(request.expectedRevision + 1, request.text), ...request };
        },
        submitComposerDraft: async (
          _workspaceId: string,
          _sessionId: string,
          request: { clientEventId: string; resources: readonly unknown[] },
        ) => {
          submitted.push(request);
          submittedGate.resolve();
          return {
            accepted: {
              ...event(2, { routing: "accepted_for_execution" }),
              type: "user.message",
              clientEventId: request.clientEventId,
            },
            turn: { id: "turn-attachment", triggerEventId: "event-2" },
            draft: draft(6, ""),
            routing: "accepted_for_execution",
          };
        },
      } as never,
      workspaceId: WORKSPACE_ID,
      sessionId: "22222222-2222-4222-8222-222222222233",
      events: [],
      environment: deterministicEnvironment(["attachment-send"]),
    });
    await store.start();

    expect(await store.submit("send", { resources: [resource] })).toBe(true);
    await submittedGate.promise;

    expect(saved).toHaveLength(1);
    expect(saved[0]?.resources).toEqual([resource]);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.resources).toEqual([resource]);
    store.destroy();
  });

  test("external stores publish synchronously and start/destroy idempotently", async () => {
    let starts = 0;
    let destroys = 0;
    const notifications: number[] = [];
    const store = createExternalStore({
      initialSnapshot: { value: 0 },
      start: () => {
        starts += 1;
      },
      destroy: () => {
        destroys += 1;
      },
    });
    const unsubscribe = store.subscribe(() => notifications.push(store.getSnapshot().value));

    await store.start();
    await store.start();
    store.publish({ value: 1 });
    expect(notifications).toEqual([1]);
    expect(Object.isFrozen(store.getSnapshot())).toBe(true);
    expect(store.diagnostics()).toMatchObject({ started: true, subscribers: 1 });

    unsubscribe();
    store.destroy();
    store.destroy();
    store.publish({ value: 2 });
    expect(starts).toBe(1);
    expect(destroys).toBe(1);
    expect(store.getSnapshot().value).toBe(1);
    expect(store.diagnostics()).toMatchObject({ destroyed: true, subscribers: 0 });
  });

  test("shared acquisition starts once and destroys only after the final owner releases", () => {
    clearSharedSessionControllers();
    let starts = 0;
    let destroys = 0;
    const client = {};
    const create = () =>
      createExternalStore({
        initialSnapshot: 0,
        start: () => {
          starts += 1;
        },
        destroy: () => {
          destroys += 1;
        },
      });
    const identity = {
      client,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      kind: "events",
      optionsKey: "after=0;replay=windowed",
    } as const;
    const first = acquireSessionController(identity, create);
    const second = acquireSessionController(identity, create);

    expect(first.controller).toBe(second.controller);
    expect(starts).toBe(1);
    expect(sharedSessionControllerDiagnostics()).toEqual({ activeControllers: 1, owners: 2 });
    first.release();
    first.release();
    expect(destroys).toBe(0);
    second.release();
    expect(destroys).toBe(1);
    expect(sharedSessionControllerDiagnostics()).toEqual({ activeControllers: 0, owners: 0 });
  });

  test("resource controllers ignore stale completions even when the client ignores abort", async () => {
    const first = deferred<number>();
    const second = deferred<number>();
    let reads = 0;
    const controller = createResourceController({
      load: async () => await (++reads === 1 ? first.promise : second.promise),
    });

    const starting = controller.start();
    const refreshing = controller.refresh();
    second.resolve(2);
    expect(await refreshing).toBe(2);
    first.resolve(1);
    await starting;
    expect(controller.getSnapshot()).toMatchObject({ value: 2, readRevision: 1 });
    controller.destroy();
  });

  test("session title mutations remain visible across stale reads that ignore abort", async () => {
    const staleRead = deferred<Session>();
    const oldSession = sessionResourceFixture("Old title");
    const committedSession = sessionResourceFixture("Committed title");
    let reads = 0;
    const store = createSessionResourceStore({
      client: {
        getSession: async () => {
          reads += 1;
          if (reads === 1) return oldSession;
          if (reads === 2) return await staleRead.promise;
          return committedSession;
        },
        updateSession: async () => committedSession,
      } as never,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      events: [],
    });
    await store.start();
    expect(store.getSnapshot().value?.title).toBe("Old title");

    const refreshing = store.refresh();
    expect(await store.updateTitle("Committed title")).toEqual(committedSession);
    expect(store.getSnapshot().value?.title).toBe("Committed title");

    staleRead.resolve(oldSession);
    await refreshing;
    expect(store.getSnapshot().value?.title).toBe("Committed title");
    await flushMicrotasks();
    expect(store.getSnapshot().value?.title).toBe("Committed title");
    expect(reads).toBe(3);
    store.destroy();
  });

  test("session title events remain visible across stale reads that ignore abort", async () => {
    const staleRead = deferred<Session>();
    const oldSession = sessionResourceFixture("Old title");
    let reads = 0;
    const store = createSessionResourceStore({
      client: {
        getSession: async () => {
          reads += 1;
          return reads === 1 ? oldSession : await staleRead.promise;
        },
      } as never,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      events: [],
    });
    await store.start();

    const refreshing = store.refresh();
    store.applyEvents([
      {
        ...event(2, { title: "Event title", source: "agent" }),
        type: "session.title_set",
      },
    ]);
    expect(store.getSnapshot().value?.title).toBe("Event title");

    staleRead.resolve(oldSession);
    await refreshing;
    expect(store.getSnapshot().value?.title).toBe("Event title");
    store.destroy();
  });

  test("event windows dedupe, order, count-bound, and project oversized legacy events", () => {
    const merged = mergeSessionEvents(
      [event(2), event(1)],
      [event(2, { replacement: true }), event(3)],
    );
    expect(merged.map((item) => item.sequence)).toEqual([1, 2, 3]);
    expect(merged[1]!.payload).toEqual({ replacement: true });

    const countBound = boundSessionEventWindow(
      Array.from({ length: SESSION_EVENT_BROWSER_MAX_COUNT + 1 }, (_, index) => event(index + 1)),
    );
    expect(countBound.events).toHaveLength(SESSION_EVENT_BROWSER_MAX_COUNT);
    expect(countBound.events[0]!.sequence).toBe(2);
    expect(countBound.truncated).toBe(true);

    const oversized = boundSessionEventWindow([
      event(1, { callId: "call-1", output: "x".repeat(200_000) }),
    ]);
    expect(oversized.events).toHaveLength(1);
    expect(sessionEventWindowBytes(oversized.events[0])).toBeLessThanOrEqual(
      SESSION_EVENT_BROWSER_SINGLE_EVENT_MAX_BYTES,
    );
    expect(oversized.events[0]!.payload).toMatchObject({
      callId: "call-1",
      truncation: { truncated: true, surface: "browser_legacy_guard" },
    });
  });

  test("event stores own one stream and abort it on final destruction", async () => {
    let observedAbort = false;
    const client = {
      listEvents: async () => [event(1)],
      streamEvents: (
        _workspaceId: string,
        _sessionId: string,
        options: { signal?: AbortSignal; onStateChange?: (state: "live") => void },
      ) =>
        (async function* () {
          options.onStateChange?.("live");
          await new Promise<void>((resolve) => {
            options.signal?.addEventListener(
              "abort",
              () => {
                observedAbort = true;
                resolve();
              },
              { once: true },
            );
          });
          if (options.signal?.aborted) return;
          yield event(2);
        })(),
    };
    const store = createSessionEventStore({
      client: client as never,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
    });

    await store.start();
    await flushMicrotasks();
    expect(store.getSnapshot()).toMatchObject({ connectionState: "live", resumeSequence: 1 });
    expect(store.diagnostics().streams).toBe(1);
    store.destroy();
    await flushMicrotasks();
    expect(observedAbort).toBe(true);
    expect(store.diagnostics().streams).toBe(0);
  });

  test("queue mutations keep one uncertain key and reject stale snapshots", async () => {
    const requests: Array<{ clientEventId: string; expectedQueueVersion: number }> = [];
    let reads = 0;
    let mutationAttempts = 0;
    const client = {
      getQueue: async () => (reads++ === 0 ? queueSnapshot(2, 2) : queueSnapshot(1, 1)),
      moveQueueItem: async (
        _workspaceId: string,
        _sessionId: string,
        _turnId: string,
        request: { clientEventId: string; expectedQueueVersion: number },
      ): Promise<SessionQueueMutationResponse> => {
        requests.push(request);
        mutationAttempts += 1;
        if (mutationAttempts === 1) throw outcomeUnknownError();
        return { snapshot: queueSnapshot(3, 3) } as SessionQueueMutationResponse;
      },
    };
    const store = createTurnQueueStore({
      client: client as never,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      environment: deterministicEnvironment(["queue-key"]),
    });
    await store.start();
    expect(await store.moveTurn("turn-1", null)).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.clientEventId).toBe(requests[1]!.clientEventId);
    expect(requests[0]!.expectedQueueVersion).toBe(2);
    expect(store.getSnapshot().snapshot?.version).toBe(3);
    await store.refresh();
    expect(store.getSnapshot().snapshot?.version).toBe(3);
    store.destroy();
  });

  test("queue Steer races reconcile as success without retaining an optimistic bridge", async () => {
    let reads = 0;
    const store = createTurnQueueStore({
      client: {
        getQueue: async () => (++reads === 1 ? queueSnapshot(1, 1) : queueSnapshot(2, 1, [])),
        steerQueueItem: async () => {
          throw new OpenGeniApiError(409, "turn already claimed");
        },
      } as never,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      events: [],
      environment: deterministicEnvironment(["steer-key"]),
    });

    await store.start();
    expect(await store.steerTurn("turn-1")).toBe(true);
    expect(reads).toBe(2);
    expect(store.getSnapshot()).toMatchObject({
      queue: [],
      acceptedSteers: [],
      mutationError: null,
    });
    store.destroy();
  });

  test("shared queue events debounce authoritative refresh and retire Steer at turn.started", async () => {
    const runtime = scriptedEnvironment(["steer-key"]);
    let reads = 0;
    let current = queueSnapshot(1, 1);
    const store = createTurnQueueStore({
      client: {
        getQueue: async () => {
          reads += 1;
          return current;
        },
        steerQueueItem: async () => {
          current = queueSnapshot(2, 1, []);
          return { snapshot: current } as SessionQueueMutationResponse;
        },
      } as never,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      events: [],
      environment: runtime.environment,
    });

    await store.start();
    expect(await store.steerTurn("turn-1")).toBe(true);
    expect(store.getSnapshot().acceptedSteers).toEqual([
      expect.objectContaining({ turnId: "turn-1", state: "queued" }),
    ]);

    store.applyEvents([
      { ...event(1), type: "turn.started", turnId: "turn-1" },
      { ...event(2), type: "session.queue.changed" },
    ]);
    expect(store.getSnapshot().acceptedSteers).toEqual([]);
    expect(runtime.timerCount()).toBe(1);
    runtime.runDelay(150);
    await flushMicrotasks();
    expect(reads).toBe(2);
    expect(store.diagnostics().timers).toBe(0);
    store.destroy();
  });

  test("providerless queue streams hand off from lastSequence before consuming live events", async () => {
    let reads = 0;
    const streamedAfter: { value: number | null } = { value: null };
    let observedAbort = false;
    const store = createTurnQueueStore({
      client: {
        getQueue: async () => queueSnapshot(++reads, 1, reads === 1 ? [queueTurn()] : []),
        getSession: async () => ({ lastSequence: 41 }) as never,
        streamEvents: (
          _workspaceId: string,
          _sessionId: string,
          options: { after?: number; signal?: AbortSignal; onOpen?: () => void },
        ) =>
          (async function* () {
            streamedAfter.value = options.after ?? null;
            options.onOpen?.();
            await new Promise<void>((resolve) => {
              options.signal?.addEventListener(
                "abort",
                () => {
                  observedAbort = true;
                  resolve();
                },
                { once: true },
              );
            });
            if (options.signal?.aborted) return;
            yield event(42);
          })(),
      } as never,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      environment: deterministicEnvironment([]),
    });

    await store.start();
    await flushMicrotasks();
    expect(reads).toBe(2);
    expect(streamedAfter.value).toBe(41);
    expect(store.getSnapshot().queue).toEqual([]);
    expect(store.diagnostics().streams).toBe(1);
    store.destroy();
    await flushMicrotasks();
    expect(observedAbort).toBe(true);
    expect(store.diagnostics().streams).toBe(0);
  });

  test("queue polling and streams suspend after the hidden grace and reconcile on visibility", async () => {
    const runtime = scriptedEnvironment([], "visible");
    let reads = 0;
    const store = createTurnQueueStore({
      client: {
        getQueue: async () => queueSnapshot(++reads, 1),
      } as never,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      events: [],
      pollIntervalMs: 500,
      environment: runtime.environment,
    });

    await store.start();
    expect(reads).toBe(1);
    expect(store.diagnostics()).toMatchObject({ timers: 1, listeners: 1 });
    runtime.setVisibility("hidden");
    expect(runtime.timerCount()).toBe(2);
    runtime.runDelay(2_000);
    expect(store.getSnapshot().loading).toBe(false);
    expect(store.diagnostics().timers).toBe(0);

    runtime.setVisibility("visible");
    await flushMicrotasks();
    expect(reads).toBe(2);
    expect(store.diagnostics()).toMatchObject({ timers: 1, listeners: 1 });
    store.destroy();
    expect(store.diagnostics()).toMatchObject({ timers: 0, listeners: 0 });
    expect(runtime.listenerCount()).toBe(0);
  });

  test("lineage captures causal generations and performs immediate plus delayed child refresh", async () => {
    const runtime = scriptedEnvironment([]);
    let reads = 0;
    let causalGeneration = 70;
    const store = createSessionLineageStore({
      client: {
        getSessionLineage: async (
          _workspaceId: string,
          _sessionId: string,
          options: { onRequestStart?: (generation?: number) => void },
        ) => {
          options.onRequestStart?.();
          reads += 1;
          return {
            ancestors: [],
            children: [{ session: { id: `child-${reads}` }, children: [] }],
            truncated: false,
          } as never;
        },
      },
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      events: [],
      beginRead: () => ++causalGeneration,
      environment: runtime.environment,
    });

    await store.start();
    expect(store.getSnapshot()).toMatchObject({ readGeneration: 71, readRevision: 1 });
    store.applyEvents([{ ...event(1), type: "session.status.changed" }]);
    runtime.runDelay(150);
    await flushMicrotasks();
    expect(store.getSnapshot()).toMatchObject({ readGeneration: 72, readRevision: 2 });

    store.applyEvents([
      { ...event(1), type: "session.status.changed" },
      { ...event(2, { name: "session_create" }), type: "agent.toolCall.created" },
    ]);
    await flushMicrotasks();
    expect(reads).toBe(3);
    expect(store.getSnapshot().readGeneration).toBe(73);
    runtime.runDelay(2_500);
    await flushMicrotasks();
    expect(reads).toBe(4);
    expect(store.getSnapshot().readGeneration).toBe(74);
    store.destroy();
    expect(store.diagnostics().timers).toBe(0);
  });

  test("control requests preserve the React wire contract and approval retry key", async () => {
    const controlRequests: unknown[] = [];
    const approvalKeys: string[] = [];
    let approvalAttempts = 0;
    const store = createSessionControlStore({
      client: {
        pauseSession: async (
          _workspaceId: string,
          _sessionId: string,
          request: { reason?: string },
        ) => {
          controlRequests.push(request);
          return controlResponse("paused");
        },
        resumeSession: async (
          _workspaceId: string,
          _sessionId: string,
          request: { reason?: string },
        ) => {
          controlRequests.push(request);
          return controlResponse("active");
        },
        sendApprovalDecision: async (
          _workspaceId: string,
          _sessionId: string,
          request: { clientEventId?: string },
        ) => {
          approvalKeys.push(request.clientEventId ?? "");
          approvalAttempts += 1;
          if (approvalAttempts === 1) throw new Error("response lost");
          return event(3);
        },
      } as never,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      environment: deterministicEnvironment(["approval-key"]),
    });

    expect(await store.pause("stop now")).not.toBeNull();
    expect(await store.resume("continue")).not.toBeNull();
    expect(controlRequests).toEqual([{ reason: "stop now" }, { reason: "continue" }]);
    expect(await store.approve("approval-1", "safe")).toBeNull();
    expect(await store.approve("approval-1", "safe")).not.toBeNull();
    expect(approvalKeys).toEqual(["approval-key", "approval-key"]);
    expect(store.getSnapshot()).toMatchObject({
      controlling: false,
      responding: false,
      error: null,
    });
    store.destroy();
  });

  test("goal 404 is a normal null state", async () => {
    const store = createGoalStore({
      client: {
        getGoal: async () => {
          throw new OpenGeniApiError(404, "session goal not found");
        },
      } as never,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
    });
    await store.start();
    expect(store.getSnapshot()).toMatchObject({ value: null, loading: false, error: null });
    store.destroy();
  });

  test("goal reads cannot resurrect a cleared goal when the client ignores abort", async () => {
    const staleRead = deferred<SessionGoal>();
    const store = createGoalStore({
      client: {
        getGoal: async () => await staleRead.promise,
        deleteGoal: async () => undefined,
      } as never,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
    });

    const starting = store.start();
    await flushMicrotasks();
    await store.clearGoal();
    expect(store.getSnapshot().value).toBeNull();

    staleRead.resolve(sessionGoal("stale-goal", "stale objective"));
    await starting;
    store.clearMutationError();
    expect(store.getSnapshot().value).toBeNull();
    store.destroy();
  });

  for (const action of ["pause", "resume"] as const) {
    test(`goal ${action} commits fence an older ignored-abort read`, async () => {
      const staleRead = deferred<SessionGoal>();
      const staleStatus = action === "pause" ? "active" : "paused";
      const committedStatus = action === "pause" ? "paused" : "active";
      const staleGoal: SessionGoal = {
        ...sessionGoal("goal-stale", "stale objective"),
        status: staleStatus,
      };
      const committedGoal: SessionGoal = {
        ...sessionGoal("goal-committed", "committed objective"),
        status: committedStatus,
        version: 2,
      };
      const store = createGoalStore({
        client: {
          getGoal: async () => await staleRead.promise,
          updateGoal: async () => committedGoal,
        } as never,
        workspaceId: WORKSPACE_ID,
        sessionId: SESSION_ID,
      });

      const starting = store.start();
      await flushMicrotasks();
      const result = action === "pause" ? await store.pause("hold") : await store.resume();
      expect(result?.status).toBe(committedStatus);
      expect(store.getSnapshot().value?.status).toBe(committedStatus);

      staleRead.resolve(staleGoal);
      await starting;
      store.clearMutationError();
      expect(store.getSnapshot().value).toEqual(committedGoal);
      store.destroy();
    });
  }

  test("terminal human-input races reconcile without resurrecting an error", async () => {
    let reads = 0;
    const request = humanInputRequest();
    const store = createHumanInputStore({
      client: {
        listHumanInputRequests: async () => (reads++ === 0 ? [request] : []),
        submitHumanInputResponse: async () => {
          throw new OpenGeniApiError(409, "request already terminal");
        },
      } as never,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      environment: deterministicEnvironment(["human-key"]),
    });
    await store.start();
    expect(store.getSnapshot().requests).toHaveLength(1);
    expect(await store.respond(request.id, { outcome: "answered", answers: [] })).toBeNull();
    expect(store.getSnapshot()).toMatchObject({ requests: [], mutationError: null });
    store.destroy();
  });

  test("attachment uploads are stale-fenced and retained previews revoke exactly once", async () => {
    const firstUpload = deferred<FileAsset>();
    let uploads = 0;
    const revoked: string[] = [];
    const environment = deterministicEnvironment(["attachment-a", "attachment-b"], {
      create: (_value) => `blob:preview-${uploads}`,
      revoke: (url) => revoked.push(url),
    });
    const store = createFileAttachmentStore({
      client: {
        uploadFile: async () => {
          uploads += 1;
          return uploads === 1 ? await firstUpload.promise : fileAsset("file-b");
        },
      },
      workspaceId: WORKSPACE_ID,
      environment,
    });

    store.addFiles([{ name: "a.png", type: "image/png", size: 3, data: new Blob(["one"]) }]);
    expect(store.diagnostics().objectUrls).toBe(1);
    store.remove("attachment-a");
    firstUpload.resolve(fileAsset("file-a"));
    await flushMicrotasks();
    expect(store.getSnapshot().attachments).toEqual([]);
    expect(store.diagnostics().objectUrls).toBe(0);

    store.addFiles([{ name: "b.png", type: "image/png", size: 3, data: new Blob(["two"]) }]);
    await flushMicrotasks();
    const release = store.retainPreview("attachment-b");
    store.remove("attachment-b");
    expect(store.diagnostics().objectUrls).toBe(1);
    release?.();
    release?.();
    expect(store.diagnostics().objectUrls).toBe(0);
    expect(revoked).toEqual(["blob:preview-0", "blob:preview-1"]);
    store.destroy();
  });
});

function event(sequence: number, payload: unknown = {}): SessionEvent {
  return {
    id: `event-${sequence}`,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    sequence,
    type: "agent.message.delta",
    payload,
    occurredAt: "2026-08-29T12:00:00.000Z",
    clientEventId: null,
    turnId: null,
    turnGeneration: null,
    turnAttemptId: null,
    turnAssociation: null,
    duplicateOfEventId: null,
    duplicateReason: null,
  };
}

function draft(revision: number, text: string): ComposerDraft {
  return {
    revision,
    text,
    annotations: [],
    resources: [],
    model: "model-a",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sourceTurnId: null,
    sourceTurnVersion: null,
    updatedAt: "2026-08-29T12:00:00.000Z",
  };
}

function sessionResourceFixture(title: string): Session {
  return {
    id: SESSION_ID,
    workspaceId: WORKSPACE_ID,
    status: "idle",
    title,
    titleSource: "user",
    lastSequence: 1,
    mcpServers: [],
  } as unknown as Session;
}

function controlResponse(state: "active" | "paused"): SessionControlResponse {
  return {
    receipt: {
      id: "receipt-1",
      action: state === "paused" ? "session.paused" : "session.resumed",
      operationKey: "operation-1",
      targetSessionId: SESSION_ID,
      targetTurnId: null,
      appliedControlRevision: 1,
      appliedQueueVersion: null,
      appliedTurnVersion: null,
      appliedDraftRevision: null,
      createdAt: "2026-08-29T12:00:00.000Z",
    },
    effectiveControl: queueSnapshot(1, 1).effectiveControl,
    interruptionCount: state === "paused" ? 1 : 0,
    wakeCount: state === "active" ? 1 : 0,
    cancelledSessionCount: 0,
    cancelledTurnCount: 0,
  } as SessionControlResponse;
}

function queueSnapshot(
  version: number,
  controlVersion: number,
  items: SessionTurn[] = [queueTurn()],
): SessionQueueSnapshot {
  return {
    version,
    effectiveControl: {
      state: "active",
      controlVersion,
      controlEtag: `control-${controlVersion}`,
      directState: "active",
      primaryBlocker: null,
      additionalBlockerCount: 0,
      blockers: [],
      resumeOptions: [],
      override: null,
      settlement: null,
    },
    activePersonalConnections: [],
    stoppingPreviousAttempt: false,
    items,
    pendingInputs: [],
    pendingInputAttachment: null,
  };
}

function queueTurn(): SessionTurn {
  return {
    id: "turn-1",
    triggerEventId: "event-1",
    prompt: "queued prompt",
    annotations: [],
    resources: [],
    tools: [],
    metadata: { delivery: "send" },
    version: 4,
  } as unknown as SessionTurn;
}

function humanInputRequest(): SessionHumanInputRequest {
  return {
    id: "input-1",
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    turnId: "turn-1",
    turnGeneration: 1,
    creationAttemptId: "attempt-1",
    toolCallId: "tool-1",
    status: "pending",
    questions: [],
    allowSkip: true,
    response: null,
    respondedBy: null,
    respondedAt: null,
    expiresAt: null,
    createdAt: "2026-08-29T12:00:00.000Z",
    updatedAt: "2026-08-29T12:00:00.000Z",
  };
}

function fileAsset(id: string): FileAsset {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    status: "ready",
    filename: `${id}.png`,
    safeFilename: `${id}.png`,
    contentType: "image/png",
    sizeBytes: 3,
    sha256: null,
    bucket: "bucket",
    objectKey: id,
    createdAt: "2026-08-29T12:00:00.000Z",
    updatedAt: "2026-08-29T12:00:00.000Z",
  };
}

function deterministicEnvironment(
  ids: string[],
  objectUrls?: NonNullable<SessionRuntimeEnvironment["objectUrls"]>,
): SessionRuntimeEnvironment {
  return {
    clock: {
      now: () => Date.parse("2026-08-29T12:00:00.000Z"),
      setTimeout: () => 1,
      clearTimeout: () => undefined,
    },
    ids: { randomUUID: () => ids.shift() ?? "fallback-id" },
    ...(objectUrls ? { objectUrls } : {}),
  };
}

function fakeClock() {
  let nextTimer = 0;
  const timers = new Map<number, { callback: () => void; delayMs: number }>();
  const environment: SessionRuntimeEnvironment = {
    clock: {
      now: () => Date.parse("2026-08-29T12:00:00.000Z"),
      setTimeout: (callback, delayMs) => {
        const id = ++nextTimer;
        timers.set(id, { callback, delayMs });
        return id;
      },
      clearTimeout: (handle) => {
        timers.delete(handle as number);
      },
    },
    ids: { randomUUID: () => "composer-key" },
  };
  return { environment, timers };
}

function memoryStorage(): NonNullable<SessionRuntimeEnvironment["draftStorage"]> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

function scriptedEnvironment(ids: string[], initialVisibility: "visible" | "hidden" = "visible") {
  let now = Date.parse("2026-08-29T12:00:00.000Z");
  let visibility = initialVisibility;
  let nextTimer = 0;
  const timers = new Map<number, { callback: () => void; delayMs: number }>();
  const visibilityListeners = new Set<() => void>();
  const environment: SessionRuntimeEnvironment = {
    clock: {
      now: () => now,
      setTimeout: (callback, delayMs) => {
        const id = ++nextTimer;
        timers.set(id, { callback, delayMs });
        return id;
      },
      clearTimeout: (handle) => {
        timers.delete(handle as number);
      },
    },
    ids: { randomUUID: () => ids.shift() ?? "fallback-id" },
    visibility: {
      getState: () => visibility,
      subscribe(listener) {
        visibilityListeners.add(listener);
        return () => visibilityListeners.delete(listener);
      },
    },
  };
  return {
    environment,
    listenerCount: () => visibilityListeners.size,
    timerCount: () => timers.size,
    runDelay(delayMs: number) {
      const match = [...timers].find(([, timer]) => timer.delayMs === delayMs);
      if (!match) throw new Error(`No scripted timer found for ${delayMs}ms`);
      const [id, timer] = match;
      timers.delete(id);
      now += delayMs;
      timer.callback();
    },
    setVisibility(next: "visible" | "hidden") {
      visibility = next;
      for (const listener of [...visibilityListeners]) listener();
    },
  };
}

function outcomeUnknownError(): Error & { outcomeUnknown: true } {
  return Object.assign(new Error("transport outcome unknown"), { outcomeUnknown: true as const });
}

function sessionGoal(id: string, text: string): SessionGoal {
  return {
    id,
    accountId: "77777777-7777-4777-8777-777777777777",
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    status: "active",
    text,
    successCriteria: null,
    rootConstraints: [],
    evidence: null,
    rationale: null,
    pausedReason: null,
    createdBy: "api",
    version: 1,
    objectiveRevision: 1,
    mutationPolicy: "preserve_intent",
    autoContinuations: 0,
    noProgressStreak: 0,
    maxAutoContinuations: null,
    metadata: {},
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  };
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
