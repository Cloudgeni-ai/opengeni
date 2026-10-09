import { expect, test } from "bun:test";
import type { DraftTimelineAnnotation, SendMessageInput } from "@opengeni/sdk";
import { SessionConversationView } from "../src/components/session-conversation";
import {
  useSessionConversation,
  type SessionConversationController,
} from "../src/hooks/use-session-conversation";
import { fakeClient, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderComponent, renderHook } from "./render-hook";

registerDom();

test("stock view retains host connection actions and empty presentation", async () => {
  const f = fixture();
  const renderConnection = (item: { serverId: string | null }) => (
    <button>Connect {item.serverId}</button>
  );
  function Host({ connected }: { connected: boolean }) {
    const conversation = useSessionConversation(f.sessionId, {
      client: f.client,
      workspaceId: WORKSPACE_ID,
    });
    return (
      <SessionConversationView
        conversation={{
          ...conversation,
          timeline: connected
            ? [
                {
                  kind: "auth-needed",
                  id: "connect-example",
                  turnId: "turn-example",
                  serverId: "acme",
                  toolName: "read_ticket",
                  reason: "missing_connection",
                  providerDomain: "example.com",
                  connectionId: null,
                  scopes: [],
                  resource: null,
                  authorizationUrl: null,
                  occurredAt: "2026-10-01T00:00:00Z",
                },
              ]
            : [],
        }}
        timelineProps={{
          turnSummary: { rolling: false },
          emptyState: <p>Choose a support task</p>,
          renderAuthNeeded: renderConnection,
        }}
      />
    );
  }
  const view = await renderComponent(<Host connected={false} />);
  try {
    await flush(50);
    expect(view.container.textContent).toContain("Choose a support task");
    await view.rerender(<Host connected />);
    await flush(50);
    expect(view.container.textContent).toContain("Connect acme");
    expect(view.container.querySelector("textarea")).not.toBeNull();
    expect(f.streams()).toBe(1);
  } finally {
    await view.unmount();
  }
});

test("a session change retires ready files and late upload settlements from the previous draft", async () => {
  const f = fixture();
  const getConfig = f.client.getClientConfig;
  f.client.getClientConfig = async () =>
    ({ ...(await getConfig()), fileUploads: { enabled: true, maxSizeBytes: 1000 } }) as never;
  let finishUpload!: (asset: never) => void;
  f.client.uploadFile = () =>
    new Promise((resolve) => {
      finishUpload = resolve;
    });
  const asset = {
    id: crypto.randomUUID(),
    workspaceId: WORKSPACE_ID,
    status: "ready",
    filename: "old.txt",
    contentType: "text/plain",
    sizeBytes: 1,
  };
  const hook = await renderHook(
    ({ sessionId }) =>
      useSessionConversation(sessionId, {
        client: f.client,
        workspaceId: WORKSPACE_ID,
      }),
    { sessionId: f.sessionId },
  );
  try {
    await flush(30);
    await actRun(() => {
      hook.result.current.files.restoreReadyFiles([asset as never]);
      hook.result.current.files.addFiles([new File(["test"], "pending.txt")]);
    });
    expect(hook.result.current.files.attachments).toHaveLength(2);
    await hook.rerender({ sessionId: crypto.randomUUID() });
    await flush(30);
    expect(hook.result.current.files.attachments).toEqual([]);
    await actRun(() => finishUpload({ ...asset, id: crypto.randomUUID() } as never));
    expect(hook.result.current.files.attachments).toEqual([]);
    expect(hook.result.current.composer.canSend).toBe(false);
    expect(await actRun(() => hook.result.current.composer.send())).toBe(false);
    expect(f.sent).toEqual([]);
  } finally {
    await hook.unmount();
  }
});

