import { describe, expect, test } from "bun:test";

import { useComposer } from "../src/hooks/use-composer";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderHook } from "./render-hook";

registerDom();

describe("useComposer embedding policy", () => {
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
