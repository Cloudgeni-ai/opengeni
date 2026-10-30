import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";

import { actRun, registerDom, renderComponent } from "../../../../packages/react/test/render-hook";

registerDom();

const repository = {
  id: 101,
  installationId: 42,
  fullName: "acme/grocery-bot",
  name: "grocery-bot",
  private: true,
  htmlUrl: "https://github.com/acme/grocery-bot",
  cloneUrl: "https://github.com/acme/grocery-bot.git",
  defaultBranch: "main",
  accountLogin: "acme",
  accountType: "Organization",
};
const mounted = {
  kind: "repository",
  uri: "https://github.com/acme/grocery-bot.git",
  ref: "main",
  provider: "github",
  mountPath: "repos/github.com/acme/grocery-bot",
  githubRepositoryId: 101,
  githubInstallationId: 42,
};

type Status = {
  isRepo: boolean;
  head: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: unknown[];
  revision: number;
};
const cleanStatus: Status = {
  isRepo: true,
  head: "main",
  detached: false,
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  files: [],
  revision: 1,
};

let gitStatus: (path: string) => Promise<Status> = async () => cleanStatus;
const gitStatusCalls: unknown[] = [];
const removeCalls: unknown[] = [];
let sessionUpdates: unknown[] = [];

const context = {
  accessContext: {
    mode: "local",
    subjectId: "user:a",
    accountGrants: [],
    defaultAccountId: null,
    defaultWorkspaceId: null,
    workspaceGrants: [
      {
        workspaceId: "workspace-1",
        accountId: "account-1",
        subjectId: "user:a",
        permissions: ["github:use", "sessions:control"],
      },
    ],
  },
  client: {
    gitStatus: async (_workspaceId: string, _sessionId: string, request: { path: string }) => {
      gitStatusCalls.push(request);
      return await gitStatus(request.path);
    },
    removeSessionResources: async (workspaceId: string, sessionId: string, request: unknown) => {
      removeCalls.push({ workspaceId, sessionId, request });
      return {
        id: "session-1",
        workspaceId: "workspace-1",
        resources: [],
        removedRepositories: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            resource: mounted,
            removedAt: "2026-10-30T10:00:00.000Z",
            sandboxCleanupPending: true,
          },
        ],
      };
    },
  },
  setSession: (update: unknown) => sessionUpdates.push(update),
  captureWorkspaceInvocation: () => ({ workspaceId: "workspace-1", revision: 1 }),
  ownsWorkspaceInvocation: () => true,
  refreshGitHub: async () => {},
  refreshPersonalGitHub: async () => {},
  repoBusy: false,
  personalGitHubBusy: false,
  githubRepos: [repository],
  personalGitHubRepositories: [],
  personalGitHubSelection: null,
  githubStatus: {
    configured: true,
    status: "bound",
    setupMode: "operator",
    installUrl: null,
    linkUrl: null,
    installations: [
      {
        installationId: 42,
        accountLogin: "acme",
        lifecycle: "active",
        repositoryScope: "selected",
        repositoryCount: 1,
      },
    ],
  },
  githubCatalogReady: true,
  githubStatusFailed: false,
  clientConfig: { productAccessMode: "local" },
  personalGitHubStatus: null,
  repositoryGroups: [] as unknown[],
  githubAppOpen: false,
  githubOrg: "",
  busy: false,
  githubAppBusy: false,
};
mock.module("@opengeni/react/app/app-context", () => ({ useAppContext: () => context }));
const { groupRepositories } = await import("@opengeni/react/app/lib/session-tools");
context.repositoryGroups = groupRepositories([repository]);
const { useFollowUpRepositories, gitStatusHasUnsavedChanges } =
  await import("@opengeni/react/app/lib/use-follow-up-repositories");
const { RepositoryContextMenuBody } =
  await import("@opengeni/react/app/components/repository-picker");

let latest: ReturnType<typeof useFollowUpRepositories> | null = null;
function Harness(props: { session: unknown }) {
  const repositories = useFollowUpRepositories(props.session as never, () => {});
  latest = repositories;
  return createElement(
    "div",
    null,
    createElement(RepositoryContextMenuBody, repositories.pickerProps(false)),
    repositories.removalDialog,
  );
}

const session = (extra: Record<string, unknown> = {}) => ({
  id: "session-1",
  workspaceId: "workspace-1",
  resources: [mounted],
  ...extra,
});

function mountedSwitch(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    'button[role="switch"][aria-label="acme/grocery-bot mounted"]',
  );
}

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"]');
}

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  gitStatus = async () => cleanStatus;
  gitStatusCalls.length = 0;
  removeCalls.length = 0;
  sessionUpdates = [];
  latest = null;
});

