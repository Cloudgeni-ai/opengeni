import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SessionShareLink, SessionShareLinkState } from "@opengeni/sdk";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

// The dialog chrome is Radix's; render its parts in place to read them.
mock.module("../../../ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

const { ShareChatDialog } = await import("./share-chat-dialog");

const workspaceId = "00000000-0000-4000-8000-000000000301";
const sessionId = "2f1c6a52-6b1e-4f43-9d55-1c0c2f7e8a11";

function link(overrides: Partial<SessionShareLink> = {}): SessionShareLink {
  return {
    shareId: "AbCdEfGhIjKlMnOpQrStUv",
    url: "https://app.example.test/share/AbCdEfGhIjKlMnOpQrStUv",
    workspaceId,
    sessionId,
    title: "Weekend plans",
    messageCount: 2,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  };
}

let state: SessionShareLinkState = { enabled: true, link: null };
const getSessionShareLink = mock(async () => state);
const createSessionShareLink = mock(async () => {
  state = { enabled: true, link: link() };
  return state.link!;
});
const revokeSessionShareLink = mock(async () => {
  state = { enabled: true, link: null };
  return { revoked: true };
});
const client = { getSessionShareLink, createSessionShareLink, revokeSessionShareLink };

beforeAll(() => {
  try {
    GlobalRegistrator.register();
  } catch {
    // Another test in this process already installed Happy DOM.
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined }).IS_REACT_ACT_ENVIRONMENT =
    true;
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  for (const fn of [getSessionShareLink, createSessionShareLink, revokeSessionShareLink]) {
    fn.mockClear();
  }
});

async function settle() {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

async function openDialog() {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <ShareChatDialog
        client={client}
        workspaceId={workspaceId}
        sessionId={sessionId}
        open
        onOpenChange={() => undefined}
      />,
    );
  });
  await settle();
}

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!found) throw new Error(`no ${name} button`);
  return found as HTMLButtonElement;
}

test("creating a link says who can read it, then shows the link to copy; stopping ends it", async () => {
  state = { enabled: true, link: null };
  await openDialog();
  expect(document.body.textContent).toContain("Share this chat");
  expect(document.body.textContent).toContain(
    "Anyone with the link can read the conversation up to now",
  );
  expect(document.body.textContent).toContain("Tool details and files aren't included.");

  await act(async () => button("Create link").click());
  await settle();
  expect(createSessionShareLink).toHaveBeenCalledWith(workspaceId, sessionId);
  expect(document.body.textContent).toContain("This chat is shared");
  const field = document.querySelector("input") as HTMLInputElement | null;
  expect(field?.value).toBe(link().url);
  expect(document.body.textContent).toContain(
    "New messages stay private until you update the link.",
  );

  await act(async () => button("Stop sharing").click());
  await settle();
  expect(revokeSessionShareLink).toHaveBeenCalledWith(workspaceId, sessionId);
  expect(document.body.textContent).toContain("Sharing stopped. The link doesn't open anymore.");
  expect(document.querySelector("input")).toBeNull();
});

test("an existing link opens straight to it, and Update link refreshes the same link", async () => {
  state = { enabled: true, link: link() };
  await openDialog();
  expect((document.querySelector("input") as HTMLInputElement).value).toBe(link().url);
  await act(async () => button("Update link").click());
  await settle();
  expect(createSessionShareLink).toHaveBeenCalledTimes(1);
  expect((document.querySelector("input") as HTMLInputElement).value).toBe(link().url);
});

test("links turned off say so and offer nothing to create", async () => {
  state = { enabled: false, link: null };
  await openDialog();
  expect(document.body.textContent).toContain("Share links are turned off on this server.");
  expect(() => button("Create link")).toThrow();
  expect(button("Close")).toBeTruthy();
});

test("a refusal shows the server's plain sentence", async () => {
  state = { enabled: true, link: null };
  createSessionShareLink.mockImplementationOnce(async () => {
    throw Object.assign(
      new Error(
        "Opengeni API 403: Only the person who started this chat can create or stop its share link. Nothing was changed.",
      ),
      { status: 403 },
    );
  });
  await openDialog();
  await act(async () => button("Create link").click());
  await settle();
  expect(document.body.textContent).toContain(
    "Only the person who started this chat can create or stop its share link.",
  );
  expect(document.body.textContent).not.toContain("Opengeni API 403");
});
