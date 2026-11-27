// The first message of a new chat shows on the next frame after Send, as in a
// running chat: the new-chat controller exposes it while the chat is being
// created, a mounted conversation takes each new conversation's own, and
// OpenGeniChat shows the conversation from Send, back to the new chat on failure.
import { describe, expect, test } from "bun:test";
import { OpenGeniApiError, type Session } from "@opengeni/sdk";
import { useState } from "react";
import { OpenGeniChat } from "../src/components/open-geni-chat";
import { SessionConversationView } from "../src/components/session-conversation";
import { useNewConversation, type CreatedConversation } from "../src/hooks/use-new-conversation";
import { useSessionConversation } from "../src/hooks/use-session-conversation";
import { fakeClient, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderComponent, renderHook } from "./render-hook";

registerDom();

const FIRST = "bbbbbbbb-0000-4000-8000-000000000001";
const SECOND = "bbbbbbbb-0000-4000-8000-000000000002";

function session(id: string): Session {
  const now = new Date().toISOString();
  return {
    id,
    workspaceId: WORKSPACE_ID,
    title: "Chat",
    titleSource: "user",
    status: "queued",
    activeTurnId: null,
    effectiveControl: { state: "active", controlVersion: 1 },
    initialMessage: "Chat",
    updatedAt: now,
    createdAt: now,
  } as unknown as Session;
}

/** Session creation the test settles by hand; histories never load. */
function chatClient(uploads = false) {
  const creates: Array<{
    request: { initialMessage?: string; resources?: unknown };
    resolve: (id: string) => void;
    reject: (cause: unknown) => void;
  }> = [];
  const client = fakeClient({
    getClientConfig: async () =>
      ({
        apiContractRevision: "test",
        defaultModel: "model-x",
        defaultReasoningEffort: "medium",
        models: [],
        fileUploads: { enabled: uploads, maxSizeBytes: 1_000_000 },
      }) as never,
    listSessionPage: async () => ({ pinned: [], sessions: [], nextCursor: null }) as never,
    getSession: async (_workspace, id) => session(id) as never,
    listEvents: () => new Promise(() => {}),
    getQueue: async () =>
      ({ version: 1, effectiveControl: null, items: [], pendingInputs: [] }) as never,
    getWorkspaceModelCatalog: async () => ({ models: [] }) as never,
    listHumanInputRequests: async () => [],
    streamEvents: async function* (_workspace, _session, options) {
      await new Promise<void>((resolve) =>
        options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      yield* [];
    },
    uploadFile: async () =>
      ({
        id: "file-1",
        workspaceId: WORKSPACE_ID,
        status: "ready",
        filename: "plan.pdf",
        safeFilename: "plan.pdf",
        contentType: "application/pdf",
        sizeBytes: 2,
        sha256: null,
        bucket: "b",
        objectKey: "k",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }) as never,
  });
  Object.assign(client as object, {
    getFile: async () => ({
      id: "file-1",
      workspaceId: WORKSPACE_ID,
      status: "ready",
      filename: "plan.pdf",
      contentType: "application/pdf",
      sizeBytes: 2,
    }),
    createSession: (_workspace: string, request: { initialMessage?: string }) =>
      new Promise((resolve, reject) =>
        creates.push({ request, resolve: (id) => resolve(session(id)), reject }),
      ),
  });
  return { client, creates };
}

function reactProps<T>(element: Element): T {
  const key = Object.keys(element).find((name) => name.startsWith("__reactProps$"))!;
  return (element as unknown as Record<string, T>)[key]!;
}

function typeInto(textarea: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
    textarea,
    value,
  );
  reactProps<{ onChange: (event: unknown) => void }>(textarea).onChange({ target: textarea });
}

const startupRows = (root: Element) => root.querySelectorAll(".og-genie-loading");