describe("removing a mounted repository from a chat", () => {
  test("confirms with the plain copy, removes it, and stops showing it as mounted", async () => {
    const rendered = await renderComponent(createElement(Harness, { session: session() }));
    expect(mountedSwitch()?.getAttribute("aria-disabled")).toBeNull();
    await actRun(() => mountedSwitch()?.click());
    await settle();

    expect(gitStatusCalls).toEqual([{ path: "repos/github.com/acme/grocery-bot" }]);
    expect(dialog()?.textContent).toContain("Remove grocery-bot from this chat?");
    expect(dialog()?.textContent).toContain("The agent loses access and its folder is removed.");
    expect(dialog()?.textContent).not.toContain("unsaved changes");

    await actRun(() => button("Remove")?.click());
    await settle();

    expect(removeCalls).toEqual([
      {
        workspaceId: "workspace-1",
        sessionId: "session-1",
        request: { resources: [{ kind: "repository", uri: mounted.uri }] },
      },
    ]);
    expect(sessionUpdates).toHaveLength(1);
    expect(dialog()).toBeNull();
    // The row is now an ordinary, unselected catalog entry.
    expect(mountedSwitch()).toBeNull();
    const row = document.querySelector(
      'button[role="switch"][aria-label="Select acme/grocery-bot"]',
    );
    expect(row?.getAttribute("aria-checked")).toBe("false");
    expect(latest?.pendingResources).toEqual([]);
    await rendered.unmount();
  });

  test("warns when the folder has uncommitted changes", async () => {
    gitStatus = async () => ({
      ...cleanStatus,
      files: [{ path: "src/cart.ts", index: null, worktree: "M", isConflicted: false }],
    });
    const rendered = await renderComponent(createElement(Harness, { session: session() }));
    await actRun(() => mountedSwitch()?.click());
    await settle();
    expect(dialog()?.textContent).toContain(
      "The agent loses access and its folder is removed. It has unsaved changes.",
    );
    await actRun(() => button("Cancel")?.click());
    await settle();
    expect(removeCalls).toEqual([]);
    expect(mountedSwitch()?.getAttribute("aria-checked")).toBe("true");
    await rendered.unmount();
  });

  test("keeps Remove disabled until the check settles", async () => {
    let release: (status: Status) => void = () => {};
    gitStatus = () => new Promise<Status>((resolve) => (release = resolve));
    const rendered = await renderComponent(createElement(Harness, { session: session() }));
    await actRun(() => mountedSwitch()?.click());
    expect(button("Remove")?.disabled).toBe(true);
    await actRun(() => release({ ...cleanStatus, ahead: 2 }));
    await settle();
    expect(button("Remove")?.disabled).toBe(false);
    expect(dialog()?.textContent).toContain("It has unsaved changes.");
    await rendered.unmount();
  });

  test("a failed check says so and still lets the person remove it", async () => {
    gitStatus = async () => {
      throw new Error("sandbox offline");
    };
    const rendered = await renderComponent(createElement(Harness, { session: session() }));
    await actRun(() => mountedSwitch()?.click());
    await settle();
    expect(button("Remove")?.disabled).toBe(false);
    expect(dialog()?.textContent).toContain(
      "The agent loses access and its folder is removed. Couldn't check it for unsaved changes.",
    );
    await rendered.unmount();
  });

  test("on a Connected Machine it keeps the files and skips the check", async () => {
    const rendered = await renderComponent(
      createElement(Harness, { session: session({ sandboxBackend: "selfhosted" }) }),
    );
    await actRun(() => mountedSwitch()?.click());
    await settle();
    expect(gitStatusCalls).toEqual([]);
    expect(dialog()?.textContent).toContain(
      "The agent loses access. Files on your computer are left alone.",
    );
    expect(dialog()?.textContent).not.toContain("folder is removed");
    expect(button("Remove")?.disabled).toBe(false);
    await rendered.unmount();
  });

  test("without permission to control the chat, mounted repositories stay locked", async () => {
    const grant = context.accessContext.workspaceGrants[0]!;
    const previous = grant.permissions;
    grant.permissions = ["github:use"];
    try {
      const rendered = await renderComponent(createElement(Harness, { session: session() }));
      expect(mountedSwitch()?.getAttribute("aria-disabled")).toBe("true");
      await actRun(() => mountedSwitch()?.click());
      await settle();
      expect(dialog()).toBeNull();
      expect(gitStatusCalls).toEqual([]);
      await rendered.unmount();
    } finally {
      grant.permissions = previous;
    }
  });

  test("a repository removed elsewhere is not shown or resent from this tab", async () => {
    const rendered = await renderComponent(createElement(Harness, { session: session() }));
    // This tab sends a message that re-lists the mounted repository optimistically.
    await actRun(() => latest?.commitSent([mounted as never]));
    await rendered.rerender(
      createElement(Harness, {
        session: session({
          resources: [],
          removedRepositories: [
            {
              id: "22222222-2222-4222-8222-222222222222",
              resource: mounted,
              removedAt: "2026-10-30T10:05:00.000Z",
              sandboxCleanupPending: true,
            },
          ],
        }),
      }),
    );
    expect(mountedSwitch()).toBeNull();
    expect(latest?.pendingResources).toEqual([]);
    await rendered.unmount();
  });
});

describe("unsaved changes", () => {
  test("counts uncommitted files, unpushed commits and never-pushed branches", () => {
    expect(gitStatusHasUnsavedChanges(cleanStatus as never)).toBe(false);
    expect(gitStatusHasUnsavedChanges({ ...cleanStatus, ahead: 1 } as never)).toBe(true);
    expect(gitStatusHasUnsavedChanges({ ...cleanStatus, upstream: null } as never)).toBe(true);
    expect(
      gitStatusHasUnsavedChanges({
        ...cleanStatus,
        detached: true,
        head: null,
        upstream: null,
      } as never),
    ).toBe(false);
    expect(gitStatusHasUnsavedChanges({ ...cleanStatus, isRepo: false, ahead: 3 } as never)).toBe(
      false,
    );
  });
});
