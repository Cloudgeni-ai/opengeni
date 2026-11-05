/* ----------------------------------------------------------------------------
   "Draft changed" (409 DRAFT_CHANGED) on a composer draft save.

   - An explicit Send delivers the person's text exactly once: the save
     re-reads the draft and either finds the same content already there or
     saves the person's text at the current revision.
   - One tab can fall behind its own writes (a save whose reply is lost, a
     save that lands after the composer remounted). That is not "another
     tab": autosave catches up silently.
   - A real edit from another tab while typing still offers Keep mine / Use
     other draft, without a generic "conflicts with the current state" error.
   -------------------------------------------------------------------------- */
import { beforeEach, describe, expect, test } from "bun:test";
import { OpenGeniApiError, type ComposerDraft, type SessionEvent } from "@opengeni/sdk";

import { useComposer } from "../src/hooks/use-composer";
import { fakeClient, fakeTurn, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderHook } from "./render-hook";

registerDom({ clock: "real" });

let sessionId = crypto.randomUUID();
beforeEach(() => {
  sessionId = crypto.randomUUID();
});

function draftChanged(): OpenGeniApiError {
  return new OpenGeniApiError(
    409,
    JSON.stringify({ code: "DRAFT_CHANGED", message: "Composer draft changed" }),
    { mutation: true },
  );
}

