import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useCallback, useState } from "react";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { createRoot, type Root } from "react-dom/client";

import type { AppContextValue } from "./context";
import { WorkspaceShellRouteContent } from "./routes/workspace";
import type { SlackUserLinkAccessRequest, Workspace } from "./types";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const subjectId = "user:ada";
const workspace: Workspace = {
  id: workspaceId,
  accountId,
  kind: "shared",
  name: "Operations",
  slug: null,
  externalSource: null,
  externalId: null,
  agentInstructions: null,
  settings: {},
  inferenceControl: {
    state: "active",
    revision: 0,
    reason: null,
    changedBy: null,
    changedAt: null,
  },
  defaultRigId: null,
  createdAt: "2026-08-20T08:00:00.000Z",
  updatedAt: "2026-08-20T08:00:00.000Z",
};

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function testContext(input: {
  workspaces: Workspace[];
  workspaceGrants?: AppContextValue["accessContext"]["workspaceGrants"];
  slackWorkspaceId?: string | null;
  stateOwnerWorkspaceId?: string | null;
  prepareSlack?: (workspaceId: string) => Promise<SlackUserLinkAccessRequest | null>;
}) {
  const calls = { github: 0, mcp: 0, reset: 0, prepareSlack: 0, transition: 0 };
  const context = {
    accessKeyVersion: 1,
    accessContext: {
      mode: "managed",
      subjectId,
      accountGrants: [],
      workspaceGrants: input.workspaceGrants ?? [],
      defaultAccountId: accountId,
      defaultWorkspaceId: null,
    },
    workspaces: input.workspaces,
    workspaceStateOwnerId: input.stateOwnerWorkspaceId ?? workspaceId,
    slackLinkContinuationWorkspaceId: input.slackWorkspaceId ?? null,
    client: {},
    captureWorkspaceInvocation: () => ({ workspaceId, revision: 1 }),
    ownsWorkspaceInvocation: () => true,
    clearSlackLinkContinuation: () => undefined,
    preparePendingSlackLink: async (requestedWorkspaceId: string) => {
      calls.prepareSlack += 1;
      return (await input.prepareSlack?.(requestedWorkspaceId)) ?? null;
    },
    refreshWorkspace: async () => null,
    refreshPersonalGitHub: async () => undefined,
    refreshGitHub: async () => {
      calls.github += 1;
    },
    refreshWorkspaceMcpServers: async () => {
      calls.mcp += 1;
    },
    resetWorkspaceIntegrations: () => {
      calls.reset += 1;
    },
    setSelectedRepoIds: () => undefined,
    setSelectedRepoRefs: () => undefined,
    prepareWorkspaceTransition: () => {
      calls.transition += 1;
    },
  } as unknown as AppContextValue;
  return { calls, context };
}

async function renderShell(
  context: AppContextValue,
  onAuthorizedShellMount: () => void,
): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <WorkspaceShellRouteContent
        workspaceId={workspaceId}
        context={context}
        navigate={async () => undefined}
        onAuthorizedShellMount={onAuthorizedShellMount}
      />,
    );
    await Promise.resolve();
  });
  return { container, root };
}

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => document.body.replaceChildren());
afterAll(() => GlobalRegistrator.unregister());

