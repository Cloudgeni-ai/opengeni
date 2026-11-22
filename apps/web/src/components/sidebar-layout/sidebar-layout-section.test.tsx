import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";

GlobalRegistrator.register({ url: "https://example.test" });
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const navigated: unknown[] = [];
const drawer: boolean[] = [];
mock.module("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
  useNavigate: () => (options: unknown) => {
    navigated.push(options);
  },
  useRouter: () => ({}),
  useRouterState: () => "/",
}));
mock.module("@opengeni/react/app/components/rail/rail-context", () => ({
  useRail: () => ({
    workspaceId: "workspace-1",
    setDrawerOpen: (open: boolean) => drawer.push(open),
  }),
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { CustomizeRow } = await import("./sidebar-layout-section");

afterAll(() => GlobalRegistrator.unregister());

test("the Customize row closes the drawer and opens the Sidebar page", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<CustomizeRow />));
  const row = container.querySelector("button")!;
  expect(row.textContent).toBe("Customize");
  // Quiet until hovered, but always reachable by keyboard and on touch screens.
  expect(row.className).toContain("opacity-0");
  expect(row.className).toContain("focus-visible:opacity-100");
  expect(row.className).toContain("pointer-coarse:opacity-100");
  await act(async () => row.click());
  expect(drawer).toEqual([false]);
  expect(navigated).toEqual([
    { to: "/workspaces/$workspaceId/sidebar", params: { workspaceId: "workspace-1" } },
  ]);
  await act(async () => root.unmount());
});
