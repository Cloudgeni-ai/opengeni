/* ----------------------------------------------------------------------------
   A Send while the agent is working (`busySend: "steer"`) shows the message
   in the timeline at once. The box empties in that same render, not after
   the server answers, and the send makes one request: it carries its own
   content, so nothing is saved first. A send refused for good puts the
   message back in the box, unless something new was typed meanwhile; then
   the typing stays and the message waits in the timeline to retry or
   restore. An unconfirmed send keeps its key for the retry.
   -------------------------------------------------------------------------- */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  OpenGeniApiError,
  type SessionEvent,
  type SteerMessageResult,
  type SubmitComposerDraftRequest,
} from "@opengeni/sdk";

import { useComposer } from "../src/hooks/use-composer";
import { fakeClient, fakeTurn, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderHook } from "./render-hook";

registerDom({ clock: "real" });

let sessionId = crypto.randomUUID();
beforeEach(() => {
  sessionId = crypto.randomUUID();
});

const MESSAGE = "Use the other table";

function refused(): OpenGeniApiError {
  return new OpenGeniApiError(
    422,
    JSON.stringify({ code: "invalid_request", message: "Not accepted" }),
    { mutation: true },
  );
}

function lostReply(): OpenGeniApiError {
  return new OpenGeniApiError(0, "", {
    code: "network_error",
    retryable: true,
    outcomeUnknown: true,
    mutation: true,
  });
}

function steered(text: string, clientEventId: string | undefined): SteerMessageResult {
  const turn = fakeTurn();
  return {
    accepted: {
      id: crypto.randomUUID(),
      workspaceId: WORKSPACE_ID,
      sessionId,
      sequence: 10,
      type: "user.message",
      payload: { text },
      clientEventId: clientEventId ?? null,
      turnId: turn.id,
      occurredAt: new Date().toISOString(),
    } as SessionEvent,
    turn,
    receipt: {
      id: crypto.randomUUID(),
      action: "prompt.steer",
      operationKey: clientEventId ?? crypto.randomUUID(),
      targetSessionId: sessionId,
      targetTurnId: turn.id,
      appliedControlRevision: null,
      appliedQueueVersion: null,
      appliedTurnVersion: null,
      appliedDraftRevision: null,
      createdAt: new Date().toISOString(),
    },
    routing: "accepted_for_steering",
    interruptionCount: 0,
    replay: false,
  };
}

type Outcome = "accept" | "refuse" | "lose reply";

/**
 * A server whose answer to each send is held until the test releases it, so
 * every render before the answer can be inspected.
 */
function heldServer() {
  const requests: string[] = [];
  const sends: { text: string; clientEventId: string | undefined }[] = [];
  let release: ((outcome: Outcome) => void) | null = null;
  const waiting = (): ((outcome: Outcome) => void) | null => release;
  const answer = async (): Promise<void> => {
    const outcome = await new Promise<Outcome>((resolve) => {
      release = resolve;
    });
    release = null;
    if (outcome === "refuse") throw refused();
    if (outcome === "lose reply") throw lostReply();
  };
  const client = fakeClient({
    saveComposerDraft: async (workspaceId, target, request) => {
      requests.push(`save ${request.text}`);
      return await fakeClient({}).saveComposerDraft(workspaceId, target, request);
    },
    submitComposerDraft: async (_workspaceId, _target, request: SubmitComposerDraftRequest) => {
      requests.push(`submit ${request.delivery} ${request.text}`);
      sends.push({ text: request.text, clientEventId: request.clientEventId });
      await answer();
      return {
        ...steered(request.text, request.clientEventId),
        draft: {
          revision: request.expectedDraftRevision + 1,
          text: "",
          annotations: [],
          resources: [],
          policyFollowsSession: true,
          sourceTurnId: null,
          sourceTurnVersion: null,
          updatedAt: new Date().toISOString(),
        },
      } as unknown as Awaited<ReturnType<ReturnType<typeof fakeClient>["submitComposerDraft"]>>;
    },
    steerMessage: async (_workspaceId, _target, input, options) => {
      const request = typeof input === "string" ? { text: input } : input;
      requests.push(`steer ${options?.delivery ?? "steer"} ${request.text}`);
      sends.push({ text: request.text, clientEventId: request.clientEventId });
      await answer();
      return steered(request.text, request.clientEventId);
    },
  });
  return {
    client,
    requests,
    sends,
    answer: async (outcome: Outcome): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (!waiting() && Date.now() < deadline) await flush(5);
      const settle = waiting();
      if (!settle) throw new Error("no send is waiting for an answer");
      await actRun(() => settle(outcome));
      await flush(50);
    },
  };
}

type Frame = { value: string; shown: boolean };

