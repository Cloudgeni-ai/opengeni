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

let archiveFails = false;
const sidebarStates: Array<[string, string, unknown]> = [];
const client: Record<string, unknown> = {
  updateSiteSidebarState: async (workspaceId: string, siteId: string, input: unknown) => {
    sidebarStates.push([workspaceId, siteId, input]);
    if (archiveFails) throw new Error("offline");
    return {};
  },
};
mock.module("@opengeni/react/app/app-context", () => ({ useAppContext: () => ({ client }) }));
type ToastOptions = { action?: { onClick: () => void } };
const toasts: Array<[string, string, ToastOptions | undefined]> = [];
mock.module("sonner", () => ({
  toast: {
    success: (title: string, options?: ToastOptions) => toasts.push(["success", title, options]),
    error: (title: string, options?: ToastOptions) => toasts.push(["error", title, options]),
  },
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { CustomizeRow, appsArchivedFromSidebar, useSidebarAppArchive } =
  await import("./sidebar-layout-section");

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

test("Archive on a sidebar app hides it from the sidebar, with Undo, and says when it fails", async () => {
  const reloads: number[] = [];
  let archive: ((appId: string, label: string) => void) | undefined;
  function Probe() {
    archive = useSidebarAppArchive("workspace-1", () => reloads.push(1));
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<Probe />));
  const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

  archive!("APP-1", "Feedback board");
  // Counted as still in the sidebar until the Apps section reads it archived.
  expect(appsArchivedFromSidebar.has("app-1")).toBe(true);
  await flush();
  expect(sidebarStates).toEqual([["workspace-1", "APP-1", { archived: true }]]);
  expect(reloads).toHaveLength(1);
  const [kind, title, options] = toasts.at(-1)!;
  expect([kind, title]).toEqual(["success", "App archived"]);

  // Undo restores it in place.
  options!.action!.onClick();
  await flush();
  expect(sidebarStates.at(-1)).toEqual(["workspace-1", "APP-1", { archived: false }]);
  expect(appsArchivedFromSidebar.has("app-1")).toBe(false);
  expect(reloads).toHaveLength(2);

  archiveFails = true;
  archive!("app-2", "Releases");
  await flush();
  expect(appsArchivedFromSidebar.has("app-2")).toBe(false);
  expect(toasts.at(-1)?.slice(0, 2)).toEqual(["error", "Couldn't archive Releases."]);
  await act(async () => root.unmount());
});

test("a client without sidebar state offers no Archive", async () => {
  const saved = client["updateSiteSidebarState"];
  delete client["updateSiteSidebarState"];
  let archive: unknown = "unset";
  function Probe() {
    archive = useSidebarAppArchive("workspace-1", () => {});
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  expect(archive).toBeUndefined();
  await act(async () => root.unmount());
  client["updateSiteSidebarState"] = saved;
});
