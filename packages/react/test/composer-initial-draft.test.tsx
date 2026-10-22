import { expect, test } from "bun:test";
import type { SaveComposerDraftRequest } from "@opengeni/sdk";
import { useComposer } from "../src/hooks/use-composer";
import { fakeClient, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderHook } from "./render-hook";

registerDom();

test("an empty handoff never erases an existing server draft", async () => {
  const sessionId = crypto.randomUUID();
  const base = fakeClient({});
  const client = fakeClient({
    getComposerDraft: async (...args) => ({
      ...(await base.getComposerDraft(...args)),
      revision: 3,
      text: "Written in another view",
    }),
  });
  const hook = await renderHook(
    () =>
      useComposer(sessionId, {
        client,
        workspaceId: WORKSPACE_ID,
        initialDraft: { text: "", resources: [] },
      }),
    undefined,
  );
  try {
    await flush(30);
    expect(hook.result.current.value).toBe("Written in another view");
    expect(hook.result.current.draftRevision).toBe(3);
  } finally {
    await hook.unmount();
  }
});

test("a new-conversation handoff preserves local content while the server supplies draft revision", async () => {
  const base = fakeClient({});
  const saved: SaveComposerDraftRequest[] = [];
  const client = fakeClient({
    getComposerDraft: async (...args) => ({
      ...(await base.getComposerDraft(...args)),
      revision: 7,
    }),
    saveComposerDraft: async (...args) => {
      saved.push(args[2]);
      return base.saveComposerDraft(...args);
    },
  });
  const resource = { kind: "file" as const, fileId: crypto.randomUUID() };
  const hook = await renderHook(
    ({ text }) =>
      useComposer(cryptoSession, {
        client,
        workspaceId: WORKSPACE_ID,
        initialDraft: { text, resources: [resource] },
      }),
    { text: "Newer text typed while the first message was creating" },
  );
  try {
    await flush(30);
    expect(hook.result.current.value).toBe("Newer text typed while the first message was creating");
    expect(hook.result.current.restoredResources).toEqual([resource]);
    expect(hook.result.current.draftRevision).toBe(7);
    expect(hook.result.current.policy?.model).toBe("model-x");
    await flush(650);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      expectedRevision: 7,
      text: "Newer text typed while the first message was creating",
      resources: [resource],
    });
    await actRun(() => hook.result.current.setValue("An even newer local edit"));
    await hook.rerender({ text: "A stale handoff must not run twice" });
    expect(hook.result.current.value).toBe("An even newer local edit");
  } finally {
    await hook.unmount();
  }
});

const cryptoSession = crypto.randomUUID();
