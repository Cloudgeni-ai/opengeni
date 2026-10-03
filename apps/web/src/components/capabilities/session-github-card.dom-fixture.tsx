// Run explicitly through session-github-card.test.tsx so Radix sees the DOM at import time.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

import type { AuthNeededItem } from "@opengeni/react";

type Repo = {
  id: number;
  installationId: number;
  fullName: string;
  name: string;
  private: boolean;
  htmlUrl: string;
  cloneUrl: string;
  defaultBranch: string;
  accountLogin: string;
  accountType: string | null;
};
const repo = (id: number, fullName: string, installationId = 42, isPrivate = true): Repo => ({
  id,
  installationId,
  fullName,
  name: fullName.split("/")[1]!,
  private: isPrivate,
  htmlUrl: `https://github.com/${fullName}`,
  cloneUrl: `https://github.com/${fullName}.git`,
  defaultBranch: "main",
  accountLogin: fullName.split("/")[0]!,
  accountType: "Organization",
});
const installation = (installationId: number, accountLogin: string) => ({
  installationId,
  githubAccountId: installationId,
  accountLogin,
  accountType: "Organization",
  lifecycle: "active",
  repositoryScope: "selected",
  repositoryCount: 1,
  configureUrl: `https://api.example.test/github/installations/${installationId}/configure`,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});
const boundStatus = (linkUrl: string | null = "https://api.example.test/github/connect") => ({
  configured: true,
  status: "bound",
  setupMode: "platform",
  appId: null,
  clientId: null,
  appSlug: null,
  installUrl: linkUrl,
  linkUrl,
  installations: [installation(42, "acme")],
  missing: [],
});
const resourceFor = (repository: Repo) => ({
  kind: "repository" as const,
  uri: repository.cloneUrl,
  ref: repository.defaultBranch,
  provider: "github" as const,
  mountPath: `repos/github.com/${repository.fullName}`,
  githubRepositoryId: repository.id,
  githubInstallationId: repository.installationId,
});

let routing = "accepted_for_execution";
const sendMessage = mock(async (_workspaceId: string, _sessionId: string, _input: unknown) => ({
  id: "accepted",
  type: "user.message",
  payload: { routing },
}));
const getGitHubApp = mock(async (): Promise<unknown> => boundStatus());
const refreshGitHub = mock(async () => {});
const refreshPersonalGitHub = mock(async () => {});
const everyone = ["github:use", "github:manage", "sessions:control"];
const context = {
  client: { catalogAssetUrl: (path: string) => path, getGitHubApp, sendMessage },
  githubStatus: boundStatus() as unknown,
  githubRepos: [] as Repo[],
  githubCatalogReady: true,
  githubStatusFailed: false,
  repoBusy: false,
  personalGitHubBusy: false,
  refreshGitHub,
  refreshPersonalGitHub,
  captureWorkspaceInvocation: () => ({ revision: 1 }),
  accessContext: {
    subjectId: "member",
    workspaceGrants: [{ workspaceId: "workspace", permissions: everyone }],
  },
  workspaces: [{ id: "workspace", kind: "shared" }],
  workspaceCapabilityCatalog: [],
};
mock.module("@/context", () => ({ useAppContext: () => context }));
mock.module("sonner", () => ({ toast: { success: () => {}, error: () => {}, info: () => {} } }));
GlobalRegistrator.register();
const { createRoot } = await import("react-dom/client");
const { SessionCapabilityCard } = await import("./session-capability-card");

const notice = {
  id: "notice",
  kind: "auth-needed",
  serverId: "opengeni",
  providerDomain: "github.com",
  reason: "missing_connection",
  capability: {
    id: "api:github-app",
    name: "GitHub App",
    kind: "api",
    action: "connect",
    rationale: "Connect the product repository so I can open a pull request.",
    requiredVariables: [],
  },
} as unknown as AuthNeededItem;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});
beforeEach(() => {
  routing = "accepted_for_execution";
  sendMessage.mockClear();
  getGitHubApp.mockClear();
  refreshGitHub.mockClear();
  context.githubStatus = boundStatus();
  context.githubRepos = [];
  context.githubCatalogReady = true;
  context.githubStatusFailed = false;
  context.accessContext.workspaceGrants = [{ workspaceId: "workspace", permissions: everyone }];
  context.workspaces = [{ id: "workspace", kind: "shared" }];
});

