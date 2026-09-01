import { describe, expect, test } from "bun:test";
import type { FileAttachmentClientLike, SessionClientLike } from "@opengeni/sdk/session";
import type { OpenGeniSvelteContext } from "../src/context";
import {
  createSessionControllerComposition,
  reconcileSessionControllerComposition,
} from "../src/session-controller-composition";

function refreshable(name: string, calls: string[], failure?: Error) {
  return {
    controller: {
      refresh: async () => {
        calls.push(name);
        if (failure) throw failure;
      },
    },
  } as never;
}

describe("native Svelte session controller composition", () => {
  test("reconciles every authoritative projection even when one refresh rejects", async () => {
    const calls: string[] = [];
    const failure = new Error("queue refresh failed");
    const reconciliation = reconcileSessionControllerComposition({
      session: refreshable("session", calls),
      composer: refreshable("composer", calls),
      queue: refreshable("queue", calls, failure),
      goal: refreshable("goal", calls),
      humanInput: refreshable("humanInput", calls),
      lineage: refreshable("lineage", calls),
    });

    await expect(reconciliation).rejects.toBe(failure);
    expect(calls).toEqual(["session", "composer", "queue", "goal", "humanInput", "lineage"]);
  });

  test("a headless composed store starts the lazy shared feed and omits unsupported attachments", async () => {
    const streams = { calls: 0 };
    const client = baselineClient(streams);
    const context: OpenGeniSvelteContext = { client, workspaceId: "workspace-test" };
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    });
    const controllers = createSessionControllerComposition(context, "session-test");
    try {
      expect(controllers.attachments).toBeUndefined();
      expect(await controllers.session.controller.updateTitle("Unavailable mutation")).toBeNull();
      expect(controllers.session.controller.getSnapshot().mutationError?.message).toBe(
        "Session title updates are unavailable for this client.",
      );
      controllers.session.controller.clearMutationError();
      expect(controllers.events.controller.diagnostics().started).toBe(false);
      const unsubscribeQueue = controllers.queue.store.subscribe(() => undefined);
      const unsubscribeSession = controllers.session.store.subscribe(() => undefined);
      expect(controllers.events.controller.diagnostics().started).toBe(true);
      for (let tick = 0; tick < 8 && streams.calls === 0; tick += 1) await Promise.resolve();
      expect(streams.calls).toBe(1);
      unsubscribeQueue();
      await Promise.resolve();
      expect(controllers.events.controller.diagnostics().destroyed).toBe(false);
      expect(controllers.queue.controller.diagnostics().destroyed).toBe(false);
      const unsubscribeRemountedQueue = controllers.queue.store.subscribe(() => undefined);
      expect(streams.calls).toBe(1);
      unsubscribeRemountedQueue();
      await Promise.resolve();
      expect(controllers.events.controller.diagnostics().destroyed).toBe(false);
      unsubscribeSession();
      await Promise.resolve();
      expect(controllers.events.controller.diagnostics().destroyed).toBe(true);
      expect(controllers.queue.controller.diagnostics().destroyed).toBe(true);
    } finally {
      controllers.destroy();
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });

  test("composes attachment state only when an upload capability is supplied", () => {
    const client = Object.assign(baselineClient({ calls: 0 }), {
      uploadFile: async () => ({}) as never,
    }) as SessionClientLike & FileAttachmentClientLike;
    const controllers = createSessionControllerComposition(
      { client, workspaceId: "workspace-test" },
      "session-test",
    );
    try {
      expect(controllers.attachments).toBeDefined();
    } finally {
      controllers.destroy();
    }
  });
});

function baselineClient(streams: { calls: number }): SessionClientLike {
  const unavailable = async () => {
    throw new Error("not used by this composition test");
  };
  return {
    getSession: async () => ({ lastSequence: 0 }) as never,
    listEvents: async () => [],
    streamEvents: () => {
      streams.calls += 1;
      return {
        [Symbol.asyncIterator]() {
          return {
            next: async () => ({ done: true, value: undefined }),
          };
        },
      } as never;
    },
    getComposerDraft: unavailable,
    saveComposerDraft: unavailable,
    submitComposerDraft: unavailable,
    sendMessage: unavailable,
    steerMessage: unavailable,
    getQueue: async () => ({}) as never,
    moveQueueItem: unavailable,
    editQueueItem: unavailable,
    steerQueueItem: unavailable,
    deleteQueueItem: unavailable,
    pauseSession: unavailable,
    resumeSession: unavailable,
    sendApprovalDecision: unavailable,
  } as SessionClientLike;
}
