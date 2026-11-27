// The new-chat composer is the follow-up composer: attachments, the host's
// composerProps, and the model picker when offered, with the first message's
// files and explicit model choice reaching session creation.
import { describe, expect, test } from "bun:test";
import type { Session } from "@opengeni/sdk";
import { useLayoutEffect, useRef, useState } from "react";
import { NewConversationView } from "../src/components/new-conversation";
import { OpenGeniChat } from "../src/components/open-geni-chat";
import { useNewConversation, type CreatedConversation } from "../src/hooks/use-new-conversation";
import { fakeClient, WORKSPACE_ID } from "./fake-client";
import { LEVEL_MODELS, LEVELS } from "./fixtures/level-models";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();

const CREATED = "bbbbbbbb-0000-4000-8000-000000000002";

function session(id: string): Session {
  const now = new Date().toISOString();
  return {
    id,
    workspaceId: WORKSPACE_ID,
    title: "Chat",
    titleSource: "user",
    status: "idle",
    initialMessage: "Chat",
    updatedAt: now,
    createdAt: now,
  } as unknown as Session;
}

function chatClient(config: Record<string, unknown> = {}, catalog: unknown[] = []) {
  const requests: unknown[] = [];
  const client = fakeClient({
    getClientConfig: async () =>
      ({
        apiContractRevision: "test",
        defaultModel: "model-x",
        defaultReasoningEffort: "medium",
        models: [],
        fileUploads: { enabled: false, maxSizeBytes: 0 },
        ...config,
      }) as never,
    listSessionPage: async () => ({ pinned: [], sessions: [], nextCursor: null }) as never,
    getSession: async (_workspace, id) => session(id) as never,
    getQueue: async () =>
      ({ version: 1, effectiveControl: null, items: [], pendingInputs: [] }) as never,
    getWorkspaceModelCatalog: async () => ({ models: catalog }) as never,
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
        filename: "notes.txt",
        safeFilename: "notes.txt",
        contentType: "text/plain",
        sizeBytes: 2,
        sha256: null,
        bucket: "b",
        objectKey: "k",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }) as never,
  });
  Object.assign(client as object, {
    createSession: async (_workspace: string, request: unknown) => {
      requests.push(request);
      return session(CREATED);
    },
  });
  return { client, requests };
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

