import { expect, spyOn, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk";
import { StrictMode } from "react";
import {
  useNewConversation,
  type CreatedConversation,
  type NewConversationCreateOptions,
  type NewConversationController,
} from "../src/hooks/use-new-conversation";
import { fakeClient, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderComponent, renderHook } from "./render-hook";

registerDom();
function client() {
  const base = fakeClient({});
  return fakeClient({
    getClientConfig: async () =>
      ({ ...(await base.getClientConfig()), realtimeVoice: true }) as never,
    getWorkspaceModelCatalog: async () => ({ models: [] }) as never,
  });
}

test("accepted creation waits for newer uploads, then transfers files and policy without resending", async () => {
  let finishCreate!: (id: string) => void;
  let finishUpload!: (asset: never) => void;
  let calls = 0;
  const created: CreatedConversation[] = [];
  const api = client();
  const readConfig = api.getClientConfig;
  api.getClientConfig = async () =>
    ({ ...(await readConfig()), fileUploads: { enabled: true, maxSizeBytes: 1000 } }) as never;
  api.uploadFile = () =>
    new Promise((resolve) => {
      finishUpload = resolve;
    });
  const hook = await renderHook(
    () =>
      useNewConversation({
        client: api,
        workspaceId: WORKSPACE_ID,
        modelPicker: true,
        createSession: () => {
          calls++;
          return new Promise((resolve) => {
            finishCreate = resolve;
          });
        },
        onCreated: (result) => {
          created.push(result);
        },
      }),
    undefined,
  );
  try {
    await flush(30);
    await actRun(() => hook.result.current.composer.setValue("First message"));
    let submission!: Promise<boolean>;
    await actRun(() => {
      submission = hook.result.current.composer.send();
    });
    await actRun(() => {
      hook.result.current.composer.setValue("Next thought");
      hook.result.current.composer.setModel!("next-model");
      hook.result.current.composer.setReasoningEffort!("high");
      hook.result.current.files.addFiles([new File(["next"], "next.txt")]);
    });
    await actRun(() => finishCreate("created-id"));
    expect(await submission).toBe(true);
    expect(created).toEqual([]);
    expect(hook.result.current.finishingUploads).toBe(true);
    expect(hook.result.current.composer.canSend).toBe(false);
    expect(await actRun(() => hook.result.current.retry())).toBe(false);
    const fileId = crypto.randomUUID();
    await actRun(() =>
      finishUpload({
        id: fileId,
        workspaceId: WORKSPACE_ID,
        status: "ready",
        filename: "next.txt",
        contentType: "text/plain",
        sizeBytes: 4,
      } as never),
    );
    expect(created).toMatchObject([
      {
        sessionId: "created-id",
        draft: {
          text: "Next thought",
          resources: [{ kind: "file", fileId }],
          policy: { model: "next-model", reasoningEffort: "high", latencyMode: "standard" },
        },
      },
    ]);
    expect(calls).toBe(1);
    expect(hook.result.current.finishingUploads).toBe(false);
  } finally {
    await hook.unmount();
  }
});

test("file-only creation snapshots ready files and does not force browser-estimated model defaults", async () => {
  const calls: unknown[] = [];
  const created: CreatedConversation[] = [];
  const api = client();
  const readConfig = api.getClientConfig;
  api.getClientConfig = async () =>
    ({ ...(await readConfig()), fileUploads: { enabled: true, maxSizeBytes: 1000 } }) as never;
  const hook = await renderHook(
    () =>
      useNewConversation({
        client: api,
        workspaceId: WORKSPACE_ID,
        modelPicker: true,
        createSession: async (...args) => {
          calls.push(args);
          return "created-id";
        },
        onCreated: (result) => {
          created.push(result);
        },
      }),
    undefined,
  );
  try {
    await flush(30);
    const fileId = crypto.randomUUID();
    await actRun(() =>
      hook.result.current.files.restoreReadyFiles([
        {
          id: fileId,
          workspaceId: WORKSPACE_ID,
          status: "ready",
          filename: "source.txt",
          contentType: "text/plain",
          sizeBytes: 1,
        } as never,
      ]),
    );
    expect(hook.result.current.composer.canSend).toBe(true);
    expect(await actRun(() => hook.result.current.composer.send())).toBe(true);
    expect(calls).toMatchObject([
      [expect.any(String), expect.any(String), { resources: [{ kind: "file", fileId }] }],
    ]);
    expect(created[0]?.draft).toEqual({ text: "", resources: [] });
    expect(hook.result.current.files.attachments).toEqual([]);
  } finally {
    await hook.unmount();
  }
});

test("host observer failures do not make an accepted creation retryable", async () => {
  const report = spyOn(globalThis, "reportError").mockImplementation(() => {});
  const api = client();
  const hook = await renderHook(
    () =>
      useNewConversation({
        client: api,
        workspaceId: WORKSPACE_ID,
        createSession: async () => "created-id",
        onCreated: () => {
          throw new Error("Host refresh failed");
        },
      }),
    undefined,
  );
  try {
    await actRun(() => hook.result.current.composer.setValue("Accepted question"));
    expect(await actRun(() => hook.result.current.composer.send())).toBe(true);
    expect(hook.result.current.pending).toBeNull();
    expect(hook.result.current.error).toBeNull();
    expect(report).toHaveBeenCalledTimes(1);
  } finally {
    await hook.unmount();
    report.mockRestore();
  }
});

test("new creation admits one click snapshot and hands newer text to the created conversation", async () => {
  let finish!: (id: string) => void;
  const calls: unknown[] = [];
  const created: CreatedConversation[] = [];
  const api = client();
  const hook = await renderHook(
    () =>
      useNewConversation({
        client: api,
        workspaceId: WORKSPACE_ID,
        createSession: (...args) => {
          calls.push(args);
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
        onCreated: (result) => {
          created.push(result);
        },
      }),
    undefined,
  );
  try {
    await actRun(() => hook.result.current.composer.setValue("First question"));
    let submission!: Promise<boolean>;
    await actRun(() => {
      submission = hook.result.current.composer.send();
    });
    expect(await actRun(() => hook.result.current.composer.send())).toBe(false);
    await actRun(() => hook.result.current.composer.setValue("Keep this next thought"));
    await actRun(() => finish("created-id"));
    expect(await submission).toBe(true);
    expect(calls).toHaveLength(1);
    expect(created).toMatchObject([
      {
        sessionId: "created-id",
        initialMessage: "First question",
        draft: { text: "Keep this next thought" },
      },
    ]);
  } finally {
    await hook.unmount();
  }
});

test("editing back to the submitted text is still a newer draft, not disposable content", async () => {
  let finish!: (id: string) => void;
  const created: CreatedConversation[] = [];
  const api = client();
  const hook = await renderHook(
    () =>
      useNewConversation({
        client: api,
        workspaceId: WORKSPACE_ID,
        createSession: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
        onCreated: (result) => {
          created.push(result);
        },
      }),
    undefined,
  );
  try {
    await actRun(() => hook.result.current.composer.setValue("Same words"));
    let submission!: Promise<boolean>;
    await actRun(() => {
      submission = hook.result.current.composer.send();
    });
    await actRun(() => hook.result.current.composer.setValue("Edited"));
    await actRun(() => hook.result.current.composer.setValue("Same words"));
    await actRun(() => finish("created-id"));
    expect(await submission).toBe(true);
    expect(created[0]?.draft.text).toBe("Same words");
  } finally {
    await hook.unmount();
  }
});

test("unknown creation outcome retries the same request and captured host adapter, not newer edits", async () => {
  const calls: Array<[string, string, NewConversationCreateOptions]> = [];
  const created: CreatedConversation[] = [];
  const api = client();
  let replacementCalls = 0;
  const original = async (...args: [string, string, NewConversationCreateOptions]) => {
    calls.push(args);
    if (calls.length === 1) throw new TypeError("Response lost");
    return "same-created-id";
  };
  const hook = await renderHook(
    ({ replacement }) =>
      useNewConversation({
        client: api,
        workspaceId: WORKSPACE_ID,
        createSession: replacement
          ? async () => {
              replacementCalls++;
              return "wrong-id";
            }
          : original,
        onCreated: (result) => {
          created.push(result);
        },
      }),
    { replacement: false },
  );
  try {
    await actRun(() => hook.result.current.composer.setValue("Initial question"));
    expect(await actRun(() => hook.result.current.composer.send())).toBe(false);
    await hook.rerender({ replacement: true });
    await actRun(() => hook.result.current.composer.setValue("Newer unsent question"));
    expect(hook.result.current.composer.canSend).toBe(false);
    expect(await actRun(() => hook.result.current.composer.send())).toBe(false);
    expect(await actRun(() => hook.result.current.retry())).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(replacementCalls).toBe(0);
    expect(created[0]?.draft.text).toBe("Newer unsent question");
  } finally {
    await hook.unmount();
  }
});

test("definitive creation refusal permits an edited fresh operation", async () => {
  const keys: string[] = [];
  const api = client();
  const hook = await renderHook(
    () =>
      useNewConversation({
        client: api,
        workspaceId: WORKSPACE_ID,
        createSession: async (_text, key) => {
          keys.push(key);
          if (keys.length === 1)
            throw new OpenGeniApiError(402, "", {
              code: "payment_required",
              outcomeUnknown: false,
            });
          return "created-id";
        },
      }),
    undefined,
  );
  try {
    await actRun(() => hook.result.current.composer.setValue("Question"));
    expect(await actRun(() => hook.result.current.composer.send())).toBe(false);
    expect(hook.result.current.pending).toBeNull();
    expect(hook.result.current.composer.canSend).toBe(true);
    expect(await actRun(() => hook.result.current.composer.send())).toBe(true);
    expect(keys[1]).not.toBe(keys[0]);
  } finally {
    await hook.unmount();
  }
});

test("a changed scope rejects stale send callbacks and ignores old creation settlement", async () => {
  let finish!: (id: string) => void;
  const created: CreatedConversation[] = [];
  const api = client();
  const hook = await renderHook(
    ({ scopeKey }) =>
      useNewConversation({
        client: api,
        workspaceId: WORKSPACE_ID,
        scopeKey,
        createSession: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
        onCreated: (result) => {
          created.push(result);
        },
      }),
    { scopeKey: "record-a" },
  );
  try {
    await actRun(() => hook.result.current.composer.setValue("For record A"));
    const staleSend = hook.result.current.composer.send;
    let submission!: Promise<boolean>;
    await actRun(() => {
      submission = staleSend();
    });
    await hook.rerender({ scopeKey: "record-b" });
    await actRun(() => hook.result.current.composer.setValue("For record B"));
    expect(await actRun(() => staleSend())).toBe(false);
    await actRun(() => finish("old-record-session"));
    expect(await submission).toBe(true);
    expect(created).toEqual([]);
    expect(hook.result.current.composer.value).toBe("For record B");
    expect(hook.result.current.composer.sending).toBe(false);
  } finally {
    await hook.unmount();
  }
});

test("retired callbacks stay inert after returning to an earlier scope identity", async () => {
  const api = client();
  const calls: Array<{ version: number; text: string; options: NewConversationCreateOptions }> = [];
  const hook = await renderHook(
    ({ scopeKey, version }) =>
      useNewConversation({
        client: api,
        workspaceId: WORKSPACE_ID,
        scopeKey,
        modelPicker: true,
        realtimeVoice: true,
        createSession: async (text, _key, options) => {
          calls.push({ version, text, options });
          return "created-id";
        },
      }),
    { scopeKey: "record-a", version: 1 },
  );
  try {
    await flush(30);
    const retired = hook.result.current;
    await hook.rerender({ scopeKey: "record-b", version: 2 });
    await hook.rerender({ scopeKey: "record-a", version: 3 });
    await actRun(() => {
      hook.result.current.composer.setValue("Current A draft");
      hook.result.current.composer.setModel!("current-model");
      retired.composer.setValue("Retired transcript");
      retired.composer.setModel!("retired-model");
      retired.composer.setReasoningEffort!("low");
      retired.composer.setLatencyMode!("fast");
    });
    expect(hook.result.current.composer.value).toBe("Current A draft");
    expect(hook.result.current.composer.policy?.model).toBe("current-model");
    expect(await actRun(() => retired.composer.send())).toBe(false);
    expect(await actRun(() => retired.startRealtime("opengeni-azure/gpt-live-1"))).toBe(false);
    expect(calls).toEqual([]);
    expect(await actRun(() => hook.result.current.composer.send())).toBe(true);
    expect(calls).toEqual([
      { version: 3, text: "Current A draft", options: { model: "current-model" } },
    ]);
  } finally {
    await hook.unmount();
  }
});

test("committed first-render actions remain usable through StrictMode effect replay", async () => {
  const api = client();
  let calls = 0;
  let creation!: NewConversationController;
  function Host() {
    creation = useNewConversation({
      client: api,
      workspaceId: WORKSPACE_ID,
      createSession: async () => {
        calls++;
        return "created-id";
      },
    });
    return null;
  }
  const view = await renderComponent(
    <StrictMode>
      <Host />
    </StrictMode>,
  );
  try {
    expect(calls).toBe(0);
    await actRun(() => creation.composer.setValue("First committed draft"));
    expect(creation.composer.value).toBe("First committed draft");
    expect(await actRun(() => creation.composer.send())).toBe(true);
    expect(calls).toBe(1);
  } finally {
    await view.unmount();
  }
});

test("a retired retry cannot dispatch the current scope's pending operation", async () => {
  const api = client();
  let calls = 0;
  const hook = await renderHook(
    ({ scopeKey }) =>
      useNewConversation({
        client: api,
        workspaceId: WORKSPACE_ID,
        scopeKey,
        createSession: async () => {
          if (++calls === 1) throw new Error("Response lost");
          return "created-id";
        },
      }),
    { scopeKey: "record-a" },
  );
  try {
    const retry = hook.result.current.retry;
    await hook.rerender({ scopeKey: "record-b" });
    await hook.rerender({ scopeKey: "record-a" });
    await actRun(() => hook.result.current.composer.setValue("Current request"));
    expect(await actRun(() => hook.result.current.composer.send())).toBe(false);
    expect(await actRun(retry)).toBe(false);
    expect(calls).toBe(1);
    expect(await actRun(() => hook.result.current.retry())).toBe(true);
    expect(calls).toBe(2);
  } finally {
    await hook.unmount();
  }
});

test("voice-first creation leaves the text draft untouched and carries an explicit voice handoff", async () => {
  const calls: unknown[] = [];
  const created: CreatedConversation[] = [];
  const api = client();
  const hook = await renderHook(
    () =>
      useNewConversation({
        client: api,
        workspaceId: WORKSPACE_ID,
        realtimeVoice: true,
        createSession: async (...args) => {
          calls.push(args);
          return "voice-session";
        },
        onCreated: (result) => {
          created.push(result);
        },
      }),
    undefined,
  );
  try {
    await flush(30);
    await actRun(() =>
      hook.result.current.composer.setValue("Do not turn this into a voice prompt"),
    );
    expect(await actRun(() => hook.result.current.startRealtime("opengeni-azure/gpt-live-1"))).toBe(
      true,
    );
    expect(calls[0]).toMatchObject(["", expect.any(String), { startMode: "realtime" }]);
    expect(created[0]).toMatchObject({
      sessionId: "voice-session",
      initialMessage: "",
      realtimeModel: "opengeni-azure/gpt-live-1",
      draft: { text: "Do not turn this into a voice prompt" },
    });
  } finally {
    await hook.unmount();
  }
});
