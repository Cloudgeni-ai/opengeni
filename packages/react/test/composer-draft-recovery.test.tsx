import { expect, test } from "bun:test";
import {
  OpenGeniApiError,
  OpenGeniClient,
  OPENGENI_API_CONTRACT_HEADER,
  OPENGENI_API_CONTRACT_REVISION,
} from "@opengeni/sdk";
import { useComposer } from "../src/hooks/use-composer";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderHook } from "./render-hook";

registerDom();

for (const initialLoad of [true, false]) {
  test(`draft timeout recovers automatically during ${initialLoad ? "initial hydration" : "same-revision refresh"}`, async () => {
    const base = fakeClient({});
    const draft = {
      ...(await base.getComposerDraft(WORKSPACE_ID, SESSION_ID)),
      text: "Keep this draft",
      resources: [{ kind: "file" as const, fileId: "44444444-4444-4444-8444-444444444444" }],
    };
    let reads = 0;
    const client = fakeClient({
      getComposerDraft: async () => {
        reads += 1;
        if (reads === (initialLoad ? 1 : 2)) {
          throw new DOMException("Request timed out", "TimeoutError");
        }
        return draft;
      },
    });
    const hook = await renderHook(
      () => useComposer(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    try {
      if (!initialLoad) await actRun(() => hook.result.current.reloadDraft());
      expect(hook.result.current.error?.message).toBe("Draft sync timed out. Retrying…");
      await flush(1400);
      expect(reads).toBe(initialLoad ? 2 : 3);
      expect(hook.result.current.error).toBeNull();
      expect(hook.result.current.value).toBe(draft.text);
      expect(hook.result.current.restoredResources).toEqual(draft.resources);
      expect(hook.result.current.policy?.model).toBe(draft.model);
    } finally {
      await hook.unmount();
    }
  });
}

test("draft recovery preserves a concurrent control error", async () => {
  let failRead = true;
  const base = fakeClient({});
  const controlError = new Error("Pause was rejected");
  const client = fakeClient({
    getComposerDraft: async (...args) => {
      if (failRead) throw new DOMException("Request timed out", "TimeoutError");
      return base.getComposerDraft(...args);
    },
    pauseSession: async () => {
      throw controlError;
    },
  });
  const hook = await renderHook(
    () => useComposer(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
    undefined,
  );
  try {
    await actRun(() => hook.result.current.pause());
    expect(hook.result.current.error).toBe(controlError);
    // A further draft failure must not obscure the actionable control failure.
    await actRun(() => hook.result.current.reloadDraft());
    expect(hook.result.current.error).toBe(controlError);
    failRead = false;
    await actRun(() => hook.result.current.reloadDraft());
    expect(hook.result.current.draft).not.toBeNull();
    expect(hook.result.current.error).toBe(controlError);
    await actRun(() => hook.result.current.clearError());
    expect(hook.result.current.error).toBeNull();
  } finally {
    await hook.unmount();
  }
});

test("successful draft refresh clears a previous non-retryable read error", async () => {
  let reads = 0;
  const base = fakeClient({});
  const denied = new OpenGeniApiError(403, "Draft access denied");
  const client = fakeClient({
    getComposerDraft: async (...args) => {
      reads += 1;
      if (reads === 1) throw denied;
      return base.getComposerDraft(...args);
    },
  });
  const hook = await renderHook(
    () => useComposer(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
    undefined,
  );
  try {
    expect(hook.result.current.error).toBe(denied);
    await flush(1400);
    expect(reads).toBe(1);
    await actRun(() => hook.result.current.reloadDraft());
    expect(hook.result.current.error).toBeNull();
  } finally {
    await hook.unmount();
  }
});

test("the SDK deadline retries a read without aborting the composer's caller signal", async () => {
  const draft = await fakeClient({}).getComposerDraft(WORKSPACE_ID, SESSION_ID);
  let requests = 0;
  let callerSignal: AbortSignal | undefined;
  const sdk = new OpenGeniClient({
    baseUrl: "https://opengeni.invalid",
    sessionCommandTimeoutMs: 20,
    fetch: async (_input, init) => {
      requests += 1;
      if (requests === 1) {
        return await new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), {
            once: true,
          });
        });
      }
      return new Response(JSON.stringify(draft), {
        headers: {
          "content-type": "application/json",
          [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
        },
      });
    },
  });
  const client = fakeClient({
    getComposerDraft: async (workspaceId, sessionId, options) => {
      callerSignal = options?.signal;
      return await sdk.getComposerDraft(workspaceId, sessionId, options);
    },
  });
  const hook = await renderHook(
    () => useComposer(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
    undefined,
  );
  try {
    await flush(60);
    expect(hook.result.current.error?.message).toBe("Draft sync timed out. Retrying…");
    expect(callerSignal?.aborted).toBe(false);
    await flush(1400);
    expect(requests).toBe(2);
    expect(hook.result.current.error).toBeNull();
  } finally {
    await hook.unmount();
  }
});

test("switching sessions cancels the old draft timeout retry and warning", async () => {
  const otherSessionId = "33333333-3333-4333-8333-333333333333";
  const reads: string[] = [];
  const base = fakeClient({});
  const client = fakeClient({
    getComposerDraft: async (workspaceId, sessionId) => {
      reads.push(sessionId);
      if (sessionId === SESSION_ID) throw new DOMException("Request timed out", "TimeoutError");
      return await base.getComposerDraft(workspaceId, sessionId);
    },
  });
  const hook = await renderHook(
    (sessionId: string) => useComposer(sessionId, { client, workspaceId: WORKSPACE_ID }),
    SESSION_ID as string,
  );
  try {
    expect(hook.result.current.error).not.toBeNull();
    await hook.rerender(otherSessionId);
    await flush(1400);
    expect(reads).toEqual([SESSION_ID, otherSessionId]);
    expect(hook.result.current.error).toBeNull();
  } finally {
    await hook.unmount();
  }
});