function fixture() {
  const sessionId = crypto.randomUUID();
  const sent: SendMessageInput[] = [];
  let streams = 0;
  const client = fakeClient({
    getSession: async () => ({ id: sessionId, status: "idle" }) as never,
    getQueue: async () => ({ items: [], pendingInputs: [] }) as never,
    listHumanInputRequests: async () => [],
    streamEvents: async function* (_workspace, _session, options) {
      streams++;
      await new Promise<void>((resolve) =>
        options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      yield* [];
    },
    sendMessage: async (_workspace, _session, input) => {
      sent.push(typeof input === "string" ? { text: input } : input);
      return {
        id: crypto.randomUUID(),
        workspaceId: WORKSPACE_ID,
        sessionId,
        sequence: sent.length,
        type: "user.message",
        payload: input,
        occurredAt: new Date().toISOString(),
      };
    },
  });
  return { client, sessionId, sent, streams: () => streams };
}

function annotation(): DraftTimelineAnnotation {
  return {
    id: crypto.randomUUID(),
    source: {
      kind: "user_message",
      eventId: crypto.randomUUID(),
      eventType: "user.message",
      sequence: 1,
      turnId: null,
      startOffset: 0,
      endOffset: 5,
      contextBefore: "",
      contextAfter: " world",
    },
    quote: "hello",
    note: "Use this exact source.",
  };
}

test("stock controller sends annotation-only and restored-file-only drafts with host context", async () => {
  const f = fixture();
  let context = "first record";
  const accepted: SendMessageInput[] = [];
  const hook = await renderHook(
    () =>
      useSessionConversation(f.sessionId, {
        client: f.client,
        workspaceId: WORKSPACE_ID,
        composerOptions: {
          sendExtras: () => ({ modelContext: context }),
          onSent: (_text, input) => {
            accepted.push(input);
          },
        },
      }),
    undefined,
  );
  try {
    await flush(30);
    const note = annotation();
    await actRun(() => hook.result.current.composer.addAnnotation?.(note));
    context = "current record";
    expect(hook.result.current.composer.canSend).toBe(true);
    expect(await actRun(() => hook.result.current.composer.send())).toBe(true);
    await flush(30);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({
      text: "",
      annotations: [note],
      modelContext: "current record",
    });
    expect(accepted).toHaveLength(1);
    expect(hook.result.current.composer.annotations).toEqual([]);

    const resource = { kind: "file" as const, fileId: crypto.randomUUID() };
    await actRun(() =>
      hook.result.current.composer.applyDraft({
        revision: hook.result.current.composer.draftRevision,
        text: "",
        resources: [resource],
        annotations: [],
        model: "model-x",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sourceTurnId: null,
        sourceTurnVersion: null,
        updatedAt: null,
      }),
    );
    expect(hook.result.current.composer.canSend).toBe(true);
    expect(await actRun(() => hook.result.current.composer.send())).toBe(true);
    await flush(30);
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]?.resources).toEqual([resource]);
  } finally {
    await hook.unmount();
  }
});

test("one controller retains the native draft and stream across stock view replacement", async () => {
  const f = fixture();
  let conversation!: SessionConversationController;
  function Host({ layout }: { layout: "panel" | "hidden" | "page" }) {
    conversation = useSessionConversation(f.sessionId, {
      client: f.client,
      workspaceId: WORKSPACE_ID,
    });
    return layout === "hidden" ? null : (
      <SessionConversationView key={layout} conversation={conversation} />
    );
  }
  const view = await renderComponent(<Host layout="panel" />);
  try {
    await flush(30);
    await actRun(() => {
      conversation.composer.setValue("Keep this unfinished thought");
      conversation.composer.addAnnotation?.(annotation());
    });
    await view.rerender(<Host layout="hidden" />);
    await view.rerender(<Host layout="page" />);
    await flush(30);
    expect(conversation.composer.value).toBe("Keep this unfinished thought");
    expect(conversation.composer.annotations).toHaveLength(1);
    expect(view.container.querySelector("textarea")?.value).toBe("Keep this unfinished thought");
    expect(f.streams()).toBe(1);
    expect(f.sent).toEqual([]);
  } finally {
    await view.unmount();
  }
});

