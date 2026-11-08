import type { ChatClient } from "@opengeni/sdk";
/* ----------------------------------------------------------------------------
   "Draft changed" (409 DRAFT_CHANGED) on a composer draft save.

   - Send wins: an explicit Send delivers what is in the box exactly once and
     is never refused because of the draft. The server clears the draft only
     while it still holds what was sent; a newer draft from another device
     stays and the composer shows it.
   - One tab can fall behind its own writes (a save whose reply is lost, a
     save that lands after the composer remounted). That is not "another
     tab": autosave catches up silently.
   - Typing over another device's edit saves on top of it (latest typing
     wins), with nothing to choose.
   -------------------------------------------------------------------------- */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  OpenGeniApiError,
  type ComposerDraft,
  type SessionEvent,
  type WorkspaceDraftsChangedEvent,
} from "@opengeni/sdk";
import { useMemo } from "react";

import { useComposer, type ComposerControllerState } from "../src/hooks/use-composer";
import { OpenGeniContext, type OpenGeniContextValue } from "../src/session-context";
import { fakeClient, fakeTurn, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderComponent, renderHook } from "./render-hook";

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

/** The server's one draft slot: saves are fenced on its revision; Send is not. */
function draftServer() {
  const slot = { revision: 1, text: "" };
  const saves: string[] = [];
  const delivered: string[] = [];
  const submits: { clientEventId: string | undefined; expectedDraftRevision: number }[] = [];
  let loseNextSaveReply = false;
  let failSaves = false;
  let failNextSubmit = false;
  let refuseNextSubmit = false;
  let holdNextSave: Promise<void> | null = null;
  let holdNextRead: Promise<void> | null = null;
  let holdNextSubmit: Promise<void> | null = null;
  let beforeSubmit: (() => void) | null = null;
  let sequence = 0;
  const base = fakeClient({});
  const read = async (): Promise<ComposerDraft> => ({
    ...(await base.getComposerDraft(WORKSPACE_ID, sessionId)),
    revision: slot.revision,
    text: slot.text,
  });
  const client = fakeClient({
    getComposerDraft: async () => {
      // What the server held when the read arrived, however late the reply.
      const snapshot = await read();
      const held = holdNextRead;
      holdNextRead = null;
      if (held) await held;
      return snapshot;
    },
    saveComposerDraft: async (_workspaceId, _sessionId, request) => {
      const held = holdNextSave;
      holdNextSave = null;
      if (held) await held;
      if (failSaves) {
        saves.push(`${request.expectedRevision} ${request.text}: refused`);
        throw draftChanged();
      }
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
      const held = holdNextSubmit;
      holdNextSubmit = null;
      if (held) await held;
      beforeSubmit?.();
      beforeSubmit = null;
      submits.push({
        clientEventId: request.clientEventId,
        expectedDraftRevision: request.expectedDraftRevision,
      });
      if (failNextSubmit) {
        failNextSubmit = false;
        // Opengeni is updating: nothing was accepted, and the send is retried.
        throw new OpenGeniApiError(503, JSON.stringify({ message: "Updating" }), {
          mutation: true,
        });
      }
      if (refuseNextSubmit) {
        refuseNextSubmit = false;
        // Refused for good: nothing was accepted and nothing is retried.
        throw new OpenGeniApiError(
          422,
          JSON.stringify({ code: "invalid_request", message: "Not accepted" }),
          { mutation: true },
        );
      }
      // Clear the draft only while it still holds what was sent.
      if (request.expectedDraftRevision === slot.revision || request.text === slot.text) {
        slot.revision += 1;
        slot.text = "";
      }
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
    submits,
    /** Another tab (or device) of the same person edits the draft. */
    otherTabWrites(text: string) {
      slot.revision += 1;
      slot.text = text;
    },
    loseNextSaveReply() {
      loseNextSaveReply = true;
    },
    /** Every save is refused, as when another device keeps writing. */
    failSaves() {
      failSaves = true;
    },
    /** Runs just before the server accepts the next Send. */
    beforeSubmit(run: () => void) {
      beforeSubmit = run;
    },
    holdNextSave(): () => void {
      let release!: () => void;
      holdNextSave = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    holdNextRead(): () => void {
      let release!: () => void;
      holdNextRead = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    holdNextSubmit(): () => void {
      let release!: () => void;
      holdNextSubmit = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    failNextSubmit() {
      failNextSubmit = true;
    },
    refuseNextSubmit() {
      refuseNextSubmit = true;
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

/** A composer under a host that delivers "your drafts changed" hints. */
async function mountFollowing(server: ReturnType<typeof draftServer>) {
  const result: { current: ComposerControllerState | null } = { current: null };
  function Composer() {
    result.current = useComposer(sessionId, {
      client: server.client,
      workspaceId: WORKSPACE_ID,
    });
    return null;
  }
  function Harness({ event }: { event: WorkspaceDraftsChangedEvent | null }) {
    const value = useMemo<OpenGeniContextValue<ChatClient>>(
      () => ({
        client: server.client,
        workspaceId: WORKSPACE_ID,
        workspaceControlEvent: null,
        workspaceControlConnectionState: "live",
        workspaceInteractionEvent: null,
        workspaceInteractionConnectionState: "live",
        workspaceDraftsEvent: event,
        registerSessionReconciler: () => () => {},
        reconcileSession: async () => {},
      }),
      [event],
    );
    return (
      <OpenGeniContext.Provider value={value}>
        <Composer />
      </OpenGeniContext.Provider>
    );
  }
  const mounted = await renderComponent(<Harness event={null} />);
  return {
    result,
    /** The hint carries no text: the composer re-reads its own draft. */
    hint: async () =>
      await mounted.rerender(
        <Harness
          event={{
            type: "workspace.drafts.changed",
            workspaceId: WORKSPACE_ID,
            sessionIds: [sessionId],
            newSession: false,
          }}
        />,
      ),
    unmount: mounted.unmount,
  };
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
      // Send never saved over the other tab's newer draft: it stays, and shows.
      expect(server.saves).toEqual(["1 draft", "2 what I send: draft changed"]);
      expect(server.slot.text).toBe("from the other tab");
      await until(() => hook.result.current.value === "from the other tab");
      expect(hook.result.current.value).toBe("from the other tab");
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

  test("Send saves over this tab's own write whose reply was lost, then clears the draft", async () => {
    const server = draftServer();
    const hook = await mount(server);
    try {
      await flush(20);
      server.loseNextSaveReply();
      await actRun(() => hook.result.current.setValue("hello"));
      await until(() => server.slot.text === "hello");
      await flush(50);
      // Sent before autosave catches up: the newer draft is this tab's own.
      await actRun(() => hook.result.current.setValue("hello world"));
      await actRun(async () => {
        await hook.result.current.send();
      });
      await until(() => server.delivered.length > 0);

      expect(server.delivered).toEqual(["hello world"]);
      expect(server.saves).toEqual(["1 hello", "1 hello world: draft changed", "2 hello world"]);
      expect(server.slot.text).toBe("");
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

  test("typing over another device's edit saves on top of it, with nothing to choose", async () => {
    const server = draftServer();
    const hook = await mount(server);
    try {
      await flush(20);
      server.otherTabWrites("theirs");
      await actRun(() => hook.result.current.setValue("mine"));
      // The latest typing wins: the save moves onto the newer revision.
      await until(() => server.slot.text === "mine");
      expect(hook.result.current.draftConflict).toBeNull();
      expect(hook.result.current.error).toBeNull();
      expect(hook.result.current.value).toBe("mine");
    } finally {
      await hook.unmount();
    }
  });

  test("Send goes through even when the pre-send save is refused", async () => {
    const server = draftServer();
    const hook = await mount(server);
    try {
      await flush(20);
      server.failSaves();
      await actRun(() => hook.result.current.setValue("send me anyway"));
      await actRun(async () => {
        await hook.result.current.send();
      });
      await until(() => server.delivered.length > 0);

      expect(server.delivered).toEqual(["send me anyway"]);
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

  test("after Send, a newer draft from another device stays and is shown", async () => {
    const server = draftServer();
    const hook = await mount(server);
    try {
      await flush(20);
      await actRun(() => hook.result.current.setValue("first message"));
      await until(() => server.slot.text === "first message");
      // Another device types its next message while this Send is on the wire.
      server.beforeSubmit(() => server.otherTabWrites("typed on my phone"));
      await actRun(async () => {
        await hook.result.current.send();
      });
      await until(() => server.delivered.length > 0);
      await until(() => hook.result.current.value === "typed on my phone");

      expect(server.delivered).toEqual(["first message"]);
      expect(server.slot.text).toBe("typed on my phone");
      expect(hook.result.current.value).toBe("typed on my phone");
      expect(hook.result.current.draftConflict).toBeNull();
      expect(hook.result.current.error).toBeNull();
    } finally {
      await hook.unmount();
    }
  });

  test("a composer nobody is typing in follows the person's other device live", async () => {
    const server = draftServer();
    const mounted = await mountFollowing(server);
    const { result } = mounted;
    try {
      await flush(20);
      server.otherTabWrites("typed on my laptop");
      await mounted.hint();
      await until(() => result.current?.value === "typed on my laptop");
      expect(result.current?.value).toBe("typed on my laptop");
      expect(result.current?.draft?.revision).toBe(server.slot.revision);
      expect(result.current?.draftConflict).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  test("a change announced while the draft is being read is read again, not missed", async () => {
    const server = draftServer();
    const mounted = await mountFollowing(server);
    const { result } = mounted;
    try {
      await flush(20);
      // A read starts, and answers with the draft as it was then.
      const release = server.holdNextRead();
      await mounted.hint();
      await flush(20);
      // Meanwhile the other device saves and its hint arrives.
      server.otherTabWrites("typed on my laptop");
      await mounted.hint();
      release();
      await until(() => result.current?.value === "typed on my laptop");
      expect(result.current?.value).toBe("typed on my laptop");
      expect(result.current?.draft?.revision).toBe(server.slot.revision);
    } finally {
      await mounted.unmount();
    }
  });

  test("a retried Send repeats its first attempt exactly, even after the draft moved on", async () => {
    const server = draftServer();
    const mounted = await mountFollowing(server);
    const { result } = mounted;
    try {
      await flush(20);
      await actRun(() => result.current!.setValue("deploy it"));
      await until(() => server.slot.text === "deploy it");
      server.failNextSubmit();
      await actRun(async () => {
        await result.current!.send();
      });
      await until(() => server.submits.length === 1);
      // While the send waits to be retried, the person's laptop saves a new draft.
      server.otherTabWrites("next thought");
      await mounted.hint();
      await until(() => result.current?.draft?.revision === server.slot.revision);
      await until(() => server.delivered.length > 0);

      expect(server.delivered).toEqual(["deploy it"]);
      expect(server.submits).toHaveLength(2);
      expect(server.submits[1]).toEqual(server.submits[0]!);
      // The newer draft was not what was sent, so it stays.
      expect(server.slot.text).toBe("next thought");
    } finally {
      await mounted.unmount();
    }
  });

  test("Send never clears a newer draft from another device that was read but not shown", async () => {
    const server = draftServer();
    const mounted = await mountFollowing(server);
    const { result } = mounted;
    try {
      await flush(20);
      await actRun(() => result.current!.setValue("draft"));
      await until(() => server.slot.text === "draft");
      const sentFrom = server.slot.revision;
      await actRun(() => result.current!.setValue("what I send"));
      // Before that typing is saved, the person's phone saves a draft and its
      // hint arrives. The typing here stays in the box.
      server.otherTabWrites("typed on my phone");
      await mounted.hint();
      await until(() => result.current?.draft?.revision === server.slot.revision);
      expect(result.current?.value).toBe("what I send");
      await actRun(async () => {
        await result.current!.send();
      });
      await until(() => server.delivered.length > 0);
      await until(() => result.current?.value === "typed on my phone");

      expect(server.delivered).toEqual(["what I send"]);
      // Send went ahead from the draft this page last saved, without saving
      // over the phone's draft, so the server kept it.
      expect(server.submits.map((submit) => submit.expectedDraftRevision)).toEqual([sentFrom]);
      expect(server.saves.filter((save) => save.includes("what I send"))).toEqual([]);
      expect(server.slot.text).toBe("typed on my phone");
      expect(result.current?.value).toBe("typed on my phone");
    } finally {
      await mounted.unmount();
    }
  });

  test("a refused Send that left a newer draft in place never blanks it", async () => {
    const server = draftServer();
    const hook = await mount(server);
    try {
      await flush(20);
      await actRun(() => hook.result.current.setValue("draft"));
      await until(() => server.slot.text === "draft");
      await actRun(() => hook.result.current.setValue("what I send"));
      server.otherTabWrites("typed on my phone");
      server.refuseNextSubmit();
      await actRun(async () => {
        await hook.result.current.send();
      });
      await until(() => server.submits.length > 0);
      await until(() =>
        (hook.result.current.optimisticMessages ?? []).some(
          (message) => message.state === "failed",
        ),
      );
      // Well past the autosave pause.
      await flush(1_200);

      expect(server.delivered).toEqual([]);
      expect(server.slot.text).toBe("typed on my phone");
      expect(server.saves.filter((save) => !save.includes("draft changed"))).toEqual(["1 draft"]);
    } finally {
      await hook.unmount();
    }
  });

  test("a newer draft read while a Send is on the wire survives that Send being refused", async () => {
    const server = draftServer();
    const mounted = await mountFollowing(server);
    const { result } = mounted;
    try {
      await flush(20);
      await actRun(() => result.current!.setValue("what I send"));
      await until(() => server.slot.text === "what I send");
      const release = server.holdNextSubmit();
      server.refuseNextSubmit();
      await actRun(async () => {
        await result.current!.send();
      });
      await flush(50);
      // While the Send is on the wire, the person's phone saves a draft and
      // its hint is read.
      server.otherTabWrites("typed on my phone");
      await mounted.hint();
      await until(() => result.current?.draft?.revision === server.slot.revision);
      release();
      await until(() =>
        (result.current?.optimisticMessages ?? []).some((message) => message.state === "failed"),
      );
      // Well past the autosave pause.
      await flush(1_200);

      expect(server.delivered).toEqual([]);
      expect(server.slot.text).toBe("typed on my phone");
      expect(server.saves).toEqual(["1 what I send"]);
    } finally {
      await mounted.unmount();
    }
  });

  test("Steer waits for this page's own running save before choosing its draft basis", async () => {
    const server = draftServer();
    const mounted = await mountFollowing(server);
    const { result } = mounted;
    try {
      await flush(20);
      await actRun(() => result.current!.setValue("draft"));
      await until(() => server.slot.text === "draft");
      await actRun(() => result.current!.setValue("what I sen"));
      // The phone saves a draft and its hint is read while this page types.
      server.otherTabWrites("typed on my phone");
      await mounted.hint();
      await until(() => result.current?.draft?.revision === server.slot.revision);
      // Autosave then saves the typing here on top, but its reply is slow.
      const release = server.holdNextSave();
      await flush(700);
      await actRun(() => result.current!.setValue("what I send"));
      let steered: Promise<boolean> | null = null;
      await actRun(() => {
        steered = result.current!.steer();
      });
      await flush(20);
      release();
      await actRun(async () => {
        await steered;
      });
      await until(() => server.delivered.length > 0);

      expect(server.delivered).toEqual(["what I send"]);
      // The page's own save was the basis, so the draft holding a piece of
      // the sent message was saved over and cleared, not kept.
      expect(server.saves).toEqual(["1 draft", "3 what I sen", "4 what I send"]);
      expect(server.submits.map((submit) => submit.expectedDraftRevision)).toEqual([5]);
      expect(server.slot.text).toBe("");
    } finally {
      await mounted.unmount();
    }
  });
});