async function mount(server: ReturnType<typeof heldServer>, durable: boolean) {
  const frames: Frame[] = [];
  const hook = await renderHook(() => {
    const composer = useComposer(sessionId, {
      client: server.client,
      workspaceId: WORKSPACE_ID,
      busySend: "steer",
      // The agent is working: Send takes the busy path.
      sendDestination: () => "queue",
      ...(durable
        ? {}
        : {
            draftPersistence: "disabled" as const,
            initialPolicy: {
              model: "model-x",
              reasoningEffort: "medium" as const,
              latencyMode: "standard" as const,
            },
          }),
    });
    frames.push({
      value: composer.value,
      shown: (composer.optimisticMessages ?? []).some((message) => message.text === MESSAGE),
    });
    return composer;
  }, undefined);
  await flush(20);
  return { hook, frames };
}

/** Press Send without waiting for the server's answer. */
async function pressSend(hook: Awaited<ReturnType<typeof mount>>["hook"]): Promise<void> {
  await actRun(() => {
    void hook.result.current.send();
  });
}

for (const durable of [true, false]) {
  describe(`busy Send under steer (${durable ? "durable drafts" : "no durable drafts"})`, () => {
    test("the box empties in the render that shows the message, before the server answers", async () => {
      const server = heldServer();
      const { hook, frames } = await mount(server, durable);
      try {
        await actRun(() => hook.result.current.setValue(MESSAGE));
        const before = frames.length;
        await pressSend(hook);
        // Shown and emptied while the send still waits for its answer.
        const sent = frames.slice(before);
        expect(sent.some((frame) => frame.shown)).toBe(true);
        expect(hook.result.current.value).toBe("");
        // Never a render with the message both shown and still in the box.
        expect(sent.filter((frame) => frame.shown && frame.value !== "")).toEqual([]);
        // One request, carrying the message; nothing saved first.
        expect(server.requests).toEqual([
          durable ? `submit steer_or_send ${MESSAGE}` : `steer steer_or_send ${MESSAGE}`,
        ]);
        await server.answer("accept");
        expect(hook.result.current.value).toBe("");
        expect(hook.result.current.error).toBeNull();
      } finally {
        await hook.unmount();
      }
    });

    test("a send refused for good puts the message back in the untouched box", async () => {
      const server = heldServer();
      const { hook } = await mount(server, durable);
      try {
        await actRun(() => hook.result.current.setValue(MESSAGE));
        await pressSend(hook);
        expect(hook.result.current.value).toBe("");
        await server.answer("refuse");
        expect(hook.result.current.value).toBe(MESSAGE);
        expect(hook.result.current.error).not.toBeNull();
        // Back in the box, so not also waiting in the timeline.
        expect(
          (hook.result.current.optimisticMessages ?? []).filter(
            (message) => message.text === MESSAGE,
          ),
        ).toEqual([]);
      } finally {
        await hook.unmount();
      }
    });

    test("a send refused after new typing keeps the typing and the message to retry", async () => {
      const server = heldServer();
      const { hook } = await mount(server, durable);
      try {
        await actRun(() => hook.result.current.setValue(MESSAGE));
        await pressSend(hook);
        await actRun(() => hook.result.current.setValue("and one more thing"));
        await server.answer("refuse");
        expect(hook.result.current.value).toBe("and one more thing");
        expect(hook.result.current.optimisticMessages).toMatchObject([
          { text: MESSAGE, state: "failed", outcomeUnknown: false },
        ]);
        const failed = hook.result.current.optimisticMessages![0]!;
        // Restore (offered once the box is empty) takes it back into the box.
        expect(hook.result.current.restoreOptimisticMessage).toBeUndefined();
        await actRun(() => hook.result.current.setValue(""));
        await actRun(() => hook.result.current.restoreOptimisticMessage!(failed.clientEventId));
        expect(hook.result.current.value).toBe(MESSAGE);
      } finally {
        await hook.unmount();
      }
    });

    test("an unconfirmed send keeps its key for the retry", async () => {
      const server = heldServer();
      const { hook } = await mount(server, durable);
      try {
        await actRun(() => hook.result.current.setValue(MESSAGE));
        await pressSend(hook);
        await server.answer("lose reply");
        expect(hook.result.current.value).toBe("");
        const unconfirmed = (hook.result.current.optimisticMessages ?? []).find(
          (message) => message.text === MESSAGE,
        );
        expect(unconfirmed).toMatchObject({ state: "failed", outcomeUnknown: true });
        await actRun(() => hook.result.current.retryOptimisticMessage!(unconfirmed!.clientEventId));
        await server.answer("accept");
        expect(server.sends.map((send) => send.text)).toEqual([MESSAGE, MESSAGE]);
        expect(server.sends[1]!.clientEventId).toBe(server.sends[0]!.clientEventId);
        expect(server.sends[0]!.clientEventId).toBe(unconfirmed!.clientEventId);
      } finally {
        await hook.unmount();
      }
    });
  });
}
