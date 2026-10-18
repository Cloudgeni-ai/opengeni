import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { AppContextValue } from "./context";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const context = {
  accessKeyVersion: 1,
  accessContext: {
    mode: "local",
    subjectId: "test-user",
    accountGrants: [],
    workspaceGrants: [{ workspaceId, accountId, subjectId: "test-user" }],
  },
  workspaces: [{ id: workspaceId, accountId, name: "Sample workspace" }],
  workspaceStateOwnerId: workspaceId,
  client: {},
  resetWorkspaceIntegrations() {},
  setSelectedRepoIds() {},
  setSelectedRepoRefs() {},
  refreshGitHub: async () => {},
  refreshPersonalGitHub: async () => {},
  refreshWorkspaceMcpServers: async () => {},
} as unknown as AppContextValue;

// Keep the actual router, workspace branch and RailProvider/useRail. Only the
// service subscriptions and unrelated shell contents are replaced.
mock.module("@/context", () => ({ useAppContext: () => context }));
mock.module("@opengeni/react", () => ({
  OpenGeniProvider: ({ children }: { children: ReactNode }) => children,
  SecretsUiProvider: ({ children }: { children: ReactNode }) => children,
  useOpenGeni: () => ({ workspaceControlConnectionState: "connected" }),
}));
mock.module("@/components/desktop/this-computer", () => ({
  DesktopThisComputerProvider: ({ children }: { children: ReactNode }) => children,
}));
mock.module("@/lib/stream-health", () => ({ useStreamHealthTelemetry() {} }));
mock.module("@/lib/secrets-ui", () => ({ webSecretsUi: {} }));
mock.module("@/components/rail/rail-shell", () => ({
  RailShell: ({ children }: { children: ReactNode }) => <div data-shell="sessions">{children}</div>,
}));
mock.module("@/components/settings/workspace-settings-shell", () => ({
  WorkspaceManagementShell: ({ children }: { children: ReactNode }) => (
    <div data-shell="settings">{children}</div>
  ),
}));

const { WorkspaceShellRoute } = await import("./routes/workspace");
const { useRail } = await import("./components/rail/rail-context");

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

test.each(["settings", "organization", "machines", "insights", "rigs/sample"])(
  "pending navigation between a session and %s keeps the rendered page's shell",
  async (destination) => {
    let finishLoading!: () => void;
    const loading = new Promise<void>((resolve) => {
      finishLoading = resolve;
    });
    const errors: string[] = [];
    const rootRoute = createRootRoute({
      component: Outlet,
      errorComponent: ({ error }) => <p>Route error: {error.message}</p>,
      onCatch: (error) => {
        errors.push(error.message);
      },
    });
    const workspaceRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/workspaces/$workspaceId",
      component: () => <WorkspaceShellRoute workspaceId={workspaceId} />,
    });
    let holdSession = false;
    let finishSession!: () => void;
    const sessionLoading = new Promise<void>((resolve) => {
      finishSession = resolve;
    });
    const session = createRoute({
      getParentRoute: () => workspaceRoute,
      path: "sessions/$sessionId",
      loader: () => (holdSession ? sessionLoading : undefined),
      component: () => <p>Session in {useRail().workspaceId}</p>,
    });
    const settings = createRoute({
      getParentRoute: () => workspaceRoute,
      path: destination,
      loader: () => loading,
      component: () => <p>Settings content</p>,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([workspaceRoute.addChildren([session, settings])]),
      history: createMemoryHistory({
        initialEntries: [`/workspaces/${workspaceId}/sessions/sample`],
      }),
      defaultPendingMs: 60_000,
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await router.load();
      await act(async () => {
        root.render(<RouterProvider router={router} />);
      });
      expect(container.textContent).toContain("Session in");
      let navigation!: Promise<void>;
      await act(async () => {
        navigation = router.navigate({ href: `/workspaces/${workspaceId}/${destination}` });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(router.state.location.pathname).toEndWith(`/${destination}`);
      expect(router.state.matches.at(-1)?.pathname).toEndWith("/sessions/sample");
      expect(errors).toEqual([]);
      expect(container.querySelector('[data-shell="sessions"]')?.textContent).toContain(
        "Session in",
      );
      await act(async () => {
        finishLoading();
        await navigation;
      });
      expect(container.querySelector('[data-shell="settings"]')?.textContent).toContain(
        "Settings content",
      );
      holdSession = true;
      await act(async () => {
        navigation = router.navigate({ href: `/workspaces/${workspaceId}/sessions/another` });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(router.state.location.pathname).toEndWith("/sessions/another");
      expect(router.state.matches.at(-1)?.pathname).toEndWith(`/${destination}`);
      expect(container.querySelector('[data-shell="settings"]')?.textContent).toContain(
        "Settings content",
      );
      await act(async () => {
        finishSession();
        await navigation;
      });
      expect(container.querySelector('[data-shell="sessions"]')?.textContent).toContain(
        "Session in",
      );
      expect(errors).toEqual([]);
    } finally {
      finishLoading();
      finishSession();
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  },
);
