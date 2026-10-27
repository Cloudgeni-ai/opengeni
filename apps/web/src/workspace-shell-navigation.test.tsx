import "@/navigation-host";
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
import { AppContext, type AppContextValue } from "@opengeni/react/app/app-context";
import { useRail } from "@opengeni/react/app/components/rail/rail-context";

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

// Keep the actual router, workspace shell selection, RailProvider/useRail and
// action system. Only service subscriptions and the two shells' contents are
// replaced, so the test observes which shell wraps the rendered page.
const passthrough = ({ children }: { children: ReactNode }) => children;
const openGeni = await import("@opengeni/react");
mock.module("@opengeni/react", () => ({
  ...openGeni,
  OpenGeniProvider: passthrough,
  SecretsUiProvider: passthrough,
  useOpenGeni: () => ({ workspaceControlConnectionState: "connected" }),
}));
const thisComputer = await import("@opengeni/react/app/components/desktop/this-computer");
mock.module("@opengeni/react/app/components/desktop/this-computer", () => ({
  ...thisComputer,
  DesktopThisComputerProvider: passthrough,
}));
const appShots = await import("@opengeni/react/app/components/desktop/app-shots");
mock.module("@opengeni/react/app/components/desktop/app-shots", () => ({
  ...appShots,
  AppShotCoordinator: () => null,
}));
mock.module("@/components/meetings/recorder-provider", () => ({
  ConsoleMeetingRecorderProvider: passthrough,
}));
const streamHealth = await import("@opengeni/react/app/lib/stream-health");
mock.module("@opengeni/react/app/lib/stream-health", () => ({
  ...streamHealth,
  useStreamHealthTelemetry() {},
}));
mock.module("@/components/rail/rail-shell", () => ({
  RailShell: ({ children }: { children: ReactNode }) => <div data-shell="sessions">{children}</div>,
}));
mock.module("@/components/settings/workspace-settings-shell", () => ({
  WorkspaceManagementShell: ({ children }: { children: ReactNode }) => (
    <div data-shell="settings">{children}</div>
  ),
}));

const { WorkspaceShellRoute } = await import("./routes/workspace");

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

function shellText(container: HTMLElement, shell: "sessions" | "settings"): string {
  return container.querySelector(`[data-shell="${shell}"]`)?.textContent ?? "";
}

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
        root.render(
          <AppContext.Provider value={context}>
            <RouterProvider router={router} />
          </AppContext.Provider>,
        );
      });
      expect(shellText(container, "sessions")).toContain(`Session in ${workspaceId}`);

      // Session -> destination: the URL advances while the destination loader
      // is pending and Outlet still renders the session.
      let navigation!: Promise<void>;
      await act(async () => {
        navigation = router.navigate({ href: `/workspaces/${workspaceId}/${destination}` });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(router.state.location.pathname).toEndWith(`/${destination}`);
      expect(router.state.matches.at(-1)?.pathname).toEndWith("/sessions/sample");
      expect(errors).toEqual([]);
      expect(shellText(container, "sessions")).toContain("Session in");
      expect(shellText(container, "settings")).toBe("");
      await act(async () => {
        finishLoading();
        await navigation;
      });
      expect(shellText(container, "settings")).toContain("Settings content");
      expect(shellText(container, "sessions")).toBe("");

      // Destination -> session: the settings page stays in its own shell until
      // the session route is presented.
      holdSession = true;
      await act(async () => {
        navigation = router.navigate({ href: `/workspaces/${workspaceId}/sessions/another` });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(router.state.location.pathname).toEndWith("/sessions/another");
      expect(router.state.matches.at(-1)?.pathname).toEndWith(`/${destination}`);
      expect(shellText(container, "settings")).toContain("Settings content");
      expect(shellText(container, "sessions")).toBe("");
      await act(async () => {
        finishSession();
        await navigation;
      });
      expect(shellText(container, "sessions")).toContain("Session in");
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
