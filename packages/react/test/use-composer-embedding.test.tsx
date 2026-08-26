import { describe, expect, test } from "bun:test";
import type { SendMessageInput, SessionEvent } from "@opengeni/sdk";

import { useComposer } from "../src/hooks/use-composer";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderHook } from "./render-hook";

registerDom();

describe("useComposer embedding policy", () => {
  test("ordinary Send clears the draft immediately and preserves rapid messages through handoff", async () => {
    const sessionId = crypto.randomUUID();
    const attempts: SendMessageInput[] = [];
    const acceptedEvents: SessionEvent[] = [];
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const client = fakeClient({
      sendMessage: async (_workspaceId, _sessionId, input) => {
        const submitted = typeof input === "string" ? { text: input } : input;
        attempts.push(submitted);
        if (attempts.length === 1) await firstPending;
        const accepted: SessionEvent = {
          id: crypto.randomUUID(),
          workspaceId: WORKSPACE_ID,
          sessionId,
          sequence: attempts.length,
          type: "user.message",
          clientEventId: submitted.clientEventId,
          payload: submitted,
          occurredAt: new Date().toISOString(),
        };
        acceptedEvents.push(accepted);
        return accepted;
      },
    });
    const hook = await renderHook(
      (events: SessionEvent[]) =>
        useComposer(sessionId, {
          client,
          workspaceId: WORKSPACE_ID,
          draftPersistence: "disabled",
          initialPolicy: {
            model: "scripted-model",
            reasoningEffort: "medium",
            latencyMode: "standard",
          },
          events,
        }),
      [] as SessionEvent[],
    );

    await actRun(() => hook.result.current.setValue("first"));
    expect(await actRun(() => hook.result.current.send())).toBe(true);
    expect(hook.result.current.value).toBe("");
    expect(hook.result.current.optimisticMessages).toMatchObject([
      { text: "first", state: "sending" },
    ]);

    await actRun(() => hook.result.current.setValue("second"));
    expect(await actRun(() => hook.result.current.send())).toBe(true);
    expect(hook.result.current.value).toBe("");
    const optimistic = hook.result.current.optimisticMessages ?? [];
    expect(optimistic.map((message) => message.text)).toEqual(["first", "second"]);
    expect(new Set(optimistic.map((message) => message.clientEventId)).size).toBe(2);
    expect(attempts.map((attempt) => attempt.text)).toEqual(["first"]);

    releaseFirst();
    await flush();
    expect(attempts.map((attempt) => attempt.text)).toEqual(["first", "second"]);

    expect(acceptedEvents).toHaveLength(2);
    const accepted = acceptedEvents;
    await hook.rerender([accepted[0]!]);
    expect(hook.result.current.optimisticMessages?.map((message) => message.text)).toEqual([
      "first",
      "second",
    ]);
    const started = accepted.map((event, index) => ({
      id: crypto.randomUUID(),
      workspaceId: WORKSPACE_ID,
      sessionId,
      sequence: accepted.length + index + 1,
      type: "turn.started" as const,
      turnId: crypto.randomUUID(),
      clientEventId: null,
      payload: { triggerEventId: event.id },
      occurredAt: new Date().toISOString(),
    }));
    await hook.rerender([accepted[0]!, started[0]!]);
    expect(hook.result.current.optimisticMessages?.map((message) => message.text)).toEqual([
      "second",
    ]);
    await hook.rerender([...accepted, started[0]!]);
    expect(hook.result.current.optimisticMessages?.map((message) => message.text)).toEqual([
      "second",
    ]);
    await hook.rerender([...accepted, ...started]);
    expect(hook.result.current.optimisticMessages).toEqual([]);
    await hook.unmount();
  });

  test("ordinary Send clears its local draft before the host submission callback", async () => {
    const draftVisibilityOnSubmitted: boolean[] = [];
    let readDraftContent = () => true;
    const client = fakeClient({
      sendMessage: async (_workspaceId, _sessionId, input) => ({
        id: crypto.randomUUID(),
        workspaceId: WORKSPACE_ID,
        sessionId: SESSION_ID,
        sequence: 1,
        type: "user.message",
        clientEventId: typeof input === "string" ? undefined : input.clientEventId,
        payload: input,
        occurredAt: new Date().toISOString(),
      }),
    });
    const hook = await renderHook(
      () =>
        useComposer(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          draftPersistence: "disabled",
          initialPolicy: {
            model: "scripted-model",
            reasoningEffort: "medium",
            latencyMode: "standard",
          },
          onSubmitted: () => {
            draftVisibilityOnSubmitted.push(readDraftContent());
          },
        }),
      undefined,
    );
    readDraftContent = () => hook.result.current.hasDraftContent();

    await actRun(() => hook.result.current.setValue("submitted once"));
    expect(await actRun(() => hook.result.current.send())).toBe(true);

    expect(draftVisibilityOnSubmitted).toEqual([false]);
    expect(hook.result.current.value).toBe("");
    await hook.unmount();
  });

  test("annotation-only send preserves structured source data and clears on acceptance", async () => {
    const sent: unknown[] = [];
    const client = fakeClient({
      sendMessage: async (_workspaceId, _sessionId, input) => {
        sent.push(input);
        return {
          id: crypto.randomUUID(),
          workspaceId: WORKSPACE_ID,
          sessionId: SESSION_ID,
          sequence: 1,
          type: "user.message",
          payload: input,
          occurredAt: new Date().toISOString(),
        };
      },
    });
    const hook = await renderHook(
      () =>
        useComposer(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          draftPersistence: "disabled",
          initialPolicy: {
            model: "scripted-model",
            reasoningEffort: "medium",
            latencyMode: "standard",
          },
        }),
      undefined,
    );
    await actRun(() =>
      hook.result.current.addAnnotation?.({
        id: "00000000-0000-4000-8000-000000000601",
        source: {
          kind: "user_message",
          eventId: "00000000-0000-4000-8000-000000000602",
          eventType: "user.message",
          sequence: 2,
          turnId: null,
          startOffset: 0,
          endOffset: 5,
          contextBefore: "",
          contextAfter: " world",
        },
        quote: "hello",
        note: "Use this exact source.",
      }),
    );
    expect(hook.result.current.canSend).toBe(true);
    expect(await actRun(() => hook.result.current.send())).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      text: "",
      annotations: [
        {
          quote: "hello",
          note: "Use this exact source.",
          source: { eventId: "00000000-0000-4000-8000-000000000602" },
        },
      ],
    });
    expect(hook.result.current.annotations).toEqual([]);
    await hook.unmount();
  });

  test("incomplete annotation notes keep Send disabled", async () => {
    const hook = await renderHook(
      () =>
        useComposer(SESSION_ID, {
          client: fakeClient({}),
          workspaceId: WORKSPACE_ID,
          draftPersistence: "disabled",
          initialPolicy: {
            model: "scripted-model",
            reasoningEffort: "medium",
            latencyMode: "standard",
          },
        }),
      undefined,
    );
    await actRun(() =>
      hook.result.current.addAnnotation?.({
        id: "00000000-0000-4000-8000-000000000611",
        source: {
          kind: "user_message",
          eventId: "00000000-0000-4000-8000-000000000612",
          eventType: "user.message",
          sequence: 2,
          turnId: null,
          startOffset: 0,
          endOffset: 5,
          contextBefore: "",
          contextAfter: "",
        },
        quote: "hello",
        note: "",
      }),
    );
    expect(hook.result.current.canSend).toBe(false);
    expect(await actRun(() => hook.result.current.send())).toBe(false);
    await hook.unmount();
  });

  test("disabled draft persistence never reads or writes the remote draft", async () => {
    const calls: string[] = [];
    const sent: unknown[] = [];
    const client = fakeClient({
      getComposerDraft: async () => {
        calls.push("get-draft");
        throw new Error("draft route must be unreachable");
      },
      saveComposerDraft: async () => {
        calls.push("save-draft");
        throw new Error("draft route must be unreachable");
      },
      sendMessage: async (_workspaceId, _sessionId, input) => {
        sent.push(input);
        return {
          id: crypto.randomUUID(),
          workspaceId: WORKSPACE_ID,
          sessionId: SESSION_ID,
          sequence: 1,
          type: "user.message",
          payload: {},
          occurredAt: new Date().toISOString(),
        };
      },
    });
    const hook = await renderHook(
      () =>
        useComposer(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          draftPersistence: "disabled",
          initialPolicy: {
            model: "scripted-model",
            reasoningEffort: "medium",
            latencyMode: "standard",
          },
          sendExtras: {
            resources: [
              {
                kind: "file",
                fileId: "33333333-3333-4333-8333-333333333333",
              },
            ],
          },
        }),
      undefined,
    );
    await flush();
    expect(hook.result.current.draftLoading).toBe(false);
    expect(hook.result.current.draft).toBeNull();
    expect(hook.result.current.draftPersistence).toBe("disabled");
    await actRun(() => hook.result.current.setValue("host-controlled message"));
    await flush(600);
    expect(await actRun(() => hook.result.current.send())).toBe(true);

    expect(calls).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      text: "host-controlled message",
      resources: [
        {
          kind: "file",
          fileId: "33333333-3333-4333-8333-333333333333",
        },
      ],
    });
    expect(sent[0]).not.toHaveProperty("expectedDraftRevision");
    await hook.unmount();
  });
});