async function render(resources: unknown[] = [], connectionAccounts?: () => unknown[]) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onConfigured = mock(async () => {});
  const draw = async (next: unknown[]) =>
    await act(async () =>
      root.render(
        <SessionCapabilityCard
          item={notice}
          workspaceId="workspace"
          sessionId="session"
          resources={next as never}
          connectionAccounts={connectionAccounts as never}
          onConfigured={onConfigured}
        />,
      ),
    );
  await draw(resources);
  return {
    container,
    onConfigured,
    rerender: draw,
    text: () => container.textContent ?? "",
    buttons: () => [...container.querySelectorAll("button")],
    byLabel: (label: string) =>
      container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`),
    close: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function click(element: HTMLElement | null) {
  if (!element) throw new Error("Missing element");
  await act(async () => {
    element.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("GitHub conversation card", () => {
  test("one repository is a single primary action that sends an ordinary human message", async () => {
    const api = repo(101, "acme/api");
    context.githubRepos = [api];
    const h = await render();
    try {
      expect(h.text()).toContain("Connected to this workspace");
      const use = h.byLabel("Use acme/api in this chat");
      expect(use?.textContent).toContain("Use in this chat");
      await click(use);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      const [workspaceId, sessionId, input] = sendMessage.mock.calls[0]!;
      expect([workspaceId, sessionId]).toEqual(["workspace", "session"]);
      const message = input as { text: string; clientEventId: string; resources: unknown[] };
      expect(message.text).toBe("Use acme/api");
      expect(message.clientEventId).toMatch(/^[0-9a-f-]{36}$/u);
      // Exactly the composer picker's repository resource; nothing else rides along.
      expect(message.resources).toEqual([resourceFor(api)]);
      expect(Object.keys(message).sort()).toEqual(["clientEventId", "resources", "text"]);
      expect(h.onConfigured).toHaveBeenCalledTimes(1);
      expect(h.text()).toContain("Using acme/api in this chat");
      expect(h.text()).toContain("In this chat");
      expect(h.byLabel("Use acme/api in this chat")).toBeNull();
    } finally {
      await h.close();
    }
  });

  test("the composer's connection-account choices ride along, read at click time", async () => {
    context.githubRepos = [repo(101, "acme/api")];
    let selections: unknown[] = [];
    const h = await render([], () => selections);
    try {
      selections = [{ serverId: "linear", connectionId: "00000000-0000-4000-8000-000000000002" }];
      await click(h.byLabel("Use acme/api in this chat"));
      const input = sendMessage.mock.calls[0]![2] as { connectionAccounts?: unknown[] };
      expect(input.connectionAccounts).toEqual(selections);
    } finally {
      await h.close();
    }
  });

  test("a stale card from an old turn recognises a repository the chat already uses", async () => {
    const api = repo(101, "acme/api");
    context.githubRepos = [api, repo(102, "acme/web")];
    const h = await render([resourceFor(api)]);
    try {
      expect(h.text()).toContain("Using acme/api in this chat");
      expect(h.byLabel("Use acme/api in this chat")).toBeNull();
      expect(h.byLabel("Use acme/web in this chat")).not.toBeNull();
      // With more than one repository, rows use the compact action.
      expect(h.byLabel("Use acme/web in this chat")?.textContent).toBe("Use");
    } finally {
      await h.close();
    }
  });

  test("a repository mounted as the member's own GitHub identity is already in the chat", async () => {
    context.githubRepos = [repo(101, "acme/api")];
    const personal = {
      kind: "repository",
      uri: "https://github.com/acme/api",
      ref: "main",
      provider: "github",
      mountPath: "repos/github.com/acme/api",
      connectionType: "github_personal",
      credentialBindingId: "00000000-0000-4000-8000-000000000001",
      repositoryId: "R_kgDO",
      access: "write",
    };
    const h = await render([personal]);
    try {
      expect(h.byLabel("Use acme/api in this chat")).toBeNull();
      expect(h.text()).toContain("In this chat");
    } finally {
      await h.close();
    }
  });

  test("a running chat queues the message and says when the agent will pick it up", async () => {
    routing = "queued_for_execution";
    context.githubRepos = [repo(101, "acme/api"), repo(102, "acme/web")];
    const h = await render();
    try {
      await click(h.byLabel("Use acme/web in this chat"));
      expect(h.text()).toContain("It picks up acme/web after its current step.");
      expect(h.text()).toContain("Using acme/web in this chat");
    } finally {
      await h.close();
    }
  });

  test("a failed attach explains itself and the retry reuses the idempotency key", async () => {
    context.githubRepos = [repo(101, "acme/api"), repo(102, "acme/web")];
    sendMessage.mockImplementationOnce(async () => {
      throw new Error("Session was cancelled");
    });
    const h = await render();
    try {
      await click(h.byLabel("Use acme/api in this chat"));
      expect(h.container.querySelector('[role="alert"]')?.textContent).toContain(
        "Couldn't add acme/api to this chat. Session was cancelled",
      );
      expect(h.onConfigured).not.toHaveBeenCalled();
      await click(h.byLabel("Use acme/api in this chat"));
      expect(sendMessage).toHaveBeenCalledTimes(2);
      const first = sendMessage.mock.calls[0]![2] as { clientEventId: string };
      const second = sendMessage.mock.calls[1]![2] as { clientEventId: string };
      expect(second.clientEventId).toBe(first.clientEventId);
      expect(h.text()).toContain("Using acme/api in this chat");
    } finally {
      await h.close();
    }
  });

  test("a second click while one attach is in flight sends nothing", async () => {
    context.githubRepos = [repo(101, "acme/api"), repo(102, "acme/web")];
    let release!: () => void;
    sendMessage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ id: "a", type: "user.message", payload: { routing } });
        }),
    );
    const h = await render();
    try {
      await click(h.byLabel("Use acme/api in this chat"));
      expect(h.byLabel("Adding acme/api")).not.toBeNull();
      expect(h.byLabel("Use acme/web in this chat")?.disabled).toBe(true);
      await click(h.byLabel("Use acme/web in this chat"));
      expect(sendMessage).toHaveBeenCalledTimes(1);
      await act(async () => release());
      expect(h.byLabel("Use acme/web in this chat")?.disabled).toBe(false);
    } finally {
      await h.close();
    }
  });

  test("zero shared repositories offer the GitHub repository choice to an admin only", async () => {
    const h = await render();
    try {
      expect(h.text()).toContain("No repositories shared yet");
      expect(
        h.buttons().some((node) => node.textContent?.includes("Choose repositories on GitHub")),
      ).toBe(true);
    } finally {
      await h.close();
    }
    context.githubStatus = boundStatus(null);
    const member = await render();
    try {
      expect(member.text()).toContain("Ask a workspace admin to choose some on GitHub.");
      expect(member.buttons()).toHaveLength(0);
    } finally {
      await member.close();
    }
  });

  test("many repositories offer search and reveal more in pages", async () => {
    context.githubRepos = Array.from({ length: 12 }, (_, index) =>
      repo(200 + index, `acme/service-${String(index).padStart(2, "0")}`),
    );
    const h = await render();
    try {
      const rows = () => h.container.querySelectorAll('[data-slot="github-repositories"] li');
      expect(rows()).toHaveLength(5);
      await click(h.buttons().find((node) => node.textContent === "Show 7 more")!);
      expect(rows()).toHaveLength(12);
      const search = h.container.querySelector<HTMLInputElement>(
        'input[aria-label="Search repositories"]',
      )!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          search,
          "service-07",
        );
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(rows()).toHaveLength(1);
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          search,
          "missing",
        );
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(h.text()).toContain("No repositories match “missing”.");
    } finally {
      await h.close();
    }
  });

  test("a second GitHub account is grouped and blocked once the chat uses another token", async () => {
    const api = repo(101, "acme/api");
    context.githubStatus = {
      ...boundStatus(),
      installations: [installation(42, "acme"), installation(77, "northwind")],
    };
    context.githubRepos = [api, repo(201, "northwind/notes", 77)];
    const h = await render([resourceFor(api)]);
    try {
      expect(h.text()).toContain(
        "This chat already uses acme's repositories. Start a new chat to use northwind's.",
      );
      expect(h.byLabel("Use northwind/notes in this chat")).toBeNull();
      expect(h.text()).toContain("Choose acme repositories");
      expect(h.text()).toContain("Choose northwind repositories");
    } finally {
      await h.close();
    }
  });

  test("a repository whose GitHub access was removed is shown, not silently dropped", async () => {
    context.githubRepos = [repo(102, "acme/web")];
    const h = await render([resourceFor(repo(101, "acme/api"))]);
    try {
      expect(h.text()).toContain("acme/api");
      expect(h.text()).toContain("GitHub no longer shares this repository with the workspace.");
      expect(h.text()).not.toContain("Using acme/api in this chat");
    } finally {
      await h.close();
    }
    // An unloaded catalog is unknown, never proof of removal.
    context.githubCatalogReady = false;
    const loading = await render([resourceFor(repo(101, "acme/api"))]);
    try {
      expect(loading.text()).not.toContain("no longer shares");
    } finally {
      await loading.close();
    }
  });

  test("a viewer who cannot message the chat sees the list without actions", async () => {
    context.githubRepos = [repo(101, "acme/api")];
    context.accessContext.workspaceGrants = [
      { workspaceId: "workspace", permissions: ["github:use"] },
    ];
    const h = await render();
    try {
      expect(h.byLabel("Use acme/api in this chat")).toBeNull();
      expect(h.text()).toContain(
        "Only people who can message this chat can add a repository to it.",
      );
    } finally {
      await h.close();
    }
  });

  test("an unconfigured deployment and a non-admin get an explanation, never a dead button", async () => {
    context.githubStatus = {
      ...boundStatus(),
      configured: false,
      status: "disabled",
      linkUrl: null,
    };
    const h = await render();
    try {
      expect(h.text()).toContain("GitHub isn't available on this deployment right now.");
      expect(h.buttons()).toHaveLength(0);
    } finally {
      await h.close();
    }
    context.githubStatus = { ...boundStatus(null), status: "unbound", installations: [] };
    const member = await render();
    try {
      expect(member.text()).toContain("Only workspace admins can connect GitHub.");
      expect(member.text()).toContain("This card updates when they do.");
      expect(member.buttons()).toHaveLength(0);
    } finally {
      await member.close();
    }
    context.githubStatus = null;
    context.accessContext.workspaceGrants = [
      { workspaceId: "workspace", permissions: ["sessions:control"] },
    ];
    const outsider = await render();
    try {
      expect(outsider.text()).toContain(
        "You don't have access to this workspace's GitHub connection.",
      );
      expect(outsider.buttons()).toHaveLength(0);
    } finally {
      await outsider.close();
    }
  });

  test("Personal workspaces say so and skip the shared-workspace note", async () => {
    context.workspaces = [{ id: "workspace", kind: "personal" }];
    context.githubRepos = [repo(101, "acme/api")];
    const h = await render();
    try {
      expect(h.text()).toContain("Connected to your Personal workspace");
      expect(h.text()).toContain("Using a repository adds it to this chat only.");
      expect(h.text()).not.toContain("Shared with everyone in this workspace");
    } finally {
      await h.close();
    }
  });

  test("returning to the tab refreshes GitHub so a connect from elsewhere shows up", async () => {
    context.githubStatus = { ...boundStatus(), status: "unbound", installations: [] };
    const h = await render();
    try {
      expect(h.text()).toContain("Connect GitHub App");
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(refreshGitHub).toHaveBeenCalledTimes(1);
      // Several cards or events in one burst share one refresh.
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(refreshGitHub).toHaveBeenCalledTimes(1);
      context.githubStatus = boundStatus();
      context.githubRepos = [repo(101, "acme/api")];
      await h.rerender([]);
      expect(h.text()).toContain("Connected to this workspace");
      expect(h.byLabel("Use acme/api in this chat")).not.toBeNull();
    } finally {
      await h.close();
    }
  });
});
