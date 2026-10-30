import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { OpenGeniClient, type GitHubActionPoliciesResponse } from "@opengeni/sdk";
import type { AccessContext, GitHubAppInfo } from "@opengeni/react/app/types";
import type {
  IntegrationChoiceOption,
  IntegrationViewModel,
} from "@opengeni/react/app/components/capabilities/integration-view-model";

const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_WORKSPACE_ID = "44444444-4444-4444-8444-444444444444";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";

const mutableContext: { current: Record<string, unknown> } = { current: {} };
mock.module("@opengeni/react/app/app-context", () => ({
  useAppContext: () => {
    const client = mutableContext.current.client as Record<string, unknown>;
    client.connectTransport ??= () =>
      new OpenGeniClient({
        baseUrl: "http://localhost:3000",
        fetch: async () => {
          throw new Error("Unexpected Connect request in GitHub policy test");
        },
      }).connectTransport();
    return mutableContext.current;
  },
}));

// The repository chooser is its own dialog; record what the adapter asks of it.
const personalDialog: { current: { open: boolean; loading?: boolean } | null } = { current: null };
mock.module("./personal-github-dialog", () => ({
  PersonalGitHubDialog: (props: { open: boolean; loading?: boolean }) => {
    personalDialog.current = props;
    return null;
  },
}));

const { useGitHubIntegration } = await import("./use-github-integration");
const { markPersonalGitHubRepositoryChooser } = await import("@/lib/personal-github-oauth");

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

function accessContext(permissions: string[]): AccessContext {
  return {
    mode: "managed",
    subjectId: "subject-a",
    accountGrants: [],
    workspaceGrants: [
      {
        workspaceId: WORKSPACE_ID,
        accountId: ACCOUNT_ID,
        subjectId: "subject-a",
        permissions,
      },
    ],
    defaultAccountId: ACCOUNT_ID,
    defaultWorkspaceId: WORKSPACE_ID,
  } as unknown as AccessContext;
}

function githubStatus(): GitHubAppInfo {
  const now = new Date().toISOString();
  return {
    configured: true,
    status: "bound",
    setupMode: "platform",
    appId: null,
    clientId: null,
    appSlug: null,
    installUrl: "https://api.example.test/github/connect",
    linkUrl: "https://api.example.test/github/connect",
    installations: [
      {
        installationId: 71,
        githubAccountId: 72,
        accountLogin: "Cloudgeni-ai",
        accountType: "Organization",
        lifecycle: "active",
        repositoryScope: "selected",
        repositoryCount: 1,
        configureUrl: "https://api.example.test/github/configure",
        createdAt: now,
        updatedAt: now,
      },
    ],
    missing: [],
  };
}

