import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

mock.module("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    ...rest
  }: { children: ReactNode; to: string; params?: Record<string, string> } & Record<
    string,
    unknown
  >) => (
    <a href={to.replace("$workspaceId", params?.workspaceId ?? "")} {...rest}>
      {children}
    </a>
  ),
}));
const { ADD_AGENT_DEFAULT_PROMPT, NewSessionStarters, PLAYGROUND_STARTER } =
  await import("./new-session-starters");

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

async function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const titles = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("button, a")).map(
    (element) => element.querySelector("span span")?.textContent,
  );

test("a product gets its own agent and the demo first, then four general starters: six in all", async () => {
  const onSelect = mock((_prompt: string) => undefined);
  const { container, unmount } = await render(
    <NewSessionStarters
      set="product"
      workspaceId="ws-1"
      productPrompt="I want to add an AI agent to my product with Opengeni. - Website: acme.com"
      onSelect={onSelect}
    />,
  );
  try {
    expect(titles(container)).toEqual([
      "Add an agent to my product",
      PLAYGROUND_STARTER.title,
      "Connect GitHub and start a fix",
      "Turn an idea into a first version",
      "Research a decision",
      "Schedule a morning brief",
    ]);
    const demo = container.querySelector<HTMLAnchorElement>('a[data-starter="playground"]');
    expect(demo?.getAttribute("href")).toBe("/workspaces/ws-1/playground");
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-starter="add-agent"]')!.click(),
    );
    expect(onSelect).toHaveBeenLastCalledWith(
      "I want to add an AI agent to my product with Opengeni. - Website: acme.com",
    );
  } finally {
    await unmount();
  }
  // Without saved answers, the agent asks about the product first.
  const fallback = await render(
    <NewSessionStarters set="product" workspaceId="ws-1" onSelect={onSelect} />,
  );
  try {
    await act(async () =>
      fallback.container.querySelector<HTMLButtonElement>('[data-starter="add-agent"]')!.click(),
    );
    expect(onSelect).toHaveBeenLastCalledWith(ADD_AGENT_DEFAULT_PROMPT);
  } finally {
    await fallback.unmount();
  }
});

test("own work, Skip and no answer get the general six, with no demo", async () => {
  const { container, unmount } = await render(
    <NewSessionStarters workspaceId="ws-1" onSelect={() => undefined} />,
  );
  try {
    expect(container.querySelectorAll("button")).toHaveLength(6);
    expect(container.querySelector('[data-starter="playground"]')).toBeNull();
  } finally {
    await unmount();
  }
});
