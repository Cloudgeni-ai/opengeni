import { describe, expect, test } from "bun:test";
import type { Session } from "@opengeni/sdk";
import { OpenGeniChat } from "../src/components/open-geni-chat";
import { SessionList } from "../src/components/session-list";
import { fakeClient, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();

function session(id: string, title: string): Session {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    title,
    titleSource: "user",
    status: "idle",
    initialMessage: title,
    updatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  } as unknown as Session;
}

function listClient(overrides: Record<string, unknown> = {}) {
  const sessions = [session("aaaaaaaa-0000-4000-8000-000000000001", "Quarterly report")];
  const calls: string[] = [];
  const client = fakeClient({
    listSessionPage: async (_workspace, options) => {
      calls.push(`list:${options?.parentSessionId === null ? "root" : "any"}`);
      return { pinned: [], sessions: [...sessions], nextCursor: null } as never;
    },
    updateSession: async (_workspace, id, request) => {
      calls.push(`rename:${id}:${request.title}`);
      sessions[0] = { ...sessions[0]!, title: request.title ?? null };
      return sessions[0] as never;
    },
    getSession: async (_workspace, id) => ({ ...session(id, "x") }) as never,
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
    ...overrides,
  });
  Object.assign(client as object, {
    updateSessionArchive: async (
      _workspace: string,
      id: string,
      request: { archived: boolean },
    ) => {
      calls.push(`archive:${id}:${request.archived}`);
      sessions.splice(0, 1);
      return {} as never;
    },
    createSession: async (_workspace: string, request: { initialMessage: string }) => {
      calls.push(`create:${request.initialMessage}`);
      const created = session("bbbbbbbb-0000-4000-8000-000000000002", request.initialMessage);
      sessions.unshift(created);
      return created;
    },
  });
  return { client, calls, sessions };
}

describe("SessionList", () => {
  test("lists root chats, selects, renames, and archives", async () => {
    const { client, calls } = listClient();
    const selected: string[] = [];
    const view = await renderComponent(
      <SessionList
        client={client}
        workspaceId={WORKSPACE_ID}
        onSelect={(id) => selected.push(id)}
      />,
    );
    try {
      await flush(50);
      expect(calls[0]).toBe("list:root");
      const row = view.container.querySelector<HTMLButtonElement>("[data-og-session-row]")!;
      expect(row.textContent).toContain("Quarterly report");
      await actRun(() => row.click());
      expect(selected).toEqual(["aaaaaaaa-0000-4000-8000-000000000001"]);

      await actRun(() =>
        view.container
          .querySelector<HTMLButtonElement>("[aria-label='Rename: Quarterly report']")!
          .click(),
      );
      const input = view.container.querySelector<HTMLInputElement>("input[aria-label='Rename']")!;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "Q3 report");
      const key = Object.keys(input).find((name) => name.startsWith("__reactProps$"))!;
      await actRun(() =>
        (input as unknown as Record<string, { onChange: (event: unknown) => void }>)[key]!.onChange(
          {
            target: input,
          },
        ),
      );
      await actRun(() => input.form!.requestSubmit());
      await flush(50);
      expect(calls).toContain("rename:aaaaaaaa-0000-4000-8000-000000000001:Q3 report");

      await actRun(() =>
        view.container.querySelector<HTMLButtonElement>("[aria-label^='Archive:']")!.click(),
      );
      await flush(50);
      expect(calls).toContain("archive:aaaaaaaa-0000-4000-8000-000000000001:true");
      expect(view.container.textContent).toContain("No chats yet");
    } finally {
      await view.unmount();
    }
  });
});

describe("OpenGeniChat", () => {
  test("conversation appearance reaches the stock model picker without replacing the conversation", async () => {
    const { client, sessions } = listClient();
    const view = await renderComponent(
      <OpenGeniChat
        client={client}
        workspaceId={WORKSPACE_ID}
        sessionId={sessions[0]!.id}
        conversationProps={{
          modelPickerProps: {
            groupPresentation: {
              opengeni_credits: {
                label: "Acme Assist",
                icon: <svg data-testid="acme-conversation-model-mark" />,
              },
            },
            messages: { label: "Choose a model" },
          },
        }}
      />,
    );
    try {
      await flush(150);
      const trigger = view.container.querySelector('button[aria-label="Choose a model"]');
      expect(trigger).not.toBeNull();
      expect(
        trigger?.querySelector(
          '[aria-label="Acme Assist"] [data-testid="acme-conversation-model-mark"]',
        ),
      ).not.toBeNull();
      expect(
        view.container.querySelector("[data-og-conversation-composer] textarea"),
      ).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });

  test("starts a new chat from the first message and switches to it", async () => {
    const { client, calls } = listClient();
    const changes: Array<string | null> = [];
    const view = await renderComponent(
      <OpenGeniChat
        client={client}
        workspaceId={WORKSPACE_ID}
        onSessionChange={(id) => changes.push(id)}
      />,
    );
    try {
      await flush(50);
      expect(view.container.querySelector("[data-og-new-chat-composer]")).not.toBeNull();
      expect(view.container.querySelector("[data-og-chat-sidebar]")).not.toBeNull();
      const textarea = view.container.querySelector<HTMLTextAreaElement>(
        "[data-og-new-chat-composer] textarea",
      )!;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(textarea, "Draft the launch email");
      const key = Object.keys(textarea).find((name) => name.startsWith("__reactProps$"))!;
      await actRun(() =>
        (textarea as unknown as Record<string, { onChange: (event: unknown) => void }>)[
          key
        ]!.onChange({ target: textarea }),
      );
      await actRun(() => textarea.form!.requestSubmit());
      await flush(100);
      expect(calls).toContain("create:Draft the launch email");
      expect(changes).toEqual(["bbbbbbbb-0000-4000-8000-000000000002"]);
      expect(view.container.querySelector("[data-og-conversation]")).not.toBeNull();
      // The list refetched and shows the new chat.
      expect(view.container.textContent).toContain("Draft the launch email");

      // "New chat" returns to the composer; the drawer opens from the menu.
      await actRun(() =>
        view.container.querySelector<HTMLButtonElement>("[data-og-new-chat]")!.click(),
      );
      expect(changes.at(-1)).toBeNull();
      await actRun(() =>
        view.container.querySelector<HTMLButtonElement>("[data-og-chat-menu]")!.click(),
      );
      expect(view.container.querySelector("[data-og-chat-drawer]")).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });

  test("reports when the host has not enabled new chats", async () => {
    const { client } = listClient();
    Object.assign(client as object, {
      createSession: async () => {
        throw new Error("Not found.");
      },
    });
    const view = await renderComponent(
      <OpenGeniChat
        client={client}
        workspaceId={WORKSPACE_ID}
        createSession={async () => {
          throw new Error("custom create failed");
        }}
      />,
    );
    try {
      await flush(30);
      const textarea = view.container.querySelector<HTMLTextAreaElement>("textarea")!;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(textarea, "hi");
      const key = Object.keys(textarea).find((name) => name.startsWith("__reactProps$"))!;
      await actRun(() =>
        (textarea as unknown as Record<string, { onChange: (event: unknown) => void }>)[
          key
        ]!.onChange({ target: textarea }),
      );
      await actRun(() => textarea.form!.requestSubmit());
      await flush(30);
      expect(view.container.querySelector("[role='alert']")?.textContent).toBe(
        "The request could not be completed.",
      );
    } finally {
      await view.unmount();
    }
  });
});
