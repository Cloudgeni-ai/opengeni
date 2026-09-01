import {
  acquireSessionController,
  buildTimeline,
  clearSharedSessionControllers,
  createExternalStore,
  createFileAttachmentStore,
  createSessionComposerRuntimeStore,
  createSessionEventStore,
  sharedSessionControllerDiagnostics,
  type OpenGeniStoreDiagnostics,
  type SessionRuntimeEnvironment,
} from "@opengeni/sdk/session";
import type { ComposerDraft, FileAsset, SessionEvent } from "@opengeni/sdk";

const WORKSPACE_ID = "99999999-9999-4999-8999-999999999999";
const SESSION_ID = "88888888-8888-4888-8888-888888888888";

export type FrameworkUiSoakChunkReport = {
  iterations: number;
  eventBatches: number;
  eventsProcessed: number;
  historyTransitions: number;
  draftSaves: number;
  sends: number;
  visibilityTransitions: number;
  attachmentCycles: number;
  sharedOwnershipCycles: number;
  maxTimelineMilliseconds: number;
  maxComposerInputMilliseconds: number;
  resourceViolations: string[];
  finalSharedControllers: { activeControllers: number; owners: number };
};

let sequence = 0;
let identifier = 0;
let draftRevision = 0;

export async function runFrameworkUiSoakChunk(
  iterations: number,
): Promise<FrameworkUiSoakChunkReport> {
  clearSharedSessionControllers();
  const report: FrameworkUiSoakChunkReport = {
    iterations,
    eventBatches: 0,
    eventsProcessed: 0,
    historyTransitions: 0,
    draftSaves: 0,
    sends: 0,
    visibilityTransitions: 0,
    attachmentCycles: 0,
    sharedOwnershipCycles: 0,
    maxTimelineMilliseconds: 0,
    maxComposerInputMilliseconds: 0,
    resourceViolations: [],
    finalSharedControllers: { activeControllers: 0, owners: 0 },
  };

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const runtime = visibleRuntimeEnvironment();
    const history = sessionEvents(1_500);
    const live = sessionEvents(32);
    const eventStore = createSessionEventStore({
      client: {
        listEvents: async (
          _workspaceId: string,
          _sessionId: string,
          options: { before?: number; after?: number; limit?: number },
        ) => {
          const limit = options.limit ?? history.length;
          if (options.after !== undefined) {
            return history
              .filter((candidate) => candidate.sequence > options.after!)
              .slice(0, limit);
          }
          const before = options.before ?? Number.MAX_SAFE_INTEGER;
          return history.filter((candidate) => candidate.sequence < before).slice(-limit);
        },
        streamEvents: (
          _workspaceId: string,
          _sessionId: string,
          options: {
            signal?: AbortSignal;
            onStateChange?: (state: "live") => void;
            onOpen?: () => void;
          },
        ) =>
          (async function* () {
            options.onOpen?.();
            options.onStateChange?.("live");
            for (const liveEvent of live) yield liveEvent;
            await aborted(options.signal);
          })(),
        getSession: async () => ({ lastSequence: history.at(-1)?.sequence ?? 0 }),
      } as never,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      hiddenGraceMs: 0,
      environment: runtime.environment,
    });
    await eventStore.start();
    await delay(20);
    report.eventBatches += 1;
    report.eventsProcessed += live.length;
    if (eventStore.getSnapshot().hasOlder) {
      await eventStore.loadOlder();
      report.historyTransitions += 1;
      await eventStore.jumpToLatest();
      report.historyTransitions += 1;
    }
    runtime.setVisibility("hidden");
    await delay(0);
    runtime.setVisibility("visible");
    await delay(0);
    report.visibilityTransitions += 2;
    const timelineStartedAt = performance.now();
    buildTimeline(eventStore.getSnapshot().events);
    report.maxTimelineMilliseconds = Math.max(
      report.maxTimelineMilliseconds,
      performance.now() - timelineStartedAt,
    );
    eventStore.destroy();
    await delay(0);
    collectDiagnostics("events", eventStore.diagnostics(), report.resourceViolations);
    if (runtime.listenerCount() !== 0) {
      report.resourceViolations.push(`visibility listeners retained: ${runtime.listenerCount()}`);
    }

    let currentDraft = draft(++draftRevision, "");
    const composer = createSessionComposerRuntimeStore({
      client: {
        getComposerDraft: async () => currentDraft,
        saveComposerDraft: async (
          _workspaceId: string,
          _sessionId: string,
          request: { text: string; expectedRevision: number },
        ) => {
          currentDraft = draft(request.expectedRevision + 1, request.text);
          report.draftSaves += 1;
          return currentDraft;
        },
        sendMessage: async (
          _workspaceId: string,
          _sessionId: string,
          input: { text: string; clientEventId?: string },
        ) => {
          report.sends += 1;
          return event(
            "user.message",
            {
              text: input.text,
              routing: "accepted_for_execution",
            },
            input.clientEventId ?? null,
          );
        },
        submitComposerDraft: async (
          _workspaceId: string,
          _sessionId: string,
          request: {
            text: string;
            expectedDraftRevision: number;
            clientEventId: string;
          },
        ) => {
          report.sends += 1;
          const accepted = event(
            "user.message",
            { text: request.text, routing: "accepted_for_execution" },
            request.clientEventId,
          );
          currentDraft = draft(request.expectedDraftRevision + 1, "");
          return {
            accepted,
            turn: { id: `turn-${++identifier}`, prompt: request.text },
            draft: currentDraft,
            receipt: { id: `receipt-${identifier}` },
            routing: "accepted_for_execution",
            interruptionCount: 0,
            replay: false,
          } as never;
        },
        listEvents: async () => [],
        streamEvents: () => (async function* () {})(),
      } as never,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      events: [],
      autosaveDelayMs: 1,
      environment: runtime.environment,
    });
    await composer.start();
    const inputStartedAt = performance.now();
    composer.setValue(`soak draft ${iteration}`);
    report.maxComposerInputMilliseconds = Math.max(
      report.maxComposerInputMilliseconds,
      performance.now() - inputStartedAt,
    );
    await composer.saveNow();
    const sendsBefore = report.sends;
    await composer.send(`soak message ${iteration}`);
    await waitUntil(() => report.sends > sendsBefore);
    composer.destroy();
    await delay(0);
    collectDiagnostics("composer", composer.diagnostics(), report.resourceViolations);

    const attachmentStore = createFileAttachmentStore({
      client: {
        uploadFile: async () => fileAsset(`file-${++identifier}`),
      } as never,
      workspaceId: WORKSPACE_ID,
      environment: runtime.environment,
    });
    attachmentStore.start();
    attachmentStore.addFiles([
      new File([new Uint8Array([1, 2, 3, iteration % 255])], `soak-${iteration}.png`, {
        type: "image/png",
      }),
    ]);
    await waitUntil(() => !attachmentStore.getSnapshot().uploading);
    const attachment = attachmentStore.getSnapshot().attachments[0];
    const releasePreview = attachment ? attachmentStore.retainPreview(attachment.id) : undefined;
    releasePreview?.();
    attachmentStore.clear();
    attachmentStore.destroy();
    await delay(0);
    report.attachmentCycles += 1;
    collectDiagnostics("attachments", attachmentStore.diagnostics(), report.resourceViolations);

    const sharedClient = {};
    const first = acquireSessionController(
      {
        client: sharedClient,
        workspaceId: WORKSPACE_ID,
        sessionId: SESSION_ID,
        kind: "soak",
      },
      () => createExternalStore({ initialSnapshot: 0 }),
    );
    const second = acquireSessionController(
      {
        client: sharedClient,
        workspaceId: WORKSPACE_ID,
        sessionId: SESSION_ID,
        kind: "soak",
      },
      () => createExternalStore({ initialSnapshot: 1 }),
    );
    const unsubscribeFirst = first.controller.subscribe(() => undefined);
    const unsubscribeSecond = second.controller.subscribe(() => undefined);
    unsubscribeFirst();
    first.release();
    unsubscribeSecond();
    second.release();
    report.sharedOwnershipCycles += 1;
    const shared = sharedSessionControllerDiagnostics();
    if (shared.activeControllers !== 0 || shared.owners !== 0) {
      report.resourceViolations.push(
        `shared registry retained active=${shared.activeControllers} owners=${shared.owners}`,
      );
      clearSharedSessionControllers();
    }
  }

  report.finalSharedControllers = sharedSessionControllerDiagnostics();
  return report;
}

