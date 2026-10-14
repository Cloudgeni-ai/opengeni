// The new-chat composer is the follow-up composer: attachments, the host's
// composerProps, and the model picker when offered, with the first message's
// files and explicit model choice reaching session creation.
import { describe, expect, test } from "bun:test";
import type { Session } from "@opengeni/sdk";
import { OpenGeniChat } from "../src/components/open-geni-chat";
import { fakeClient, WORKSPACE_ID } from "./fake-client";
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

function chatClient(config: Record<string, unknown> = {}) {
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
