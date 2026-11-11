import { describe, expect, test } from "bun:test";
import type {
  ComposerDraft,
  LatencyMode,
  ReasoningEffort,
  SaveComposerDraftRequest,
  SessionEvent,
  SubmitComposerDraftRequest,
} from "@opengeni/sdk";

import { useComposer } from "../src/hooks/use-composer";
import { fakeClient, fakeTurn, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderHook } from "./render-hook";

registerDom({ clock: "virtual" });

type Policy = { model: string; reasoningEffort: ReasoningEffort; latencyMode: LatencyMode };

function event(sequence: number, type: string): SessionEvent {
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    sequence,
    type,
    payload: {},
    occurredAt: new Date().toISOString(),
  };
}

/**
 * The API's composer-draft rules in memory: a draft either holds the person's
 * pick or follows the chat's settings, a Send from a pick makes it the chat's
 * setting, and every accepted Send leaves a following draft behind.
 */
function chatServer(initial: Policy) {
  let chat: Policy = { ...initial };
  let row = {
    revision: 0,
    text: "",
    resources: [] as ComposerDraft["resources"],
    annotations: [] as NonNullable<ComposerDraft["annotations"]>,
    follows: true,
    policy: { ...initial },
  };
  const saves: SaveComposerDraftRequest[] = [];
  const submits: SubmitComposerDraftRequest[] = [];
  const read = (): ComposerDraft => ({
    revision: row.revision,
    text: row.text,
    resources: row.resources,
    annotations: row.annotations,
    ...(row.follows ? chat : row.policy),
    policyFollowsSession: row.follows,
    sourceTurnId: null,
    sourceTurnVersion: null,
    updatedAt: row.revision === 0 ? null : new Date().toISOString(),
  });
  const client = fakeClient({
    getComposerDraft: async () => read(),
    saveComposerDraft: async (_workspaceId, _sessionId, request) => {
      saves.push(request);
      if (request.expectedRevision !== row.revision) throw new Error("DRAFT_CHANGED");
      const picked = request.model !== undefined;
      row = {
        revision: row.revision + 1,
        text: request.text,
        resources: request.resources,
        annotations: request.annotations ?? [],
        follows: !picked,
        policy: picked
          ? {
              model: request.model!,
              reasoningEffort: request.reasoningEffort ?? chat.reasoningEffort,
              latencyMode: request.latencyMode ?? chat.latencyMode,
            }
          : { ...chat },
      };
      return read();
    },
    submitComposerDraft: async (_workspaceId, _sessionId, request) => {
      submits.push(request);
      if (request.expectedDraftRevision !== row.revision) throw new Error("DRAFT_CHANGED");
      const turnPolicy: Policy = row.follows ? { ...chat } : { ...row.policy };
      // Only a person's pick sets the chat's future settings.
      if (!row.follows) chat = turnPolicy;
      row = { ...row, revision: row.revision + 1, text: "", follows: true, policy: turnPolicy };
      const turn = fakeTurn({ prompt: request.text, ...turnPolicy });
      return {
        accepted: { ...event(100 + submits.length, "user.message"), turnId: turn.id },
        turn,
        draft: read(),
        receipt: {
          id: crypto.randomUUID(),
          action: "prompt.submit",
          operationKey: request.clientEventId,
          targetSessionId: SESSION_ID,
          targetTurnId: turn.id,
          appliedControlRevision: null,
          appliedQueueVersion: 2,
          appliedTurnVersion: 1,
          appliedDraftRevision: row.revision,
          createdAt: new Date().toISOString(),
        },
        routing: "accepted_for_execution" as const,
        interruptionCount: 0,
        replay: false,
      };
    },
  });
  return {
    client,
    saves,
    submits,
    chat: () => chat,
    /** The agent switches the chat's model outside the composer. */
    agentSetsModel: (model: string) => {
      chat = { ...chat, model };
    },
  };
}

async function act(run: () => unknown): Promise<void> {
  await actRun(async () => {
    await run();
  });
}

