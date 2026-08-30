import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import type { AppRelease, WorkspaceApp, WorkspaceAppDetailResponse } from "@opengeni/sdk/apps";

import { releaseMutationKind } from "@/components/apps/app-management";
import { AppsRoute } from "@/routes/apps";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const APP_ID = "33333333-3333-4333-8333-333333333333";
const POLICY_ID = "44444444-4444-4444-8444-444444444444";
const BUILD_ID = "55555555-5555-4555-8555-555555555555";
const SOURCE_ID = "66666666-6666-4666-8666-666666666666";
const RELEASE_1_ID = "77777777-7777-4777-8777-777777777777";
const RELEASE_2_ID = "88888888-8888-4888-8888-888888888888";
const PREVIEW_ID = "99999999-9999-4999-8999-999999999999";
const SHA256 = "a".repeat(64);
const NOW = "2026-08-30T12:00:00.000Z";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => GlobalRegistrator.unregister());

function app(id: string, title: string, overrides: Partial<WorkspaceApp> = {}): WorkspaceApp {
  return {
    id,
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    slug: title.toLowerCase().replaceAll(" ", "-"),
    title,
    description: null,
    status: "active",
    version: 1,
    latestSourceRevisionId: null,
    latestBuildId: null,
    activeReleaseId: null,
    createdBySubjectId: "subject-1",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function release(id: string, revision: number): AppRelease {
  return {
    id,
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    appId: APP_ID,
    buildId: BUILD_ID,
    sourceRevisionId: SOURCE_ID,
    toolPolicyRevisionId: POLICY_ID,
    revision,
    status: "ready",
    manifestSha256: SHA256,
    entryPath: "index.html",
    fileCount: 2,
    totalBytes: 100,
    buildReceiptDigest: SHA256,
    createdBySubjectId: "subject-1",
    createdAt: NOW,
  };
}

function detail(status: WorkspaceApp["status"] = "active"): WorkspaceAppDetailResponse {
  return {
    app: app(APP_ID, "Status console", {
      status,
      version: 7,
      latestSourceRevisionId: SOURCE_ID,
      latestBuildId: BUILD_ID,
      activeReleaseId: RELEASE_2_ID,
    }),
    sourceRevisions: [],
    builds: [],
    releases: [release(RELEASE_1_ID, 1), release(RELEASE_2_ID, 2)],
    previews: [],
    toolPolicies: [
      {
        id: POLICY_ID,
        accountId: ACCOUNT_ID,
        workspaceId: WORKSPACE_ID,
        appId: APP_ID,
        revision: 1,
        catalogDigest: SHA256,
        allowedTools: [{ serverId: "status", toolName: "read" }],
        createdBySubjectId: "subject-1",
        createdAt: NOW,
      },
    ],
    historyTruncated: false,
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const route = createRootRoute({ component: () => node });
  const router = createRouter({
    routeTree: route,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  await act(async () => root.render(<RouterProvider router={router} />));
  await settle();
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function setInputValue(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set?.call(
      element,
      value,
    );
    const reactPropsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
    const onChange = reactPropsKey
      ? (
          element as unknown as Record<
            string,
            { onChange?: (event: { target: HTMLInputElement }) => void }
          >
        )[reactPropsKey]?.onChange
      : undefined;
    if (onChange) onChange({ target: element });
    else element.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!result) throw new Error(`Missing button ${label}.`);
  return result;
}

describe("Apps management product surface", () => {
  test("paginates the inventory and inserts a newly created draft", async () => {
    const first = app(APP_ID, "First app");
    const second = app("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Second app");
    const created = app("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "New status app");
    const listApps = mock(
      async (_workspaceId: string, query: { limit?: number; cursor?: string }) =>
        query.cursor
          ? { apps: [second], nextCursor: null, truncated: false }
          : { apps: [first], nextCursor: "page-2", truncated: true },
    );
    const createApp = mock(
      async (_workspaceId: string, _request: { title: string; idempotencyKey: string }) => ({
        app: created,
        replayed: false,
      }),
    );
    const rendered = await render(
      <AppsRoute workspaceId={WORKSPACE_ID} client={{ listApps, createApp } as never} />,
    );

    try {
      expect(rendered.container.textContent).toContain("First app");
      expect(rendered.container.textContent).not.toContain("Second app");

      await act(async () => button(rendered.container, "Load more apps").click());
      await settle();
      expect(rendered.container.textContent).toContain("Second app");
      expect(listApps.mock.calls.map((call) => call[1])).toEqual([
        { limit: 50 },
        { limit: 50, cursor: "page-2" },
      ]);

      await act(async () => button(rendered.container, "New app").click());
      const title = rendered.container.querySelector<HTMLInputElement>('input[name="app-title"]');
      expect(title).not.toBeNull();
      await setInputValue(title!, "New status app");
      await act(async () => button(rendered.container, "Create app").click());
      await settle();

      expect(rendered.container.textContent).toContain("New status app");
      expect(createApp).toHaveBeenCalledTimes(1);
      expect(createApp.mock.calls[0]?.[1]).toMatchObject({
        title: "New status app",
      });
      expect(createApp.mock.calls[0]?.[1].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/u);
    } finally {
      await rendered.unmount();
    }
  });

  test("loads current-human tool choices and previews or rolls back frozen releases", async () => {
    const current = detail();
    const getApp = mock(async () => current);
    const getAvailableRuntimeCatalog = mock(async () => ({
      appId: APP_ID,
      catalogDigest: SHA256,
      tools: [
        {
          identity: { serverId: "status", toolName: "read" },
          modelName: "status_read",
          programmaticPath: ["status", "read"],
          title: "Read status",
          description: "Read the current service status.",
          inputSchema: { type: "object" },
          source: "opengeni",
          effect: "read",
          replaySafety: "safe",
          openWorld: false,
          approval: "none",
          supportedSurfaces: ["app"],
          requiredPermissions: [],
        },
      ],
    }));
    const createPreview = mock(async () => ({
      preview: {
        id: PREVIEW_ID,
        accountId: ACCOUNT_ID,
        workspaceId: WORKSPACE_ID,
        appId: APP_ID,
        releaseId: RELEASE_1_ID,
        status: "active" as const,
        createdBySubjectId: "subject-1",
        createdAt: NOW,
        expiresAt: "2026-08-30T13:00:00.000Z",
        revokedAt: null,
      },
      url: "https://preview.example.test/release-1",
      replayed: false,
    }));
    const rollback = mock(
      async (
        _workspaceId: string,
        _appId: string,
        _request: {
          releaseId: string;
          expectedAppVersion: number;
          reason: string;
        },
      ) => ({
        app: current.app,
        release: current.releases[0]!,
        replayed: false,
      }),
    );
    const rendered = await render(
      <AppsRoute
        workspaceId={WORKSPACE_ID}
        appId={APP_ID}
        client={
          {
            getApp,
            getAvailableRuntimeCatalog,
            createPreview,
            rollback,
          } as never
        }
      />,
    );

    try {
      expect(rendered.container.textContent).toContain("Immutable builds");
      expect(rendered.container.textContent).toContain("Release 2");
      expect(rendered.container.textContent).toContain("Release 1");

      const toolDisclosure = [
        ...rendered.container.querySelectorAll<HTMLButtonElement>("button"),
      ].find((candidate) => candidate.textContent?.includes("Allowed tools"));
      expect(toolDisclosure).not.toBeUndefined();
      await act(async () => toolDisclosure!.click());
      await settle();
      expect(getAvailableRuntimeCatalog).toHaveBeenCalledTimes(1);
      const checkbox = rendered.container.querySelector<HTMLInputElement>('input[type="checkbox"]');
      expect(checkbox?.checked).toBeTrue();
      expect(rendered.container.textContent).toContain("Read the current service status");

      await act(async () =>
        rendered.container
          .querySelector<HTMLButtonElement>('button[aria-label="Create preview for release 1"]')!
          .click(),
      );
      await settle();
      expect(createPreview).toHaveBeenCalledTimes(1);
      expect(
        rendered.container.querySelector<HTMLAnchorElement>(
          'a[href="https://preview.example.test/release-1"]',
        )?.textContent,
      ).toContain("Open preview");

      await act(async () =>
        rendered.container
          .querySelector<HTMLButtonElement>('button[aria-label="Roll back to release 1"]')!
          .click(),
      );
      await settle();
      expect(rollback).toHaveBeenCalledTimes(1);
      expect(rollback.mock.calls[0]?.[2]).toMatchObject({
        releaseId: RELEASE_1_ID,
        expectedAppVersion: 7,
      });
      expect(rollback.mock.calls[0]?.[2].reason).toContain("Roll back to release 1");
    } finally {
      await rendered.unmount();
    }
  });

  test("chooses rollback only for an older release than the active one", () => {
    const current = detail();
    expect(releaseMutationKind(current, current.releases[0]!)).toBe("rollback");
    expect(releaseMutationKind(current, current.releases[1]!)).toBe("publish");
  });

  test("does not offer launch or mutation forms for an archived app", async () => {
    const rendered = await render(
      <AppsRoute
        workspaceId={WORKSPACE_ID}
        appId={APP_ID}
        client={{ getApp: async () => detail("archived") } as never}
      />,
    );
    try {
      expect(rendered.container.textContent).not.toContain("Run app");
      expect(rendered.container.querySelector('form[aria-label="Edit Status console"]')).toBeNull();
      expect(rendered.container.textContent).toContain("This app is archived");
    } finally {
      await rendered.unmount();
    }
  });
});
