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