test("useNewConversation exposes the first message from Send until onCreated or failure", async () => {
  const { client, creates } = chatClient();
  const created: CreatedConversation[] = [];
  const hook = await renderHook(
    () =>
      useNewConversation({
        client,
        workspaceId: WORKSPACE_ID,
        onCreated: (result) => created.push(result),
      }),
    undefined,
  );
  try {
    await flush(30);
    expect(hook.result.current.pendingPrompt).toBeNull();
    // A host's prepared prompt, for example from a button.
    await actRun(() => void hook.result.current.composer.send("Prepared prompt"));
    const prompt = hook.result.current.pendingPrompt;
    expect(prompt).toEqual({ text: "Prepared prompt", sentAt: expect.any(String) });
    expect(hook.result.current.composer.sending).toBe(true);
    await actRun(() => creates[0]!.resolve(FIRST));
    await flush(10);
    expect(hook.result.current.pendingPrompt).toBeNull();
    expect(created).toEqual([
      expect.objectContaining({
        sessionId: FIRST,
        initialMessage: "Prepared prompt",
        sentAt: prompt!.sentAt,
        resources: [],
      }),
    ]);

    await actRun(() => void hook.result.current.composer.send("Second prompt"));
    expect(hook.result.current.pendingPrompt?.text).toBe("Second prompt");
    await actRun(() =>
      creates[1]!.reject(new OpenGeniApiError(422, "", { code: "invalid", outcomeUnknown: false })),
    );
    await flush(10);
    expect(hook.result.current.pendingPrompt).toBeNull();
    expect(hook.result.current.error).not.toBeNull();
  } finally {
    await hook.unmount();
  }
});

test("one mounted conversation controller shows each new conversation's own first prompt", async () => {
  const { client, creates } = chatClient();
  let creation!: ReturnType<typeof useNewConversation>;
  let startNew!: () => void;
  // A host that mounts both controllers once and keeps them across chats.
  function Host() {
    const [sessionId, setSessionId] = useState<string | null>(null);
    startNew = () => setSessionId(null);
    creation = useNewConversation({
      client,
      workspaceId: WORKSPACE_ID,
      onCreated: (created) => setSessionId(created.sessionId),
    });
    const conversation = useSessionConversation(sessionId, {
      client,
      workspaceId: WORKSPACE_ID,
      pendingPrompt: creation.pendingPrompt,
    });
    return <SessionConversationView conversation={conversation} />;
  }
  const view = await renderComponent(<Host />);
  try {
    await flush(30);
    expect(view.container.textContent).not.toContain("First question");
    await actRun(() => void creation.composer.send("First question"));
    // The next frame after Send, before the server answers.
    expect(view.container.textContent).toContain("First question");
    expect(startupRows(view.container)).toHaveLength(1);
    const row = startupRows(view.container)[0];
    await actRun(() => creates[0]!.resolve(FIRST));
    await flush(50);
    // The created id arrives in the same render the controller drops its prompt.
    expect(view.container.textContent).toContain("First question");
    expect(startupRows(view.container)[0]).toBe(row);

    await actRun(() => startNew());
    await flush(30);
    expect(view.container.textContent).not.toContain("First question");
    expect(startupRows(view.container)).toHaveLength(0);
    await actRun(() => void creation.composer.send("Second question"));
    expect(view.container.textContent).toContain("Second question");
    expect(view.container.textContent).not.toContain("First question");
    expect(startupRows(view.container)).toHaveLength(1);
    await actRun(() => creates[1]!.resolve(SECOND));
    await flush(50);
    expect(view.container.textContent).toContain("Second question");
    expect(view.container.textContent).not.toContain("First question");
  } finally {
    await view.unmount();
  }
});