/** The server's one draft slot with its revision fence. */
function draftServer() {
  const slot = { revision: 1, text: "" };
  const saves: string[] = [];
  const delivered: string[] = [];
  let loseNextSaveReply = false;
  let holdNextSave: Promise<void> | null = null;
  let sequence = 0;
  const base = fakeClient({});
  const read = async (): Promise<ComposerDraft> => ({
    ...(await base.getComposerDraft(WORKSPACE_ID, sessionId)),
    revision: slot.revision,
    text: slot.text,
  });
  const client = fakeClient({
    getComposerDraft: async () => await read(),
    saveComposerDraft: async (_workspaceId, _sessionId, request) => {
      const held = holdNextSave;
      holdNextSave = null;
      if (held) await held;
      if (request.expectedRevision !== slot.revision) {
        saves.push(`${request.expectedRevision} ${request.text}: draft changed`);
        throw draftChanged();
      }
      slot.revision += 1;
      slot.text = request.text;
      saves.push(`${request.expectedRevision} ${request.text}`);
      if (loseNextSaveReply) {
        loseNextSaveReply = false;
        // Committed, but the reply never reached the page.
        throw new OpenGeniApiError(0, "", {
          code: "network_error",
          retryable: true,
          outcomeUnknown: true,
          mutation: true,
        });
      }
      return await read();
    },
    submitComposerDraft: async (_workspaceId, _sessionId, request) => {
      if (request.expectedDraftRevision !== slot.revision || request.text !== slot.text) {
        throw draftChanged();
      }
      slot.revision += 1;
      slot.text = "";
      delivered.push(request.text);
      const accepted = {
        id: crypto.randomUUID(),
        workspaceId: WORKSPACE_ID,
        sessionId,
        sequence: ++sequence,
        type: "user.message",
        payload: { text: request.text },
        clientEventId: request.clientEventId ?? null,
        occurredAt: new Date().toISOString(),
      } as SessionEvent;
      const turn = fakeTurn({ prompt: request.text });
      return {
        accepted,
        turn,
        draft: await read(),
        receipt: {
          id: crypto.randomUUID(),
          action: "prompt.send",
          operationKey: request.clientEventId ?? crypto.randomUUID(),
          targetSessionId: sessionId,
          targetTurnId: turn.id,
          appliedControlRevision: null,
          appliedQueueVersion: null,
          appliedTurnVersion: null,
          appliedDraftRevision: slot.revision,
          createdAt: new Date().toISOString(),
        },
        routing: "accepted_for_execution",
        interruptionCount: 0,
        replay: false,
      };
    },
  });
  return {
    client,
    slot,
    saves,
    delivered,
    /** Another tab (or device) of the same person edits the draft. */
    otherTabWrites(text: string) {
      slot.revision += 1;
      slot.text = text;
    },
    loseNextSaveReply() {
      loseNextSaveReply = true;
    },
    holdNextSave(): () => void {
      let release!: () => void;
      holdNextSave = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition() && Date.now() < deadline) await flush(10);
  await flush(20);
}

function mount(server: ReturnType<typeof draftServer>) {
  return renderHook(
    () => useComposer(sessionId, { client: server.client, workspaceId: WORKSPACE_ID }),
    undefined,
  );
}

describe("composer draft changed", () => {
  test("Send after another tab changed the draft delivers the sender's text once", async () => {
    const server = draftServer();
    const hook = await mount(server);
    try {
      await flush(20);
      await actRun(() => hook.result.current.setValue("draft"));
      await until(() => server.slot.text === "draft");
      await actRun(() => hook.result.current.setValue("what I send"));
      server.otherTabWrites("from the other tab");
      await actRun(async () => {
        await hook.result.current.send();
      });
      await until(() => server.delivered.length > 0);

      expect(server.delivered).toEqual(["what I send"]);
      expect(hook.result.current.draftConflict).toBeNull();
      expect(hook.result.current.error).toBeNull();
      expect(
        (hook.result.current.optimisticMessages ?? []).filter(
          (message) => message.state === "failed",
        ),
      ).toEqual([]);
    } finally {
      await hook.unmount();
    }
  });

  test("Send whose text is already saved at a newer revision just sends it", async () => {
    const server = draftServer();
    const hook = await mount(server);
    try {
      await flush(20);
      await actRun(() => hook.result.current.setValue("same text"));
      // The same text arrives at a newer revision this page does not know.
      server.otherTabWrites("same text");
      await actRun(async () => {
        await hook.result.current.send();
      });
      await until(() => server.delivered.length > 0);

      expect(server.delivered).toEqual(["same text"]);
      // One refused save, then no second write: the content was already there.
      expect(server.saves).toEqual(["1 same text: draft changed"]);
      expect(hook.result.current.draftConflict).toBeNull();
      expect(hook.result.current.error).toBeNull();
      expect(
        (hook.result.current.optimisticMessages ?? []).filter(
          (message) => message.state === "failed",
        ),
      ).toEqual([]);
    } finally {
      await hook.unmount();
    }
  });

  test("a save whose reply was lost is this tab's own write, not another tab", async () => {
    const server = draftServer();
    const hook = await mount(server);
    try {
      await flush(20);
      server.loseNextSaveReply();
      await actRun(() => hook.result.current.setValue("hello"));
      await until(() => server.slot.text === "hello");
      await flush(50);
      await actRun(() => hook.result.current.setValue("hello world"));
      await until(() => server.slot.text === "hello world");

      expect(server.saves).toEqual(["1 hello", "1 hello world: draft changed", "2 hello world"]);
      expect(hook.result.current.draftConflict).toBeNull();
      expect(hook.result.current.draft?.revision).toBe(3);

      await actRun(async () => {
        await hook.result.current.send();
      });
      await until(() => server.delivered.length > 0);
      expect(server.delivered).toEqual(["hello world"]);
    } finally {
      await hook.unmount();
    }
  });

  test("a save landing after the composer remounted is this tab's own write", async () => {
    const server = draftServer();
    const first = await mount(server);
    await flush(20);
    const release = server.holdNextSave();
    await actRun(() => first.result.current.setValue("typed before leaving"));
    // Past the autosave delay: the save is now on the wire, held by the server.
    await flush(600);
    // The person leaves the chat and comes back while that save is in flight:
    // the new composer reads the draft before the old save commits.
    await first.unmount();
    const second = await mount(server);
    try {
      await flush(20);
      expect(second.result.current.draft?.revision).toBe(1);
      release();
      await until(() => server.slot.text === "typed before leaving");
      await actRun(() => second.result.current.setValue("typed after coming back"));
      await until(() => server.slot.text === "typed after coming back");

      expect(second.result.current.draftConflict).toBeNull();
      expect(second.result.current.error).toBeNull();
    } finally {
      await second.unmount();
    }
  });

  test("typing over another tab's edit still offers Keep mine and Use other draft", async () => {
    const server = draftServer();
    const hook = await mount(server);
    try {
      await flush(20);
      server.otherTabWrites("theirs");
      await actRun(() => hook.result.current.setValue("mine"));
      await until(() => hook.result.current.draftConflict !== null);

      expect(hook.result.current.draftConflict?.message).toContain("Composer draft changed");
      // The choice is the message; no generic "conflicts with the current state".
      expect(hook.result.current.error).toBeNull();
      expect(hook.result.current.value).toBe("mine");
      expect(server.slot.text).toBe("theirs");

      await actRun(async () => {
        await hook.result.current.resolveDraftConflict("keep_mine");
      });
      expect(server.slot.text).toBe("mine");
      expect(hook.result.current.draftConflict).toBeNull();

      server.otherTabWrites("theirs again");
      await actRun(() => hook.result.current.setValue("mine again"));
      await until(() => hook.result.current.draftConflict !== null);
      await actRun(async () => {
        await hook.result.current.resolveDraftConflict("use_remote");
      });
      expect(hook.result.current.value).toBe("theirs again");
      expect(server.slot.text).toBe("theirs again");
      expect(hook.result.current.draftConflict).toBeNull();
    } finally {
      await hook.unmount();
    }
  });
});
