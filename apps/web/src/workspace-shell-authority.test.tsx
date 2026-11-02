import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";

import type { AppContextValue } from "@opengeni/react/app/app-context";
import { WorkspaceShellRouteContent } from "./routes/workspace";
import type { SlackUserLinkAccessRequest, Workspace } from "@opengeni/react/app/types";

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
    revalidatePrincipalAccess: () => undefined,
    preparePendingSlackLink: async (requestedWorkspaceId: string) => {
      calls.prepareSlack += 1;
      return (await input.prepareSlack?.(requestedWorkspaceId)) ?? null;
    },
    refreshWorkspace: async () => null,
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
  options: { routed?: boolean } = {},
): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const content = (
    <WorkspaceShellRouteContent
      workspaceId={workspaceId}
      context={context}
      navigate={async () => undefined}
      onAuthorizedShellMount={onAuthorizedShellMount}
    />
  );
  await act(async () => {
    if (options.routed) {
      // Panels with links need a router.
      const router = createRouter({
        routeTree: createRootRoute({ component: () => content }),
        history: createMemoryHistory({ initialEntries: ["/"] }),
      });
      root.render(<RouterProvider router={router} />);
    } else {
      root.render(content);
    }
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

  test("a link an organization member completed without the workspace says to go back to Slack", async () => {
    const { calls, context } = testContext({
      workspaces: [],
      slackWorkspaceId: workspaceId,
      prepareSlack: async () => ({
        id: "33333333-3333-4333-8333-333333333333",
        workspaceId,
        workspaceDisplayName: "Operations",
        subjectLabel: "Ada",
        status: "completed",
        version: 2,
        expiresAt: "2026-08-20T09:00:00.000Z",
        requestedAt: null,
        decidedAt: "2026-08-20T08:01:00.000Z",
        completedAt: "2026-08-20T08:01:00.000Z",
        createdAt: "2026-08-20T08:00:00.000Z",
        updatedAt: "2026-08-20T08:01:00.000Z",
      }),
    });
    let shellMounts = 0;
    const rendered = await renderShell(
      context,
      () => {
        shellMounts += 1;
      },
      { routed: true },
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(calls.prepareSlack).toBe(1);
    expect(rendered.container.textContent).toContain("Slack account linked");
    expect(rendered.container.textContent).toContain("You can go back to Slack.");
    expect(rendered.container.textContent).not.toContain("invalid or expired");
    expect(rendered.container.textContent).not.toContain("Request access");
    // Linking grants nothing: no workspace shell mounts.
    expect(shellMounts).toBe(0);
    expect(rendered.container.querySelector("main")).toBeNull();
    await act(async () => rendered.root.unmount());
  });

  test("an organization member confirms which Slack account to link before anything is linked", async () => {
    const request = {
      id: "33333333-3333-4333-8333-333333333333",
      workspaceId,
      workspaceDisplayName: "Operations",
      subjectLabel: "Ada",
      status: "prepared" as const,
      version: 1,
      expiresAt: "2026-08-20T09:00:00.000Z",
      requestedAt: null,
      decidedAt: null,
      completedAt: null,
      createdAt: "2026-08-20T08:00:00.000Z",
      updatedAt: "2026-08-20T08:00:00.000Z",
      organizationMemberLink: { slackAccountLabel: "@ada" },
    };
    const { context } = testContext({
      workspaces: [],
      slackWorkspaceId: workspaceId,
      prepareSlack: async () => request,
    });
    const linkCalls: unknown[] = [];
    Reflect.set(context, "client", {
      linkSlackUserAsOrganizationMember: async (...args: unknown[]) => {
        linkCalls.push(args);
        return {
          ...request,
          status: "completed",
          version: 2,
          completedAt: "2026-08-20T08:01:00.000Z",
          organizationMemberLink: null,
        };
      },
    });
    const rendered = await renderShell(context, () => undefined, { routed: true });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const text = rendered.container.textContent ?? "";
    expect(text).toContain("Link your Slack account");
    expect(text).toContain("Link @ada in Slack to your Opengeni account.");
    expect(text).not.toContain("Request access");
    expect(linkCalls).toHaveLength(0);
    const linkButton = [...rendered.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Link",
    );
    expect(linkButton).toBeDefined();
    await act(async () => {
      linkButton!.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(linkCalls).toEqual([
      [workspaceId, request.id, { expectedVersion: 1, idempotencyKey: expect.any(String) }],
    ]);
    expect(rendered.container.textContent).toContain("Slack account linked");
    await act(async () => rendered.root.unmount());
  });
});