function visibleRuntimeEnvironment() {
  let state: "visible" | "hidden" = "visible";
  const listeners = new Set<() => void>();
  const environment: SessionRuntimeEnvironment = {
    clock: {
      now: () => Date.now(),
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    ids: { randomUUID: () => `soak-${++identifier}` },
    visibility: {
      getState: () => state,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    objectUrls: {
      create: (value) => URL.createObjectURL(value),
      revoke: (url) => URL.revokeObjectURL(url),
    },
  };
  return {
    environment,
    setVisibility(next: "visible" | "hidden") {
      state = next;
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

function sessionEvents(count: number): SessionEvent[] {
  return Array.from({ length: count }, (_, index) => {
    const type =
      index === 0 ? "session.created" : index % 17 === 0 ? "user.message" : "agent.message.delta";
    return event(
      type,
      type === "agent.message.delta" ? { delta: `token-${index}` } : { text: `message-${index}` },
    );
  });
}

function event(type: string, payload: unknown, clientEventId: string | null = null): SessionEvent {
  const currentSequence = ++sequence;
  return {
    id: `event-${currentSequence}`,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    sequence: currentSequence,
    type,
    payload,
    occurredAt: new Date().toISOString(),
    clientEventId,
    turnId: null,
    turnGeneration: null,
    turnAttemptId: null,
    turnAssociation: null,
    duplicateOfEventId: null,
    duplicateReason: null,
  } as SessionEvent;
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
    updatedAt: new Date().toISOString(),
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
    sizeBytes: 4,
    sha256: null,
    bucket: "soak",
    objectKey: id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function collectDiagnostics(
  label: string,
  diagnostics: OpenGeniStoreDiagnostics,
  violations: string[],
): void {
  for (const key of [
    "subscribers",
    "pendingReads",
    "streams",
    "timers",
    "listeners",
    "objectUrls",
  ] as const) {
    if (diagnostics[key] !== 0) violations.push(`${label}.${key}=${diagnostics[key]}`);
  }
  if (!diagnostics.destroyed) violations.push(`${label}.destroyed=false`);
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("soak operation timed out");
    await delay(0);
  }
}

async function aborted(signal?: AbortSignal): Promise<void> {
  if (!signal || signal.aborted) return;
  await new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

declare global {
  interface Window {
    __OPENGENI_RUN_FRAMEWORK_UI_SOAK_CHUNK__?: typeof runFrameworkUiSoakChunk;
  }
}

if (typeof window !== "undefined") {
  window.__OPENGENI_RUN_FRAMEWORK_UI_SOAK_CHUNK__ = runFrameworkUiSoakChunk;
}
