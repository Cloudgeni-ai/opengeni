import { describe, expect, test } from "bun:test";

import { useComposer } from "../src/hooks/use-composer";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderHook } from "./render-hook";

registerDom();

describe("useComposer embedding policy", () => {
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