test("host send guards augment stock read-only admission rather than replace it", async () => {
  const f = fixture();
  f.client.getSession = async () => ({ id: f.sessionId, status: "cancelled" }) as never;
  const hook = await renderHook(
    () =>
      useSessionConversation(f.sessionId, {
        client: f.client,
        workspaceId: WORKSPACE_ID,
        composerOptions: { sendBlocked: () => false },
      }),
    undefined,
  );
  try {
    await flush(30);
    await actRun(() => hook.result.current.composer.setValue("Do not send"));
    expect(hook.result.current.composer.canSend).toBe(false);
    expect(await actRun(() => hook.result.current.composer.send())).toBe(false);
    expect(f.sent).toEqual([]);
  } finally {
    await hook.unmount();
  }
});

test("host notification failures cannot turn accepted sends into retryable failures", async () => {
  const f = fixture();
  const reported: unknown[] = [];
  const originalReport = globalThis.reportError;
  globalThis.reportError = (cause) => {
    reported.push(cause);
  };
  let deliveryErrors = 0;
  const hook = await renderHook(
    () =>
      useSessionConversation(f.sessionId, {
        client: f.client,
        workspaceId: WORKSPACE_ID,
        composerOptions: {
          onSubmitted: () => {
            throw new Error("Host draft notification failed");
          },
          onSent: async () => {
            throw new Error("Host metadata update failed");
          },
          onDeliveryError: () => {
            deliveryErrors++;
          },
        },
      }),
    undefined,
  );
  try {
    await flush(30);
    await actRun(() => hook.result.current.composer.setValue("Send once"));
    expect(await actRun(() => hook.result.current.composer.send())).toBe(true);
    await flush(30);
    expect(f.sent).toHaveLength(1);
    expect(deliveryErrors).toBe(0);
    expect(reported).toHaveLength(2);
    expect(hook.result.current.composer.error).toBeNull();
    expect(
      hook.result.current.composer.optimisticMessages?.some(
        (message) => message.state === "failed",
      ),
    ).toBe(false);
  } finally {
    await hook.unmount();
    globalThis.reportError = originalReport;
  }
});

test("unresolved uploads block direct send and removal unblocks without replacing stock delivery", async () => {
  const f = fixture();
  const getConfig = f.client.getClientConfig;
  f.client.getClientConfig = async () =>
    ({
      ...(await getConfig()),
      fileUploads: { enabled: true, maxSizeBytes: 1_000_000 },
    }) as never;
  let failUpload!: (cause: Error) => void;
  f.client.uploadFile = () =>
    new Promise((_resolve, reject) => {
      failUpload = reject;
    });
  const hook = await renderHook(
    () =>
      useSessionConversation(f.sessionId, {
        client: f.client,
        workspaceId: WORKSPACE_ID,
        composerOptions: { sendBlocked: () => false },
      }),
    undefined,
  );
  try {
    await flush(30);
    await actRun(() => {
      hook.result.current.composer.setValue("Read the attachment");
      hook.result.current.files.addFiles([new File(["test"], "notes.txt", { type: "text/plain" })]);
    });
    expect(hook.result.current.composer.canSend).toBe(false);
    expect(await actRun(() => hook.result.current.composer.send())).toBe(false);
    await actRun(() => failUpload(new Error("Upload failed")));
    expect(hook.result.current.composer.canSend).toBe(false);
    expect(await actRun(() => hook.result.current.composer.send())).toBe(false);
    await actRun(() =>
      hook.result.current.files.remove(hook.result.current.files.attachments[0]!.id),
    );
    expect(hook.result.current.composer.canSend).toBe(true);
    expect(await actRun(() => hook.result.current.composer.send())).toBe(true);
    await flush(30);
    expect(f.sent).toHaveLength(1);
  } finally {
    await hook.unmount();
  }
});