describe("useComposer follows the chat's own settings until the person picks", () => {
  test("an agent's model switch is shown and kept by the next Send", async () => {
    const server = chatServer({
      model: "paid-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
    });
    const hook = await renderHook(
      (events: SessionEvent[]) =>
        useComposer(SESSION_ID, { client: server.client, workspaceId: WORKSPACE_ID, events }),
      [] as SessionEvent[],
    );
    await flush();
    expect(hook.result.current.policy?.model).toBe("paid-model");

    // The agent switches the chat's model; the draft's revision is unchanged.
    server.agentSetsModel("free-model");
    await hook.rerender([event(5, "session.model_settings.updated")]);
    await flush(300);
    expect(hook.result.current.policy?.model).toBe("free-model");

    await act(() => hook.result.current.setValue("next question"));
    await flush(600);
    expect(server.saves.at(-1)).toMatchObject({ text: "next question" });
    expect(server.saves.at(-1)?.model).toBeUndefined();

    await act(async () => expect(await hook.result.current.send()).toBe(true));
    await flush();
    expect(server.submits).toHaveLength(1);
    expect(server.submits[0]?.model).toBeUndefined();
    expect(server.submits[0]?.reasoningEffort).toBeUndefined();
    expect(server.submits[0]?.latencyMode).toBeUndefined();
    expect(server.chat().model).toBe("free-model");
    expect(hook.result.current.sendPolicy).toBeNull();
    await hook.unmount();
  });

  test("a pick in the composer is saved and sent, then the composer follows again", async () => {
    const server = chatServer({
      model: "paid-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
    });
    const hook = await renderHook(
      (events: SessionEvent[]) =>
        useComposer(SESSION_ID, { client: server.client, workspaceId: WORKSPACE_ID, events }),
      [] as SessionEvent[],
    );
    await flush();
    await act(() => hook.result.current.setModel("picked-model"));
    await act(() => hook.result.current.setValue("use my pick"));
    await flush(600);
    expect(server.saves.at(-1)).toMatchObject({ text: "use my pick", model: "picked-model" });

    await act(async () => expect(await hook.result.current.send()).toBe(true));
    await flush();
    expect(server.submits[0]).toMatchObject({ model: "picked-model" });
    expect(server.chat().model).toBe("picked-model");

    // A later switch by the agent is not undone by the person's next message.
    server.agentSetsModel("free-model");
    await hook.rerender([event(9, "session.model_settings.updated")]);
    await flush(300);
    expect(hook.result.current.policy?.model).toBe("free-model");
    await act(() => hook.result.current.setValue("and then"));
    await flush(600);
    await act(async () => expect(await hook.result.current.send()).toBe(true));
    await flush();
    expect(server.submits[1]?.model).toBeUndefined();
    expect(server.chat().model).toBe("free-model");
    // The sent pick became the chat's setting and the composer follows it.
    expect(hook.result.current.sendPolicy).toBeNull();
    await hook.unmount();
  });

  test("a pick made before the agent's switch still wins", async () => {
    const server = chatServer({
      model: "paid-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
    });
    const hook = await renderHook(
      (events: SessionEvent[]) =>
        useComposer(SESSION_ID, { client: server.client, workspaceId: WORKSPACE_ID, events }),
      [] as SessionEvent[],
    );
    await flush();
    await act(() => hook.result.current.setModel("picked-model"));
    await act(() => hook.result.current.setValue("draft with a pick"));
    await flush(600);
    server.agentSetsModel("free-model");
    await hook.rerender([event(5, "session.model_settings.updated")]);
    await flush(300);
    expect(hook.result.current.policy?.model).toBe("picked-model");
    expect(hook.result.current.sendPolicy?.model).toBe("picked-model");
    await act(async () => expect(await hook.result.current.send()).toBe(true));
    await flush();
    expect(server.submits[0]).toMatchObject({ model: "picked-model" });
    await hook.unmount();
  });
});

