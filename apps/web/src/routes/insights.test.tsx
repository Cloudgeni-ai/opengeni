import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

const workspaceId = "22222222-2222-4222-8222-222222222222";
let canRead = true;

const requestJson = mock(async () => new Promise<never>(() => undefined));
const getWorkspaceInsights = mock(async () => new Promise<never>(() => undefined));
const getWorkspaceModelCatalog = mock(async () => ({ models: [] }));
const context = {
  workspaces: [
    { id: workspaceId, name: "Product", accountId: "33333333-3333-4333-8333-333333333333" },
  ],
  get accessContext() {
    return {
      workspaceGrants: [{ workspaceId, permissions: canRead ? ["workspace:admin"] : [] }],
    };
  },
  client: { requestJson, getWorkspaceInsights, getWorkspaceModelCatalog },
};
mock.module("@/context", () => ({ useAppContext: () => context }));
const navigate = mock(async (_options: unknown) => undefined);
const RouterPackage = await import("@tanstack/react-router");
mock.module("@tanstack/react-router", () => ({ ...RouterPackage, useNavigate: () => navigate }));

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  canRead = true;
  requestJson.mockClear();
  getWorkspaceInsights.mockClear();
  navigate.mockClear();
});

const { InsightsRoute, parseInsightsSearch } = await import("./insights");

async function renderRoute(props: Partial<Parameters<typeof InsightsRoute>[0]> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<InsightsRoute workspaceId={workspaceId} {...props} />);
  });
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("Insights route", () => {
  test("Usage loads the usage query; Activity loads the workspace snapshot", async () => {
    const usage = await renderRoute({ search: {} });
    try {
      expect(requestJson).toHaveBeenCalledTimes(1);
      expect(getWorkspaceInsights).not.toHaveBeenCalled();
      expect(usage.container.querySelector('[role="status"]')?.textContent).toBe(
        "Loading Insights",
      );
    } finally {
      await usage.unmount();
    }
    const activity = await renderRoute({ search: { view: "activity" } });
    try {
      expect(getWorkspaceInsights).toHaveBeenCalledTimes(1);
    } finally {
      await activity.unmount();
    }
  });

  test("shows a calm permission line without requesting usage", async () => {
    canRead = false;
    const rendered = await renderRoute();
    try {
      expect(rendered.container.textContent).toContain("Only workspace admins can see Insights");
      expect(requestJson).not.toHaveBeenCalled();
    } finally {
      await rendered.unmount();
    }
  });

  test("opened from Billing, the back link returns there", async () => {
    const rendered = await renderRoute({
      returnTo: { path: "/workspaces/w/organization?section=billing", label: "Billing" },
    });
    try {
      const back = Array.from(rendered.container.querySelectorAll("button")).find(
        (button) => button.textContent === "Billing",
      );
      await act(async () => back?.click());
      expect(navigate).toHaveBeenCalledWith({ href: "/workspaces/w/organization?section=billing" });
    } finally {
      await rendered.unmount();
    }
  });

  test("the URL selection keeps the tab and the dashboard keys", () => {
    expect(
      parseInsightsSearch({ view: "activity", range: "ytd", group: "person", bogus: "1" }),
    ).toEqual({ view: "activity", range: "ytd", group: "person" });
  });
});
