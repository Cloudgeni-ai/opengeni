import { expect, test } from "bun:test";
import type { ComposerDraft, SessionEvent, SubmitComposerDraftResponse } from "@opengeni/sdk";
import { isComposerDraftEvent, useComposer } from "../src/hooks/use-composer";
import { fakeClient, fakeTurn, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderHook } from "./render-hook";

registerDom();

type Policy = Pick<ComposerDraft, "model" | "reasoningEffort" | "latencyMode">;

function modelSwitched(sequence: number, policy: Policy): SessionEvent {
  return {
    id: crypto.randomUUID(),
    sessionId: SESSION_ID,
    sequence,
    type: "session.model_settings.updated",
    payload: { ...policy, effectiveFrom: "future_turns" },
    createdAt: new Date().toISOString(),
  } as unknown as SessionEvent;
}

test("a model switch event reloads the composer draft", () => {
  expect(isComposerDraftEvent({ type: "session.model_settings.updated" })).toBe(true);
});

test("a composer that follows the chat shows an in-chat switch and sends only a picked model", async () => {
  // A tiny server: the stored draft, and the chat policy a draft that follows
  // the chat shows (as the API does).
  let chat: Policy = { model: "paid-model", reasoningEffort: "medium", latencyMode: "standard" };
  let stored: ComposerDraft = {
    revision: 0,
    text: "",
    annotations: [],
    resources: [],
    ...chat,
    modelProvided: false,
    sourceTurnId: null,
    sourceTurnVersion: null,
    updatedAt: null,
  };
  const shown = (): ComposerDraft =>
    stored.modelProvided === false ? { ...stored, ...chat } : { ...stored };
  const submits: Record<string, unknown>[] = [];
  const client = fakeClient({
    getComposerDraft: async () => shown(),
    saveComposerDraft: async (_workspaceId, _sessionId, request) => {
      const { expectedRevision, ...content } = request;
      stored = {
        ...stored,
        ...content,
        annotations: content.annotations ?? [],
        modelProvided: content.modelProvided ?? true,
        revision: expectedRevision + 1,
        updatedAt: new Date().toISOString(),
      };
      return shown();
    },
    submitComposerDraft: async (_workspaceId, _sessionId, request) => {
      submits.push({ ...request });
      if (request.modelProvided !== false) {
        chat = {
          model: request.model,
          reasoningEffort: request.reasoningEffort,
          latencyMode: request.latencyMode,
        };
      }
      stored = {
        ...stored,
        revision: request.expectedDraftRevision + 1,
        text: "",
        annotations: [],
        resources: [],
        modelProvided: false,
      };
      const sequence = submits.length * 10;
      return {
        accepted: {
          id: crypto.randomUUID(),
          sessionId: SESSION_ID,
          sequence,
          type: "user.message",
          payload: { text: request.text, clientEventId: request.clientEventId },
          createdAt: new Date().toISOString(),
        },
        turn: fakeTurn({ prompt: request.text }),
        draft: shown(),
        receipt: null,
        routing: "accepted_for_execution",
        interruptionCount: 0,
        replay: false,
      } as unknown as SubmitComposerDraftResponse;
    },
  });
  const hook = await renderHook(
    (events: SessionEvent[]) =>
      useComposer(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events }),
    [] as SessionEvent[],
  );
  try {
    await flush();
    expect(hook.result.current.policy).toMatchObject({
      model: "paid-model",
      modelProvided: false,
    });

    // The person starts typing; then the agent switches the chat's model.
    await actRun(() => hook.result.current.setValue("is this cheaper now?"));
    chat = { model: "free-model", reasoningEffort: "low", latencyMode: "standard" };
    await hook.rerender([modelSwitched(5, chat)]);
    await flush();
    expect(hook.result.current.policy).toMatchObject({
      model: "free-model",
      reasoningEffort: "low",
      modelProvided: false,
    });
    expect(hook.result.current.value).toBe("is this cheaper now?");

    // The send follows the chat: it names no pick of its own.
    await actRun(() => hook.result.current.send());
    await flush();
    expect(submits.at(-1)).toMatchObject({
      text: "is this cheaper now?",
      model: "free-model",
      modelProvided: false,
    });
    expect(chat.model).toBe("free-model");

    // Choosing a model in the composer is a pick, and that is what is sent.
    await actRun(() => hook.result.current.setModel("paid-model"));
    expect(hook.result.current.policy).toMatchObject({
      model: "paid-model",
      modelProvided: true,
    });
    await actRun(() => hook.result.current.setValue("back to the better one"));
    await actRun(() => hook.result.current.send());
    await flush();
    expect(submits.at(-1)).toMatchObject({
      text: "back to the better one",
      model: "paid-model",
      modelProvided: true,
    });
    expect(chat.model).toBe("paid-model");
    expect(hook.result.current.policy).toMatchObject({ modelProvided: false });

    // Once sent, the pick is the chat's policy, so a later switch shows again.
    chat = { model: "free-model", reasoningEffort: "low", latencyMode: "standard" };
    await hook.rerender([modelSwitched(5, chat), modelSwitched(40, chat)]);
    await flush();
    expect(hook.result.current.policy).toMatchObject({
      model: "free-model",
      modelProvided: false,
    });
  } finally {
    await hook.unmount();
  }
});
