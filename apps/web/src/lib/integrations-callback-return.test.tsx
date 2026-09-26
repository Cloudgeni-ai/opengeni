import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";

import {
  ReplaceLocation,
  workspaceIntegrationsCallbackHref,
} from "@/lib/integrations-callback-return";

const workspaceId = "7c1f4c1e-2f0a-4a7b-9d55-0b6f7f1d2e3a";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe("integration callback forwarding", () => {
  test("a workspace-less callback lands on the Plugins page with its outcome", () => {
    expect(
      workspaceIntegrationsCallbackHref(
        workspaceId,
        "?integration_oauth=error&stage=state_verify&reason=state_expired",
      ),
    ).toBe(
      `/workspaces/${workspaceId}/plugins?integration_oauth=error&stage=state_verify&reason=state_expired`,
    );
  });

  test("keeps every flow's outcome parameters verbatim", () => {
    const href = workspaceIntegrationsCallbackHref(
      workspaceId,
      "?fiken=error&reason=provider_denied&github_personal_oauth=error&accountHandle=12345&api_integration_expected=3&social_oauth=error&connect_item=linear",
    );
    const params = new URL(href, "https://app.test").searchParams;
    expect(Object.fromEntries(params)).toEqual({
      reason: "provider_denied",
      connect_item: "linear",
      api_integration_expected: "3",
      social_oauth: "error",
      accountHandle: "12345",
      fiken: "error",
      github_personal_oauth: "error",
    });
  });

  test("drops bearer-shaped and unknown parameters instead of copying them", () => {
    const href = workspaceIntegrationsCallbackHref(
      workspaceId,
      `?integration_oauth=error&slack_link=secret-bearer&token=abc&reason=${"x".repeat(513)}`,
    );
    expect(href).toBe(`/workspaces/${workspaceId}/plugins?integration_oauth=error`);
  });

  test("Slack outcomes keep their sanitized reason", () => {
    const href = workspaceIntegrationsCallbackHref(
      workspaceId,
      "?integration=slack&slack=error&reason=<b>made-up</b>",
    );
    const params = new URL(href, "https://app.test").searchParams;
    expect(Object.fromEntries(params)).toEqual({
      integration: "slack",
      slack: "error",
      reason: "installation_failed",
    });
  });

  test("preserves the Skills section of a legacy capabilities link", () => {
    expect(workspaceIntegrationsCallbackHref(workspaceId, "", "skills")).toBe(
      `/workspaces/${workspaceId}/plugins?section=skills`,
    );
    expect(workspaceIntegrationsCallbackHref(workspaceId, "?section=skills")).toBe(
      `/workspaces/${workspaceId}/plugins?section=skills`,
    );
    expect(workspaceIntegrationsCallbackHref(workspaceId, "?section=admin")).toBe(
      `/workspaces/${workspaceId}/plugins`,
    );
  });

  test("replaces /integrations with the exact href, without re-encoding values", async () => {
    const target = workspaceIntegrationsCallbackHref(
      workspaceId,
      "?integration_oauth=error&reason=state_expired&accountHandle=12345&api_integration_expected=3",
    );
    const rootRoute = createRootRoute({ component: Outlet });
    const integrationsRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "integrations",
      component: () => <ReplaceLocation href={target} />,
    });
    const pluginsRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "workspaces/$workspaceId/plugins",
      component: () => <p>Plugins page</p>,
    });
    const history = createMemoryHistory({ initialEntries: ["/integrations?reason=x"] });
    const router = createRouter({
      routeTree: rootRoute.addChildren([integrationsRoute, pluginsRoute]),
      history,
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await router.load();
      await act(async () => {
        root.render(<RouterProvider router={router} />);
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(container.textContent).toContain("Plugins page");
      expect(`${history.location.pathname}${history.location.search}`).toBe(target);
      // Replace, not push: Back must not return to the forwarding URL.
      expect(history.length).toBe(1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