describe("OpenGeniChat new-chat composer", () => {
  test("attachments, composerProps and the model picker reach the first message", async () => {
    const { client, requests } = chatClient({
      fileUploads: { enabled: true, maxSizeBytes: 1_000_000 },
    });
    const view = await renderComponent(
      <OpenGeniChat
        client={client}
        workspaceId={WORKSPACE_ID}
        conversationProps={{
          modelPicker: true,
          modelPickerProps: { messages: { label: "Choose a model" } },
          composerProps: { actionsStart: <button type="button" data-testid="host-action" /> },
        }}
      />,
    );
    try {
      await flush(80);
      const form = view.container.querySelector("[data-og-new-chat-composer]")!;
      expect(form.querySelector("[data-testid='host-action']")).not.toBeNull();
      expect(form.querySelector('button[aria-label="Choose a model"]')).not.toBeNull();
      const attach = form.querySelector<HTMLInputElement>("input[data-og-composer-attach]")!;
      expect(attach).not.toBeNull();
      await actRun(() =>
        reactProps<{ onChange: (event: unknown) => void }>(attach).onChange({
          target: { files: [new File(["q3"], "q3.csv", { type: "text/csv" })], value: "" },
        }),
      );
      await flush(50);
      await actRun(() => typeInto(form.querySelector("textarea")!, "Summarize the file"));
      await actRun(() =>
        form.querySelector<HTMLButtonElement>("button[aria-label='Send']")!.click(),
      );
      await flush(80);
      // An untouched picker sends no model policy: the server keeps its own.
      expect(requests).toEqual([
        {
          initialMessage: "Summarize the file",
          idempotencyKey: expect.any(String),
          resources: [{ kind: "file", fileId: "file-1" }],
        },
      ]);
      expect(view.container.querySelector("[data-og-conversation]")).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });

  test("a custom createSession receives the attached files", async () => {
    const { client } = chatClient({ fileUploads: { enabled: true, maxSizeBytes: 1_000_000 } });
    const calls: unknown[] = [];
    const view = await renderComponent(
      <OpenGeniChat
        client={client}
        workspaceId={WORKSPACE_ID}
        createSession={async (initialMessage, _key, options) => {
          calls.push({ initialMessage, options });
          return CREATED;
        }}
      />,
    );
    try {
      await flush(50);
      const form = view.container.querySelector<HTMLFormElement>("[data-og-new-chat-composer]")!;
      await actRun(() =>
        reactProps<{ onChange: (event: unknown) => void }>(
          form.querySelector("input[data-og-composer-attach]")!,
        ).onChange({
          target: { files: [new File(["x"], "x.txt", { type: "text/plain" })], value: "" },
        }),
      );
      await flush(50);
      // A file-only first message is sendable.
      await actRun(() => form.requestSubmit());
      await flush(50);
      expect(calls).toEqual([
        {
          initialMessage: "(see attached context)",
          options: { resources: [{ kind: "file", fileId: "file-1" }] },
        },
      ]);
    } finally {
      await view.unmount();
    }
  });

  test("host levels pick the first message's model and effort", async () => {
    const { client, requests } = chatClient(
      { defaultModel: "codex/everyday", defaultReasoningEffort: "high" },
      LEVEL_MODELS,
    );
    const view = await renderComponent(
      <OpenGeniChat
        client={client}
        workspaceId={WORKSPACE_ID}
        conversationProps={{ modelPicker: true, modelPickerProps: { levels: LEVELS } }}
      />,
    );
    try {
      await flush(80);
      const form = view.container.querySelector<HTMLFormElement>("[data-og-new-chat-composer]")!;
      const slider = form.querySelector<HTMLElement>("[role='slider']")!;
      expect(slider.getAttribute("aria-valuetext")).toBe("Standard");
      await actRun(() =>
        slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
      );
      await flush(20);
      expect(slider.getAttribute("aria-valuetext")).toBe("Thorough");
      await actRun(() => typeInto(form.querySelector("textarea")!, "Plan the release"));
      await actRun(() => form.requestSubmit());
      await flush(80);
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(requests[0])).toContain('"codex/deep"');
      expect(JSON.stringify(requests[0])).not.toContain("ultrafast");
    } finally {
      await view.unmount();
    }
  });

  test("an unseeded new chat submits the first runnable level when the workspace default is outside the levels", async () => {
    const { client, requests } = chatClient({ defaultModel: "codex/deep" }, LEVEL_MODELS);
    const view = await renderComponent(
      <OpenGeniChat
        client={client}
        workspaceId={WORKSPACE_ID}
        conversationProps={{
          modelPicker: true,
          modelPickerProps: {
            levels: [{ ...LEVELS[0]!, model: "unavailable" }, ...LEVELS],
          },
        }}
      />,
    );
    try {
      const form = view.container.querySelector<HTMLFormElement>("[data-og-new-chat-composer]")!;
      expect(form.querySelector("[role='slider']")?.getAttribute("aria-valuetext")).toBe(
        "Standard",
      );
      await actRun(() => typeInto(form.querySelector("textarea")!, "Start a draft"));
      await actRun(() => form.requestSubmit());
      expect(requests).toEqual([
        {
          initialMessage: "Start a draft",
          idempotencyKey: expect.any(String),
          model: "codex/everyday",
          reasoningEffort: "high",
        },
      ]);
    } finally {
      await view.unmount();
    }
  });

  test("an unchanged level choice hands no policy over when the view unmounts during creation", async () => {
    const { client } = chatClient({ defaultModel: "codex/deep" }, LEVEL_MODELS);
    let finish!: (id: string) => void;
    const created: CreatedConversation[] = [];
    const sent: unknown[] = [];
    // As in OpenGeniChat: the conversation replaces the new-chat view from Send.
    function Host() {
      const creation = useNewConversation({
        client,
        workspaceId: WORKSPACE_ID,
        modelPicker: true,
        createSession: (_message, _key, options) => {
          sent.push(options);
          return new Promise((resolve) => (finish = resolve));
        },
        onCreated: (result) => created.push(result),
      });
      return creation.pendingPrompt ? null : (
        <NewConversationView creation={creation} modelPickerProps={{ levels: LEVELS }} />
      );
    }
    const view = await renderComponent(<Host />);
    try {
      await flush(80);
      const form = view.container.querySelector<HTMLFormElement>("[data-og-new-chat-composer]")!;
      await actRun(() => typeInto(form.querySelector("textarea")!, "Start a draft"));
      await actRun(() => form.requestSubmit());
      expect(view.container.querySelector("[data-og-new-chat-composer]")).toBeNull();
      await actRun(() => finish(CREATED));
      await flush(20);
      expect(sent).toEqual([{ model: "codex/everyday", reasoningEffort: "high" }]);
      // The created session already runs the sent level; nothing replaces it.
      expect(created).toHaveLength(1);
      expect(created[0]!.draft.policy).toBeUndefined();
    } finally {
      await view.unmount();
    }
  });

  test("an explicit model without an effort does not inherit the level fallback's effort", async () => {
    const { client, requests } = chatClient({ defaultModel: "codex/deep" }, LEVEL_MODELS);
    function Host() {
      const creation = useNewConversation({ client, workspaceId: WORKSPACE_ID, modelPicker: true });
      return (
        <>
          <button type="button" onClick={() => creation.composer.setModel!("codex/deep")}>
            Set model
          </button>
          <NewConversationView creation={creation} modelPickerProps={{ levels: LEVELS }} />
        </>
      );
    }
    const view = await renderComponent(<Host />);
    try {
      const form = view.container.querySelector<HTMLFormElement>("[data-og-new-chat-composer]")!;
      await actRun(() => view.container.querySelector("button")!.click());
      await actRun(() => typeInto(form.querySelector("textarea")!, "Use the model default"));
      await actRun(() => form.requestSubmit());
      expect(requests).toEqual([
        {
          initialMessage: "Use the model default",
          idempotencyKey: expect.any(String),
          model: "codex/deep",
        },
      ]);
    } finally {
      await view.unmount();
    }
  });

  test.each(["button", "shortcut"])(
    "a host-seeded level reaches the create request on first and second New via %s",
    async (entry) => {
      const { client, requests } = chatClient({ defaultModel: "codex/deep" }, LEVEL_MODELS);
      function Host() {
        const [draft, setDraft] = useState(0);
        const seededDraft = useRef(0);
        const creation = useNewConversation({
          client,
          workspaceId: WORKSPACE_ID,
          modelPicker: true,
          scopeKey: `draft-${draft}`,
        });
        const newChat = () => setDraft((current) => current + 1);
        useLayoutEffect(() => {
          if (seededDraft.current === draft) return;
          seededDraft.current = draft;
          creation.composer.setModel!(LEVELS[1]!.model);
          creation.composer.setReasoningEffort!(LEVELS[1]!.effort);
        }, [creation.composer, draft]);
        return (
          <div
            onKeyDown={(event) => {
              if (event.ctrlKey && event.key === "k") newChat();
            }}
          >
            <button type="button" onClick={newChat}>
              New
            </button>
            {draft ? (
              <NewConversationView creation={creation} modelPickerProps={{ levels: LEVELS }} />
            ) : (
              <p>Existing chat</p>
            )}
          </div>
        );
      }

      const view = await renderComponent(<Host />);
      try {
        expect(view.container.textContent).toContain("Existing chat");
        const newButton = view.container.querySelector("button")!;
        const labels: Array<string | null> = [];
        for (const initialMessage of ["First draft", "Second draft"]) {
          await actRun(() => {
            if (entry === "button") newButton.click();
            else
              newButton.dispatchEvent(
                new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }),
              );
          });
          const form = view.container.querySelector<HTMLFormElement>(
            "[data-og-new-chat-composer]",
          )!;
          labels.push(form.querySelector("[role='slider']")!.getAttribute("aria-valuetext"));
          await actRun(() => typeInto(form.querySelector("textarea")!, initialMessage));
          await actRun(() => form.requestSubmit());
        }

        expect(requests).toEqual(
          ["First draft", "Second draft"].map((initialMessage) => ({
            initialMessage,
            idempotencyKey: expect.any(String),
            model: "codex/deep",
            reasoningEffort: "high",
          })),
        );
        expect(labels).toEqual(["Thorough", "Thorough"]);
      } finally {
        await view.unmount();
      }
    },
  );

  test("without uploads or offered model choice the composer stays minimal", async () => {
    const { client, requests } = chatClient();
    const view = await renderComponent(<OpenGeniChat client={client} workspaceId={WORKSPACE_ID} />);
    try {
      await flush(50);
      const form = view.container.querySelector<HTMLFormElement>("[data-og-new-chat-composer]")!;
      expect(form.querySelector("input[data-og-composer-attach]")).toBeNull();
      expect(form.querySelector('button[aria-label="Choose a model"]')).toBeNull();
      expect(form.querySelector("textarea")!.getAttribute("placeholder")).toBe("Ask anything…");
      await actRun(() => typeInto(form.querySelector("textarea")!, "Hello"));
      await actRun(() => form.requestSubmit());
      await flush(50);
      expect(requests).toEqual([{ initialMessage: "Hello", idempotencyKey: expect.any(String) }]);
    } finally {
      await view.unmount();
    }
  });
});
