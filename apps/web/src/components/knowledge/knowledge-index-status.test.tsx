import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
} from "@tanstack/react-router";
import type { KnowledgeIndexStatus } from "@opengeni/sdk";

let canBuy = false;
mock.module("@/context", () => ({
  useAppContext: () => ({
    workspaces: [{ id: "workspace-a", accountId: "account-a" }],
    accessContext: {
      mode: "managed",
      accountGrants: [{ accountId: "account-a", permissions: canBuy ? ["billing:manage"] : [] }],
      workspaceGrants: [],
    },
  }),
}));
const { KnowledgeIndexNotice, KnowledgeSearchFallback } = await import("./knowledge-index-status");
beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

async function render(status: KnowledgeIndexStatus, billingManager: boolean) {
  canBuy = billingManager;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const route = createRootRoute({
    component: () => <KnowledgeIndexNotice status={status} workspaceId="workspace-a" />,
  });
  const billing = createRoute({
    getParentRoute: () => route,
    path: "/workspaces/$workspaceId/organization",
    component: () => null,
  });
  const router = createRouter({
    routeTree: route.addChildren([billing]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await act(async () => root.render(<RouterProvider router={router} />));
  return { container, root };
}

test("funding wait states saved content and offers top-up only to billing managers", async () => {
  for (const canManage of [false, true]) {
    const { container, root } = await render("awaiting_funding", canManage);
    try {
      const notice = container.querySelector('[role="status"]');
      expect(notice?.textContent).toContain("Saved · awaiting credits for indexing");
      expect(notice?.textContent).toContain("keyword search remain available");
      expect(notice?.textContent).toContain("resumes automatically");
      const link = container.querySelector<HTMLAnchorElement>("a");
      expect(Boolean(link)).toBe(canManage);
      if (canManage) expect(link?.getAttribute("href")).toContain("section=billing");
      else expect(notice?.textContent).toContain("billing manager");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  }
});

test("provider failures and queued work never ask for credits", async () => {
  for (const status of ["queued", "provider_failed", "indexed"] as const) {
    const { container, root } = await render(status, true);
    try {
      expect(container.querySelector('[role="status"]')).not.toBeNull();
      expect(container.querySelector("a")).toBeNull();
      expect(container.textContent).not.toContain("awaiting credits");
      if (status === "provider_failed")
        expect(container.textContent).toContain("adding credits will not fix");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  }
});

test("hybrid keyword fallback distinguishes funding, quota and provider issues", async () => {
  for (const [reason, expected] of [
    ["awaiting_funding", "needs credits"],
    ["quota", "quota reached"],
    ["provider_unavailable", "provider unavailable"],
  ] as const) {
    canBuy = true;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const route = createRootRoute({
      component: () => <KnowledgeSearchFallback reason={reason} workspaceId="workspace-a" />,
    });
    const billing = createRoute({
      getParentRoute: () => route,
      path: "/workspaces/$workspaceId/organization",
      component: () => null,
    });
    const router = createRouter({
      routeTree: route.addChildren([billing]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    try {
      await act(async () => root.render(<RouterProvider router={router} />));
      expect(container.querySelector('[role="status"]')?.textContent).toContain(expected);
      expect(Boolean(container.querySelector("a"))).toBe(reason === "awaiting_funding");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  }
});