describe("workspace shell authority", () => {
  test("a server-listed workspace without the exact current grant mounts no shell or integrations", async () => {
    const { calls, context } = testContext({
      workspaces: [workspace],
      stateOwnerWorkspaceId: "44444444-4444-4444-8444-444444444444",
    });
    let shellMounts = 0;
    const rendered = await renderShell(context, () => {
      shellMounts += 1;
    });

    expect(rendered.container.textContent).toContain("Workspace unavailable");
    expect(calls).toEqual({
      github: 0,
      mcp: 0,
      reset: 0,
      prepareSlack: 0,
      transition: 0,
    });
    expect(shellMounts).toBe(0);
    expect(rendered.container.querySelector("main")).toBeNull();
    expect(rendered.container.querySelector("aside")).toBeNull();
    await act(async () => rendered.root.unmount());
  });

  test("an unlisted Slack continuation remains a narrow deferred access flow", async () => {
    const pending = deferred<SlackUserLinkAccessRequest | null>();
    const { calls, context } = testContext({
      workspaces: [],
      slackWorkspaceId: workspaceId,
      prepareSlack: () => pending.promise,
    });
    let shellMounts = 0;
    const rendered = await renderShell(context, () => {
      shellMounts += 1;
    });

    expect(calls.prepareSlack).toBe(1);
    expect(rendered.container.textContent).toContain("Checking Slack access");
    expect(shellMounts).toBe(0);
    expect(rendered.container.querySelector("main")).toBeNull();
    expect(
      rendered.container.querySelector('section[aria-label="Slack workspace access"]'),
    ).not.toBeNull();

    await act(async () => {
      pending.resolve({
        id: "33333333-3333-4333-8333-333333333333",
        workspaceId,
        workspaceDisplayName: "Operations",
        subjectLabel: "Ada",
        status: "prepared",
        version: 1,
        expiresAt: "2026-08-20T09:00:00.000Z",
        requestedAt: null,
        decidedAt: null,
        completedAt: null,
        createdAt: "2026-08-20T08:00:00.000Z",
        updatedAt: "2026-08-20T08:00:00.000Z",
      });
      await pending.promise;
      await Promise.resolve();
    });

    expect(rendered.container.textContent).toContain("Workspace access required");
    expect(rendered.container.textContent).toContain("Operations");
    expect(calls.github).toBe(0);
    expect(calls.mcp).toBe(0);
    expect(calls.reset).toBe(0);
    expect(shellMounts).toBe(0);
    expect(rendered.container.querySelector("main")).toBeNull();
    expect(rendered.container.querySelector("aside")).toBeNull();
    await act(async () => rendered.root.unmount());
  });

  for (const transition of ["dismiss", "principal", "access refresh"] as const) {
    test(`completed Slack linking survives its own access refresh, then clears on ${transition}`, async () => {
      const pending = deferred<SlackUserLinkAccessRequest | null>();
      const { context: initial } = testContext({
        workspaces: [workspace],
        workspaceGrants: [
          { accountId, workspaceId, subjectId, permissions: ["sessions:read"] },
        ] as AppContextValue["accessContext"]["workspaceGrants"],
        slackWorkspaceId: workspaceId,
        prepareSlack: () => pending.promise,
      });
      let change!: (transition: "principal" | "access refresh") => void;
      function Harness() {
        const [context, setContext] = useState(initial);
        const clear = useCallback(
          () => setContext((current) => ({ ...current, slackLinkContinuationWorkspaceId: null })),
          [],
        );
        const revalidate = useCallback(
          () =>
            setContext((current) => ({
              ...current,
              accessKeyVersion: current.accessKeyVersion + 1,
            })),
          [],
        );
        change = (kind) =>
          setContext((current) => ({
            ...current,
            accessKeyVersion: current.accessKeyVersion + 1,
            ...(kind === "principal"
              ? {
                  accessContext: {
                    ...current.accessContext,
                    subjectId: "user:bea",
                    workspaceGrants: [],
                  },
                }
              : {}),
          }));
        return (
          <WorkspaceShellRouteContent
            workspaceId={workspaceId}
            context={{
              ...context,
              clearSlackLinkContinuation: clear,
              revalidatePrincipalAccess: revalidate,
            }}
            navigate={async () => undefined}
          />
        );
      }
      const rootRoute = createRootRoute({ component: Outlet });
      const route = createRoute({
        getParentRoute: () => rootRoute,
        path: `/workspaces/${workspaceId}/organization`,
        component: Harness,
      });
      const router = createRouter({
        routeTree: rootRoute.addChildren([route]),
        history: createMemoryHistory({
          initialEntries: [`/workspaces/${workspaceId}/organization`],
        }),
      });
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      try {
        await router.load();
        await act(async () => root.render(<RouterProvider router={router} />));
        await act(async () => {
          pending.resolve({
            id: "33333333-3333-4333-8333-333333333333",
            workspaceId,
            workspaceDisplayName: "Operations",
            subjectLabel: "Ada",
            status: "completed",
            version: 2,
            expiresAt: "2026-08-20T09:00:00.000Z",
            requestedAt: null,
            decidedAt: null,
            completedAt: "2026-08-20T08:00:00.000Z",
            createdAt: "2026-08-20T08:00:00.000Z",
            updatedAt: "2026-08-20T08:00:00.000Z",
          });
          await pending.promise;
        });
        expect(container.textContent).toContain("Your Slack identity is linked");
        expect(container.textContent).toContain("check your bot DMs");
        await act(async () => {
          if (transition === "dismiss") {
            const dismiss = [...container.querySelectorAll("button")].find(
              (button) => button.textContent === "Dismiss",
            );
            expect(dismiss).toBeDefined();
            dismiss!.click();
          } else change(transition);
        });
        expect(container.textContent).not.toContain("Your Slack identity is linked");
      } finally {
        await act(async () => root.unmount());
        container.remove();
      }
    });
  }
});