async function renderAdapter(context: Record<string, unknown>, initialWorkspaceId = WORKSPACE_ID) {
  mutableContext.current = context;
  let captured: IntegrationViewModel | null = null;
  function Probe({ workspaceId }: { workspaceId: string }) {
    const adapter = useGitHubIntegration({ workspaceId });
    captured = adapter.model;
    return adapter.dialogs;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Probe workspaceId={initialWorkspaceId} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    model: () => {
      if (!captured) throw new Error("GitHub adapter model was not captured");
      return captured;
    },
    rerender: async (workspaceId: string) => {
      await act(async () => {
        root.render(<Probe workspaceId={workspaceId} />);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function appContext(permissions: string[], update: ReturnType<typeof mock>) {
  return {
    accessContext: accessContext(permissions),
    githubStatus: githubStatus(),
    githubRepos: [],
    githubStatusFailed: false,
    githubCatalogReady: true,
    repoBusy: false,
    githubAppBusy: false,
    personalGitHubStatus: { enabled: false, connection: null, reviewUrl: null },
    personalGitHubSelection: null,
    personalGitHubBusy: false,
    client: {
      getGitHubActionPolicies: mock(async () => ({
        enabled: true,
        actors: [
          {
            kind: "workspace_app" as const,
            installationId: 71,
            label: "Opengeni bot on Cloudgeni-ai",
            groups: { routine: "ask" as const, review: "ask" as const, merge: "ask" as const },
          },
        ],
      })),
      updateGitHubActionPolicy: update,
    },
    disconnectGitHubInstallation: async () => true,
    startGitHubAppManifestFlow: async () => {},
    refreshGitHub: async () => {},
  };
}

function choice(model: IntegrationViewModel, suffix: string): IntegrationChoiceOption {
  const option = model.options.find(
    (candidate) => candidate.kind === "choice" && candidate.id.endsWith(suffix),
  );
  if (!option || option.kind !== "choice") throw new Error(`Missing policy option ${suffix}`);
  return option;
}

describe("GitHub action approval controls", () => {
  test("allows routine PR work without changing review or merge", async () => {
    const update = mock(async () => ({
      kind: "workspace_app" as const,
      installationId: 71,
      label: "Opengeni bot on Cloudgeni-ai",
      groups: { routine: "allow" as const, review: "ask" as const, merge: "ask" as const },
    }));
    const rendered = await renderAdapter(appContext(["github:manage"], update));
    try {
      expect(choice(rendered.model(), "-routine").value).toBe("ask");
      expect(choice(rendered.model(), "-merge").value).toBe("ask");
      await act(async () => {
        choice(rendered.model(), "-routine").onChange("allow");
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(update).toHaveBeenCalledWith(WORKSPACE_ID, {
        actor: { kind: "workspace_app", installationId: 71 },
        group: "routine",
        decision: "allow",
      });
      expect(choice(rendered.model(), "-routine").value).toBe("allow");
      expect(choice(rendered.model(), "-review").value).toBe("ask");
      expect(choice(rendered.model(), "-merge").value).toBe("ask");
    } finally {
      await rendered.unmount();
    }
  });

  test("ignores a saved actor from the previous workspace", async () => {
    const actor = {
      kind: "workspace_app" as const,
      installationId: 71,
      label: "Shared installation",
      groups: { routine: "block" as const, review: "block" as const, merge: "block" as const },
    };
    let resolveSave!: (value: typeof actor) => void;
    const pending = new Promise<typeof actor>((resolve) => {
      resolveSave = resolve;
    });
    const rendered = await renderAdapter(
      appContext(
        ["github:manage"],
        mock(() => pending),
      ),
    );
    try {
      await act(async () => {
        choice(rendered.model(), "-routine").onChange("block");
      });
      await rendered.rerender(OTHER_WORKSPACE_ID);
      await act(async () => {
        resolveSave(actor);
        await pending;
      });
      expect(choice(rendered.model(), "-routine").value).toBe("ask");
    } finally {
      await rendered.unmount();
    }
  });

  test("serializes actor snapshot saves even for same-frame changes to different groups", async () => {
    const actor = {
      kind: "workspace_app" as const,
      installationId: 71,
      label: "Shared installation",
      groups: { routine: "allow" as const, review: "ask" as const, merge: "ask" as const },
    };
    let resolveSave!: (value: typeof actor) => void;
    const pending = new Promise<typeof actor>((resolve) => {
      resolveSave = resolve;
    });
    const update = mock(() => pending);
    const rendered = await renderAdapter(appContext(["github:manage"], update));
    try {
      await act(async () => {
        choice(rendered.model(), "-routine").onChange("allow");
        choice(rendered.model(), "-merge").onChange("block");
      });
      expect(update).toHaveBeenCalledTimes(1);
      expect(choice(rendered.model(), "-merge").disabled).toBe(true);
      await act(async () => {
        resolveSave(actor);
        await pending;
      });
      expect(choice(rendered.model(), "-routine").value).toBe("allow");
      expect(choice(rendered.model(), "-merge").disabled).toBe(false);
      await act(async () => {
        choice(rendered.model(), "-merge").onChange("block");
        await pending;
      });
      expect(update).toHaveBeenCalledTimes(2);
    } finally {
      await rendered.unmount();
    }
  });

  test("shows the policy read-only without GitHub management authority", async () => {
    const rendered = await renderAdapter(
      appContext(
        ["github:use"],
        mock(async () => ({})),
      ),
    );
    try {
      expect(choice(rendered.model(), "-routine").disabled).toBe(true);
      expect(choice(rendered.model(), "-review").disabled).toBe(true);
      expect(choice(rendered.model(), "-merge").disabled).toBe(true);
    } finally {
      await rendered.unmount();
    }
  });

  test("ignores a stale policy response after switching workspaces", async () => {
    let resolveFirst: ((value: GitHubActionPoliciesResponse) => void) | null = null;
    const first = new Promise<GitHubActionPoliciesResponse>((resolve) => {
      resolveFirst = resolve;
    });
    const getPolicies = mock((workspaceId: string) =>
      workspaceId === WORKSPACE_ID
        ? first
        : Promise.resolve({
            enabled: true,
            actors: [
              {
                kind: "workspace_app" as const,
                installationId: 71,
                label: "Current workspace bot",
                groups: {
                  routine: "allow" as const,
                  review: "ask" as const,
                  merge: "ask" as const,
                },
              },
            ],
          }),
    );
    const context = appContext(
      ["github:manage"],
      mock(async () => ({})),
    );
    (context.client as { getGitHubActionPolicies: typeof getPolicies }).getGitHubActionPolicies =
      getPolicies;
    const rendered = await renderAdapter(context);
    try {
      await rendered.rerender(OTHER_WORKSPACE_ID);
      expect(choice(rendered.model(), "-routine").value).toBe("allow");

      await act(async () => {
        resolveFirst?.({
          enabled: true,
          actors: [
            {
              kind: "workspace_app",
              installationId: 71,
              label: "Previous workspace bot",
              groups: { routine: "block", review: "block", merge: "block" },
            },
          ],
        });
        await first;
      });

      expect(choice(rendered.model(), "-routine").value).toBe("allow");
    } finally {
      await rendered.unmount();
    }
  });
});

for (const count of [1, 2])
  test(`repository configuration opens each of ${count} installations in a separate tab`, async () => {
    const context = appContext(
      ["github:manage"],
      mock(async () => ({})),
    );
    context.githubStatus.installations = Array.from({ length: count }, (_, index) => ({
      ...context.githubStatus.installations[0]!,
      installationId: 71 + index,
      configureUrl: `https://api.example.test/github/configure/${71 + index}`,
    }));
    const rendered = await renderAdapter(context);
    const originalOpen = window.open;
    const open = mock(() => null);
    window.open = open;
    try {
      if (count === 1) rendered.model().access!.onEdit!();
      else
        for (const option of rendered.model().options) {
          if (option.kind === "link" && option.id.startsWith("github-repositories-"))
            option.action.onClick();
        }
      expect(open).toHaveBeenCalledTimes(count);
      for (let index = 0; index < count; index++)
        expect(open).toHaveBeenCalledWith(
          `https://api.example.test/github/configure/${71 + index}`,
          "_blank",
          "noopener,noreferrer",
        );
    } finally {
      window.open = originalOpen;
      await rendered.unmount();
    }
  });

describe("GitHub load failures", () => {
  test("a repository list that never loaded says so, with a retry the person started", async () => {
    const refreshes: unknown[][] = [];
    const context = {
      ...appContext(
        ["github:manage"],
        mock(async () => ({})),
      ),
      githubStatusFailed: true,
      githubCatalogReady: false,
      refreshGitHub: async (...args: unknown[]) => {
        refreshes.push(args);
      },
    };
    const rendered = await renderAdapter(context);
    try {
      const model = rendered.model();
      expect(model.chip).toEqual({ label: "Needs attention", tone: "warn" });
      expect(model.notice?.title).toBe("Repositories could not be loaded.");
      // No endless "Loading repositories…" block next to the failure.
      expect(model.access).toBeUndefined();
      model.notice!.action!.onClick();
      expect(refreshes).toEqual([[WORKSPACE_ID, undefined, { userInitiated: true }]]);
    } finally {
      await rendered.unmount();
    }
  });

  test("a failed first status load retries as a refresh the person started", async () => {
    const refreshes: unknown[][] = [];
    const context = {
      ...appContext(
        ["github:manage"],
        mock(async () => ({})),
      ),
      githubStatus: null,
      githubStatusFailed: true,
      githubCatalogReady: false,
      refreshGitHub: async (...args: unknown[]) => {
        refreshes.push(args);
      },
    };
    const rendered = await renderAdapter(context);
    try {
      const model = rendered.model();
      expect(model.notice?.title).toBe("GitHub status could not be loaded.");
      model.notice!.action!.onClick();
      expect(refreshes).toEqual([[WORKSPACE_ID, undefined, { userInitiated: true }]]);
    } finally {
      await rendered.unmount();
    }
  });
});

function personalConnection(status: "active" | "needs_reauth" = "active") {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    version: 3,
    status,
    providerDomain: "github.com",
    kind: "oauth2",
    metadata: { githubLogin: "octocat" },
  };
}

function personalContext(
  overrides: Record<string, unknown> = {},
  permissions = ["github:manage", "connections:read", "connections:write"],
) {
  return {
    ...appContext(
      permissions,
      mock(async () => ({})),
    ),
    personalGitHubStatus: { enabled: true, connection: null, reviewUrl: null },
    personalGitHubSelection: null,
    personalGitHubRepositories: [],
    personalGitHubCatalogReady: true,
    connectPersonalGitHub: mock(async () => {}),
    reconnectPersonalGitHub: mock(async () => {}),
    ...overrides,
  };
}

function section(model: IntegrationViewModel, id: string) {
  const found = model.sections?.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Missing section ${id}`);
  return found;
}

describe("GitHub connects two ways", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    personalDialog.current = null;
  });

  test("names each identity with one action and keeps only Disconnect in the header", async () => {
    const context = personalContext();
    const rendered = await renderAdapter(context);
    try {
      const model = rendered.model();
      expect(model.sections?.map((entry) => entry.title)).toEqual(["Your GitHub", "Opengeni app"]);
      const personal = section(model, "github-personal");
      expect(personal.description).toBe(
        "Work appears under your name. Only in chats you start, on repos you choose.",
      );
      expect(personal.action?.label).toBe("Connect");
      expect(personal.action?.primary).toBe(true);
      expect(personal.action?.connectProviderId).toBe("github-personal");
      const app = section(model, "github-app");
      expect(app.description).toBe("Work appears as the Opengeni bot, shared with the workspace.");
      expect(app.status).toBe("Installed on Cloudgeni-ai");
      expect(app.action?.label).toBe("Install on another account");
      expect(app.action?.connectProviderId).toBe("github-app");
      expect(model.connection).toEqual([]);
      expect(model.access?.title).toBe("Opengeni app repositories");
      expect(model.footer).toMatchObject({
        kind: "actions",
        secondary: { label: "Disconnect Opengeni app", destructive: true },
      });
      if (model.footer.kind === "actions") expect(model.footer.primary).toBeUndefined();
      expect(JSON.stringify(model)).not.toContain("Connect another account");
      personal.action?.onClick();
      expect(context.connectPersonalGitHub).toHaveBeenCalledWith(WORKSPACE_ID);
    } finally {
      await rendered.unmount();
    }
  });

  test("connected shows the login and repo count, and zero repos makes Choose repos the next step", async () => {
    const rendered = await renderAdapter(
      personalContext({
        personalGitHubStatus: {
          enabled: true,
          connection: personalConnection(),
          reviewUrl: null,
        },
        personalGitHubSelection: { repositories: [] },
      }),
    );
    try {
      const personal = section(rendered.model(), "github-personal");
      expect(personal.status).toBe("Connected as @octocat · 0 repos");
      expect(personal.action?.label).toBe("Choose repos");
      expect(personal.action?.primary).toBe(true);
      expect(personalDialog.current?.open).toBe(false);
      await act(async () => {
        personal.action?.onClick();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(personalDialog.current?.open).toBe(true);
    } finally {
      await rendered.unmount();
    }
  });

  test("returning from GitHub opens the repository chooser directly", async () => {
    markPersonalGitHubRepositoryChooser(WORKSPACE_ID);
    const rendered = await renderAdapter(
      personalContext({
        personalGitHubStatus: {
          enabled: true,
          connection: personalConnection(),
          reviewUrl: null,
        },
        personalGitHubSelection: { repositories: [{}, {}] },
      }),
    );
    try {
      expect(section(rendered.model(), "github-personal").status).toBe(
        "Connected as @octocat · 2 repos",
      );
      expect(personalDialog.current?.open).toBe(true);
    } finally {
      await rendered.unmount();
    }
  });

  test("the agent's connect link opens the chooser once connected and is removed from the URL", async () => {
    const page = (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;
    page.setURL("http://localhost/workspaces/w/plugins?open=integration%3Agithub&github=personal");
    const rendered = await renderAdapter(
      personalContext({
        personalGitHubStatus: {
          enabled: true,
          connection: personalConnection(),
          reviewUrl: null,
        },
        personalGitHubSelection: { repositories: [] },
      }),
    );
    try {
      expect(personalDialog.current?.open).toBe(true);
      expect(window.location.search).toBe("?open=integration%3Agithub");
    } finally {
      await rendered.unmount();
      page.setURL("http://localhost/");
    }
  });

  test("reconnect, and notes in place of actions the viewer cannot take", async () => {
    const rendered = await renderAdapter(
      personalContext(
        {
          personalGitHubStatus: {
            enabled: true,
            connection: personalConnection("needs_reauth"),
            reviewUrl: null,
          },
        },
        ["connections:read"],
      ),
    );
    try {
      const model = rendered.model();
      expect(model.chip.label).toBe("Needs attention");
      const personal = section(model, "github-personal");
      expect(personal.status).toBe("@octocat needs to reconnect.");
      expect(personal.action).toBeUndefined();
      expect(personal.note).toBeTruthy();
      const app = section(model, "github-app");
      expect(app.action).toBeUndefined();
      expect(app.note).toBe("A workspace admin manages the Opengeni app.");
      expect(model.footer).toEqual({ kind: "actions" });
    } finally {
      await rendered.unmount();
    }
    const writer = await renderAdapter(
      personalContext({
        personalGitHubStatus: {
          enabled: true,
          connection: personalConnection("needs_reauth"),
          reviewUrl: null,
        },
      }),
    );
    try {
      const action = section(writer.model(), "github-personal").action;
      expect(action?.label).toBe("Reconnect");
      action?.onClick();
      expect(
        (mutableContext.current.reconnectPersonalGitHub as ReturnType<typeof mock>).mock.calls,
      ).toHaveLength(1);
    } finally {
      await writer.unmount();
    }
  });

  test("without personal sign-in the sheet keeps the single App layout", async () => {
    const rendered = await renderAdapter(
      appContext(
        ["github:manage"],
        mock(async () => ({})),
      ),
    );
    try {
      const model = rendered.model();
      expect(model.sections).toBeUndefined();
      expect(model.description).toBe(
        "Work on repositories, issues, and pull requests through the Opengeni app.",
      );
      expect(model.access?.title).toBe("Repositories");
    } finally {
      await rendered.unmount();
    }
  });
});