describe("OpenGeniChat first message", () => {
  test("shows in the conversation with its attachment and startup row from Send", async () => {
    const { client, creates } = chatClient(true);
    const view = await renderComponent(<OpenGeniChat client={client} workspaceId={WORKSPACE_ID} />);
    try {
      await flush(80);
      const form = view.container.querySelector("[data-og-new-chat-composer]")!;
      await actRun(() =>
        reactProps<{ onChange: (event: unknown) => void }>(
          form.querySelector("input[data-og-composer-attach]")!,
        ).onChange({
          target: {
            files: [new File(["pdf"], "plan.pdf", { type: "application/pdf" })],
            value: "",
          },
        }),
      );
      await flush(50);
      await actRun(() => typeInto(form.querySelector("textarea")!, "Review this plan"));
      await actRun(() =>
        form.querySelector<HTMLButtonElement>("button[aria-label='Send']")!.click(),
      );
      // The server has not answered: the conversation already shows the message.
      expect(creates).toHaveLength(1);
      expect(view.container.querySelector("[data-og-new-chat-composer]")).toBeNull();
      const conversation = view.container.querySelector("[data-og-conversation]");
      expect(conversation?.textContent).toContain("Review this plan");
      expect(startupRows(view.container)).toHaveLength(1);
      expect(view.container.querySelector("[data-og-message-attachments]")).not.toBeNull();
      await flush(50);
      expect(view.container.querySelector("[data-og-message-attachments]")?.textContent).toContain(
        "plan.pdf",
      );
      const row = startupRows(view.container)[0];
      await actRun(() => creates[0]!.resolve(FIRST));
      await flush(80);
      // The same conversation and startup row continue in the created chat.
      expect(view.container.querySelector("[data-og-conversation]")).toBe(conversation);
      expect(startupRows(view.container)[0]).toBe(row);
      expect(conversation?.textContent).toContain("Review this plan");
      expect(view.container.querySelector("[data-og-message-attachments]")).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });

  test("a refused create goes back to the new chat with its draft and reason", async () => {
    const { client, creates } = chatClient();
    const view = await renderComponent(<OpenGeniChat client={client} workspaceId={WORKSPACE_ID} />);
    try {
      await flush(80);
      let form = view.container.querySelector("[data-og-new-chat-composer]")!;
      await actRun(() => typeInto(form.querySelector("textarea")!, "Plan my week"));
      await actRun(() =>
        form.querySelector<HTMLButtonElement>("button[aria-label='Send']")!.click(),
      );
      expect(view.container.querySelector("[data-og-conversation]")?.textContent).toContain(
        "Plan my week",
      );
      await actRun(() =>
        creates[0]!.reject(
          new OpenGeniApiError(400, JSON.stringify({ error: "Not allowed here" }), {
            outcomeUnknown: false,
          }),
        ),
      );
      await flush(30);
      form = view.container.querySelector("[data-og-new-chat-composer]")!;
      expect(form).not.toBeNull();
      expect(view.container.querySelector("[data-og-conversation]")).toBeNull();
      expect(form.querySelector("textarea")!.value).toBe("Plan my week");
      expect(form.querySelector("[role='alert']")?.textContent).toContain("Not allowed here");
      expect(view.container.textContent).not.toContain("Creation is not confirmed");
    } finally {
      await view.unmount();
    }
  });

  test("an unconfirmed create goes back to the new chat, and Retry shows the message again", async () => {
    const { client, creates } = chatClient();
    const view = await renderComponent(<OpenGeniChat client={client} workspaceId={WORKSPACE_ID} />);
    try {
      await flush(80);
      const form = view.container.querySelector("[data-og-new-chat-composer]")!;
      await actRun(() => typeInto(form.querySelector("textarea")!, "Plan my week"));
      await actRun(() =>
        form.querySelector<HTMLButtonElement>("button[aria-label='Send']")!.click(),
      );
      await actRun(() => creates[0]!.reject(new Error("network")));
      await flush(30);
      expect(view.container.textContent).toContain("Creation is not confirmed");
      const retry = [...view.container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Retry",
      )!;
      await actRun(() => retry.click());
      expect(creates).toHaveLength(2);
      expect(creates[1]!.request).toEqual(creates[0]!.request);
      expect(view.container.querySelector("[data-og-conversation]")?.textContent).toContain(
        "Plan my week",
      );
      await actRun(() => creates[1]!.resolve(FIRST));
      await flush(50);
      expect(view.container.querySelector("[data-og-conversation]")?.textContent).toContain(
        "Plan my week",
      );
    } finally {
      await view.unmount();
    }
  });

  test("opening another chat while one is being created shows that chat, not the message", async () => {
    const { client } = chatClient();
    Object.assign(client as object, {
      listSessionPage: async () =>
        ({
          pinned: [],
          sessions: [{ ...session(SECOND), title: "Older chat" }],
          nextCursor: null,
        }) as never,
    });
    const view = await renderComponent(<OpenGeniChat client={client} workspaceId={WORKSPACE_ID} />);
    try {
      await flush(80);
      const form = view.container.querySelector("[data-og-new-chat-composer]")!;
      await actRun(() => typeInto(form.querySelector("textarea")!, "Plan my week"));
      await actRun(() =>
        form.querySelector<HTMLButtonElement>("button[aria-label='Send']")!.click(),
      );
      expect(view.container.querySelector("[data-og-conversation]")?.textContent).toContain(
        "Plan my week",
      );
      await actRun(() =>
        view.container.querySelector<HTMLButtonElement>("[data-og-session-row]")!.click(),
      );
      await flush(30);
      expect(view.container.querySelector("[data-og-conversation]")?.textContent).not.toContain(
        "Plan my week",
      );
    } finally {
      await view.unmount();
    }
  });
});