describe("useComposer keeps a model, effort or speed pick made without typing", () => {
  const OTHER_SESSION_ID = "33333333-3333-4333-8333-333333333333";

  /** Two chats behind one client, each with its own draft. */
  function twoChats() {
    const servers = {
      [SESSION_ID]: chatServer({
        model: "paid-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
      }),
      [OTHER_SESSION_ID]: chatServer({
        model: "paid-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
      }),
    };
    const of = (sessionId: string) => servers[sessionId as keyof typeof servers];
    // While held, Sends wait before reaching the server.
    let submitGate: Promise<void> | null = null;
    // While held, draft saves wait before reaching the server.
    let saveGate: Promise<void> | null = null;
    const gate = (): { gate: Promise<void>; release: () => void } => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { gate: held, release };
    };
    const client = fakeClient({
      getComposerDraft: (workspaceId, sessionId, options) =>
        of(sessionId).client.getComposerDraft(workspaceId, sessionId, options),
      saveComposerDraft: async (workspaceId, sessionId, request) => {
        await saveGate;
        return of(sessionId).client.saveComposerDraft(workspaceId, sessionId, request);
      },
      submitComposerDraft: async (workspaceId, sessionId, request) => {
        await submitGate;
        return of(sessionId).client.submitComposerDraft(workspaceId, sessionId, request);
      },
    });
    return {
      client,
      first: servers[SESSION_ID],
      other: servers[OTHER_SESSION_ID],
      holdSends: () => {
        const held = gate();
        submitGate = held.gate;
        return () => {
          submitGate = null;
          held.release();
        };
      },
      holdSaves: () => {
        const held = gate();
        saveGate = held.gate;
        return () => {
          saveGate = null;
          held.release();
        };
      },
    };
  }

  test("a pick and a Send in the same tick send the pick", async () => {
    const chats = twoChats();
    const hook = await renderHook(
      (sessionId: string) =>
        useComposer(sessionId, { client: chats.client, workspaceId: WORKSPACE_ID }),
      SESSION_ID as string,
    );
    await flush();
    await act(() => hook.result.current.setValue("right now"));
    await flush(600);
    await act(async () => {
      const composer = hook.result.current;
      composer.setReasoningEffort("high");
      expect(await composer.send()).toBe(true);
    });
    await flush(600);
    expect(chats.first.submits).toHaveLength(1);
    expect(chats.first.submits[0]).toMatchObject({ text: "right now", reasoningEffort: "high" });
    await hook.unmount();
  });

  test("a pick made while a Send is on its way is saved once it lands", async () => {
    const chats = twoChats();
    const hook = await renderHook(
      (sessionId: string) =>
        useComposer(sessionId, { client: chats.client, workspaceId: WORKSPACE_ID }),
      SESSION_ID as string,
    );
    await flush();
    await act(() => hook.result.current.setValue("first message"));
    await flush(600);
    const release = chats.holdSends();
    await act(async () => {
      void hook.result.current.send();
    });
    await flush(50);
    await act(() => hook.result.current.setReasoningEffort("high"));
    await flush(50);
    release();
    await flush(600);
    expect(chats.first.submits).toHaveLength(1);
    await hook.unmount();

    const reloaded = await renderHook(
      (sessionId: string) =>
        useComposer(sessionId, { client: chats.client, workspaceId: WORKSPACE_ID }),
      SESSION_ID as string,
    );
    await flush();
    expect(reloaded.result.current.policy?.reasoningEffort).toBe("high");
    await reloaded.unmount();
  });

  test("an effort pick alone is saved and survives a reload", async () => {
    const chats = twoChats();
    const hook = await renderHook(
      (sessionId: string) =>
        useComposer(sessionId, { client: chats.client, workspaceId: WORKSPACE_ID }),
      SESSION_ID as string,
    );
    await flush();
    expect(hook.result.current.policy?.reasoningEffort).toBe("medium");

    await act(() => hook.result.current.setReasoningEffort("high"));
    await flush(600);
    expect(chats.first.saves.at(-1)).toMatchObject({ text: "", reasoningEffort: "high" });
    // A pick alone is not an unsent message.
    expect(hook.result.current.hasDraftContent()).toBe(false);
    await hook.unmount();

    // A reload: a fresh composer reads the saved pick back.
    const reloaded = await renderHook(
      (sessionId: string) =>
        useComposer(sessionId, { client: chats.client, workspaceId: WORKSPACE_ID }),
      SESSION_ID as string,
    );
    await flush();
    expect(reloaded.result.current.policy?.reasoningEffort).toBe("high");
    expect(reloaded.result.current.sendPolicy?.reasoningEffort).toBe("high");
    await reloaded.unmount();
  });

  test("an effort or model pick survives switching to another chat and back", async () => {
    const chats = twoChats();
    const hook = await renderHook(
      (sessionId: string) =>
        useComposer(sessionId, { client: chats.client, workspaceId: WORKSPACE_ID }),
      SESSION_ID as string,
    );
    await flush();
    await act(() => hook.result.current.setReasoningEffort("xhigh"));
    await act(() => hook.result.current.setModel("picked-model"));
    // Well inside the typing pause: a pick is saved without waiting for it.
    await flush(50);
    expect(chats.first.saves.at(-1)).toMatchObject({
      model: "picked-model",
      reasoningEffort: "xhigh",
    });

    await hook.rerender(OTHER_SESSION_ID);
    await flush();
    // The other chat keeps its own settings.
    expect(hook.result.current.policy).toMatchObject({
      model: "paid-model",
      reasoningEffort: "medium",
    });
    expect(chats.other.saves).toHaveLength(0);

    await hook.rerender(SESSION_ID);
    await flush();
    expect(hook.result.current.policy).toMatchObject({
      model: "picked-model",
      reasoningEffort: "xhigh",
    });

    // The pick is what the next message uses.
    await act(() => hook.result.current.setValue("with my pick"));
    await flush(600);
    await act(async () => expect(await hook.result.current.send()).toBe(true));
    await flush();
    expect(chats.first.submits[0]).toMatchObject({
      model: "picked-model",
      reasoningEffort: "xhigh",
    });
    // As before, the sent pick becomes the chat's setting and the draft is empty.
    expect(chats.first.chat()).toMatchObject({ model: "picked-model", reasoningEffort: "xhigh" });
    expect(hook.result.current.sendPolicy).toBeNull();
    expect(hook.result.current.hasDraftContent()).toBe(false);
    await hook.unmount();
  });

  test("text typed just before opening another chat is saved, not dropped", async () => {
    const chats = twoChats();
    const hook = await renderHook(
      (sessionId: string) =>
        useComposer(sessionId, { client: chats.client, workspaceId: WORKSPACE_ID }),
      SESSION_ID as string,
    );
    await flush();
    await act(() => hook.result.current.setValue("half a thought"));
    // Inside the typing pause: autosave has not run yet.
    expect(chats.first.saves).toHaveLength(0);

    await hook.rerender(OTHER_SESSION_ID);
    await flush();
    expect(chats.first.saves.at(-1)).toMatchObject({ text: "half a thought" });
    expect(hook.result.current.value).toBe("");
    expect(chats.other.saves).toHaveLength(0);

    await hook.rerender(SESSION_ID);
    await flush();
    expect(hook.result.current.value).toBe("half a thought");
    await hook.unmount();
  });

  test("an edit still waiting for autosave is saved when the composer closes", async () => {
    const chats = twoChats();
    const hook = await renderHook(
      (sessionId: string) =>
        useComposer(sessionId, { client: chats.client, workspaceId: WORKSPACE_ID }),
      SESSION_ID as string,
    );
    await flush();
    await act(() => hook.result.current.setValue("before I go"));
    await hook.unmount();
    await flush();
    expect(chats.first.saves.at(-1)).toMatchObject({ text: "before I go" });

    const reopened = await renderHook(
      (sessionId: string) =>
        useComposer(sessionId, { client: chats.client, workspaceId: WORKSPACE_ID }),
      SESSION_ID as string,
    );
    await flush();
    expect(reopened.result.current.value).toBe("before I go");
    await reopened.unmount();
  });

  test("leaving right after a Send does not bring the sent text back", async () => {
    const chats = twoChats();
    const hook = await renderHook(
      (sessionId: string) =>
        useComposer(sessionId, { client: chats.client, workspaceId: WORKSPACE_ID }),
      SESSION_ID as string,
    );
    await flush();
    await act(() => hook.result.current.setReasoningEffort("high"));
    await act(() => hook.result.current.setValue("send this"));
    await act(async () => expect(await hook.result.current.send()).toBe(true));
    await hook.rerender(OTHER_SESSION_ID);
    await flush(600);
    expect(chats.first.submits).toHaveLength(1);
    const after = await chats.first.client.getComposerDraft(WORKSPACE_ID, SESSION_ID);
    expect(after).toMatchObject({ text: "", policyFollowsSession: true });
    await hook.unmount();
  });

  test("a pick waiting behind a slow save is still saved when leaving the chat", async () => {
    const chats = twoChats();
    const hook = await renderHook(
      (sessionId: string) =>
        useComposer(sessionId, { client: chats.client, workspaceId: WORKSPACE_ID }),
      SESSION_ID as string,
    );
    await flush();
    const release = chats.holdSaves();
    await act(() => hook.result.current.setValue("some text"));
    // The text's save is on its way and held.
    await flush(600);
    await act(() => hook.result.current.setReasoningEffort("high"));
    // The pick's save now waits for the held one.
    await flush(50);
    await hook.rerender(OTHER_SESSION_ID);
    release();
    await flush(600);
    const kept = await chats.first.client.getComposerDraft(WORKSPACE_ID, SESSION_ID);
    expect(kept).toMatchObject({
      text: "some text",
      reasoningEffort: "high",
      policyFollowsSession: false,
    });
    await hook.unmount();
  });

  test("a save on leaving never overwrites a draft that moved on meanwhile", async () => {
    const chats = twoChats();
    const hook = await renderHook(
      (sessionId: string) =>
        useComposer(sessionId, { client: chats.client, workspaceId: WORKSPACE_ID }),
      SESSION_ID as string,
    );
    await flush();
    await act(() => hook.result.current.setValue("from this tab"));
    // Another tab saves the same chat's draft first.
    const current = await chats.first.client.getComposerDraft(WORKSPACE_ID, SESSION_ID);
    await chats.first.client.saveComposerDraft(WORKSPACE_ID, SESSION_ID, {
      expectedRevision: current.revision,
      text: "from another tab",
      resources: [],
      annotations: [],
    });

    await hook.rerender(OTHER_SESSION_ID);
    await flush();
    const kept = await chats.first.client.getComposerDraft(WORKSPACE_ID, SESSION_ID);
    expect(kept.text).toBe("from another tab");
    await hook.unmount();
  });
});
