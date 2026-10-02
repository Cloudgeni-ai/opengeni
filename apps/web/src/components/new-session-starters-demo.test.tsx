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
const { NewSessionStarters, PLAYGROUND_STARTER } = await import("./new-session-starters");

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

test("in a workspace, the starters also offer the recorded playground demo", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<NewSessionStarters workspaceId="ws-1" onSelect={() => undefined} />),
    );
    const demo = container.querySelector<HTMLAnchorElement>('a[data-starter="playground"]');
    expect(demo?.getAttribute("href")).toBe("/workspaces/ws-1/playground");
    expect(demo?.textContent).toContain(PLAYGROUND_STARTER.title);
    expect(container.querySelectorAll("button")).toHaveLength(6);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
