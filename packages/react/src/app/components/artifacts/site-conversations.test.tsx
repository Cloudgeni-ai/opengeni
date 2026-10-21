import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Session, SessionListResponse } from "@opengeni/sdk";

mock.module("../../app-context", () => ({ useAppContext: () => ({}) }));
mock.module("../../lib/navigation", () => ({ useNavigate: () => () => undefined }));
const success = mock(
  (_message: string, _options?: { action?: { onClick: () => void } | undefined }) => undefined,
);
const failure = mock(() => undefined);
mock.module("sonner", () => ({ toast: { success, error: failure } }));
let module: typeof import("./site-conversations");
let ownsDom = false;
beforeAll(async () => {
  ownsDom = !GlobalRegistrator.isRegistered;
  if (ownsDom) GlobalRegistrator.register({ url: "https://example.test" });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  module = await import("./site-conversations");
});
afterAll(async () => {
  if (ownsDom) await GlobalRegistrator.unregister();
});

const chat = (id: string, owned = true) =>
  ({
    id,
    title: `Chat ${id}`,
    titleSource: "user",
    status: "idle",
    effectiveControl: { state: "running", override: null },
    metadata: {},
    tenancy: { ownedByCurrentUser: owned },
    initialMessage: "",
  }) as unknown as Session;
const page = (sessions: Session[]): SessionListResponse => ({
  pinned: [],
  sessions,
  nextCursor: null,
});
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
const click = async (element: Element | undefined) => {
  expect(element).toBeDefined();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
};

test("owner can choose an existing chat, then revoke access without changing the chat", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let allowed: string[] = [];
  const changes: Array<[string, boolean]> = [];
  const client = {
    listSessionPage: async (
      _ws: string,
      options: { siteAccessId?: string; includePinned?: boolean },
    ) => ({
      ...page(options.siteAccessId ? [] : [chat("someone-else", false)]),
      pinned:
        options.includePinned === false
          ? []
          : (options.siteAccessId ? allowed : ["mine"]).map((id) => ({
              ...chat(id),
              parentSessionId: "parent",
            })),
    }),
    listSiteSessionAccess: async () => ({ sessionIds: [...allowed] }),
    setSiteSessionAccess: async (
      _ws: string,
      siteId: string,
      sessionId: string,
      allow: boolean,
    ) => {
      changes.push([sessionId, allow]);
      allowed = allow ? [sessionId] : [];
      return { siteId, sessionId, allowed: allow };
    },
  };
  const button = (text: string) =>
    [...container.querySelectorAll("button")].find((node) => node.textContent === text);
  try {
    await act(async () =>
      root.render(
        <module.SiteConversationsPanel
          client={client}
          workspaceId="ws"
          siteId="site"
          title="Dashboard"
          canManageAccess
        />,
      ),
    );
    await flush();
    await click(button("Allow an existing chat"));
    expect(container.textContent).toContain("send messages as you");
    expect(container.textContent).toContain("Chat mine");
    expect(container.textContent).not.toContain("Chat someone-else");
    await click(button("Allow chat"));
    expect(changes).toEqual([["mine", true]]);
    expect(button("Allowed")?.disabled).toBe(true);
    await click(button("Back to Site conversations"));
    await click(button("Remove access"));
    expect(changes).toEqual([
      ["mine", true],
      ["mine", false],
    ]);
    expect(container.textContent).toContain("No conversations yet");
    expect(success).toHaveBeenCalled();
    const undo = success.mock.calls.at(-1)?.[1]?.action?.onClick;
    expect(undo).toBeDefined();
    await act(async () => undo!());
    await flush();
    expect(changes.at(-1)).toEqual(["mine", true]);
    expect(container.textContent).toContain("Chat mine");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("non-owner UI has no grant control and failed mutations retain the selectable chat", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = {
    listSessionPage: async () => page([chat("mine")]),
    listSiteSessionAccess: async () => ({ sessionIds: [] }),
    setSiteSessionAccess: async () => {
      throw new Error("Connection lost");
    },
  };
  try {
    await act(async () =>
      root.render(
        <module.SiteConversationsPanel
          client={client}
          workspaceId="ws"
          siteId="site"
          title="Dashboard"
        />,
      ),
    );
    await flush();
    expect(container.textContent).not.toContain("Allow an existing chat");
    await act(async () =>
      root.render(
        <module.SiteConversationsPanel
          client={client}
          workspaceId="ws"
          siteId="site"
          title="Dashboard"
          canManageAccess
        />,
      ),
    );
    await flush();
    await click(
      [...container.querySelectorAll("button")].find(
        (node) => node.textContent === "Allow an existing chat",
      ),
    );
    await click(
      [...container.querySelectorAll("button")].find((node) => node.textContent === "Allow chat"),
    );
    expect(failure).toHaveBeenCalled();
    expect(container.textContent).toContain("Chat mine");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
