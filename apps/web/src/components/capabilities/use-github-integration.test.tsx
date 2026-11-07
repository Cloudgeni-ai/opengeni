import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { OpenGeniClient, type GitHubActionPoliciesResponse } from "@opengeni/sdk";
import type { AccessContext, GitHubAppInfo } from "@opengeni/react/app/types";
import type { IntegrationViewModel } from "@opengeni/react/app/components/capabilities/integration-view-model";

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

// Before the adapter loads: Radix decides at import whether it can use layout
// effects, and without a document its dialogs never mount.
GlobalRegistrator.register();
const { useGitHubIntegration, githubInstallationAttention } =
  await import("./use-github-integration");
const { markPersonalGitHubRepositoryChooser } = await import("@/lib/personal-github-oauth");
const { returningFromGitHub } = await import("@opengeni/react/app/lib/github-access-return");

beforeAll(() => {
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

function policies(model: IntegrationViewModel) {
  if (!model.policies) throw new Error("Missing approvals table");
  return model.policies;
}

function policyCell(model: IntegrationViewModel, row: string, column = "app") {
  const cell = policies(model).cell(row, column);
  if (!cell) throw new Error(`Missing approval cell ${row}:${column}`);
  return cell;
}

function installationRows(model: IntegrationViewModel) {
  return model.sections?.find((candidate) => candidate.id === "github-app")?.rows ?? [];
}

function installationRow(model: IntegrationViewModel, installationId: number) {
  const row = installationRows(model).find(
    (candidate) => candidate.id === `github-installation-${installationId}`,
  );
  if (!row) throw new Error(`Missing installation row ${installationId}`);
  return row;
}

function workspaceAppActor(
  installationId: number,
  groups: {
    routine: "allow" | "ask" | "block";
    review: "allow" | "ask" | "block";
    merge: "allow" | "ask" | "block";
  },
) {
  return { kind: "workspace_app" as const, installationId, label: `bot ${installationId}`, groups };
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
      const table = policies(rendered.model());
      expect(table.columns).toEqual([{ id: "app", label: "Opengeni app" }]);
      expect(table.rows.map((row) => row.label)).toEqual([
        "Create and update work",
        "Submit reviews",
        "Merge pull requests",
      ]);
      expect(table.choices.map((choice) => choice.label)).toEqual(["Allow", "Ask first", "Block"]);
      // One short footnote, no per-control boilerplate.
      expect(table.footnote).toBe("Changes apply to new actions.");
      expect(table.advanced).toBeUndefined();
      expect(policyCell(rendered.model(), "routine").value).toBe("ask");
      expect(policyCell(rendered.model(), "merge").value).toBe("ask");
      await act(async () => {
        policies(rendered.model()).onChange("routine", "app", "allow");
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(update).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledWith(WORKSPACE_ID, {
        actor: { kind: "workspace_app", installationId: 71 },
        group: "routine",
        decision: "allow",
      });
      expect(policyCell(rendered.model(), "routine").value).toBe("allow");
      expect(policyCell(rendered.model(), "review").value).toBe("ask");
      expect(policyCell(rendered.model(), "merge").value).toBe("ask");
    } finally {
      await rendered.unmount();
    }
  });

  test("All actions sets every action on every installation, one save at a time", async () => {
    const saved: Array<{ installationId: number; group: string; decision: string }> = [];
    const actors = new Map([
      [71, workspaceAppActor(71, { routine: "allow", review: "ask", merge: "ask" })],
      [81, workspaceAppActor(81, { routine: "allow", review: "allow", merge: "ask" })],
    ]);
    let inFlight = 0;
    const update = mock(
      async (
        _workspaceId: string,
        input: {
          actor: { kind: "workspace_app"; installationId: number };
          group: "routine" | "review" | "merge";
          decision: "allow" | "ask" | "block";
        },
      ) => {
        inFlight += 1;
        expect(inFlight).toBe(1);
        await new Promise((resolve) => setTimeout(resolve, 0));
        inFlight -= 1;
        saved.push({
          installationId: input.actor.installationId,
          group: input.group,
          decision: input.decision,
        });
        const actor = actors.get(input.actor.installationId)!;
        const next = { ...actor, groups: { ...actor.groups, [input.group]: input.decision } };
        actors.set(input.actor.installationId, next);
        return next;
      },
    );
    const context = appContext(["github:manage"], update);
    context.githubStatus.installations = [
      { ...context.githubStatus.installations[0]!, installationId: 71, accountLogin: "acme" },
      { ...context.githubStatus.installations[0]!, installationId: 81, accountLogin: "octocat" },
    ];
    (context.client as Record<string, unknown>).getGitHubActionPolicies = mock(async () => ({
      enabled: true,
      actors: [...actors.values()],
    }));
    const rendered = await renderAdapter(context);
    try {
      const table = policies(rendered.model());
      // The installations agree on nothing but routine work.
      expect(table.all?.label).toBe("All actions");
      expect(table.all?.cell("app")?.value).toBe("mixed");
      expect(table.otherValueLabels).toEqual({ mixed: "Mixed" });
      expect(policyCell(rendered.model(), "routine").value).toBe("allow");
      expect(policyCell(rendered.model(), "review").value).toBe("mixed");
      // Each installation can still be set on its own, behind Advanced.
      expect(table.advanced?.columns.map((column) => column.label)).toEqual(["acme", "octocat"]);
      expect(table.advanced?.summary).toBe("Installations are set differently");
      await act(async () => {
        policies(rendered.model()).all!.onChange("app", "ask");
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      // Only the values that change are saved.
      expect(saved).toEqual([
        { installationId: 71, group: "routine", decision: "ask" },
        { installationId: 81, group: "routine", decision: "ask" },
        { installationId: 81, group: "review", decision: "ask" },
      ]);
      for (const row of ["routine", "review", "merge"])
        expect(policyCell(rendered.model(), row).value).toBe("ask");
      expect(policies(rendered.model()).all?.cell("app")?.value).toBe("ask");
      expect(policies(rendered.model()).advanced?.summary).toBe("Set each installation separately");
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
        policies(rendered.model()).onChange("routine", "app", "block");
      });
      await rendered.rerender(OTHER_WORKSPACE_ID);
      await act(async () => {
        resolveSave(actor);
        await pending;
      });
      expect(policyCell(rendered.model(), "routine").value).toBe("ask");
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
        policies(rendered.model()).onChange("routine", "app", "allow");
        policies(rendered.model()).onChange("merge", "app", "block");
      });
      expect(update).toHaveBeenCalledTimes(1);
      expect(policyCell(rendered.model(), "merge").disabled).toBe(true);
      expect(policyCell(rendered.model(), "routine").busy).toBe(true);
      await act(async () => {
        resolveSave(actor);
        await pending;
      });
      expect(policyCell(rendered.model(), "routine").value).toBe("allow");
      expect(policyCell(rendered.model(), "merge").disabled).toBe(false);
      await act(async () => {
        policies(rendered.model()).onChange("merge", "app", "block");
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
      expect(policyCell(rendered.model(), "routine").disabled).toBe(true);
      expect(policyCell(rendered.model(), "review").disabled).toBe(true);
      expect(policyCell(rendered.model(), "merge").disabled).toBe(true);
      expect(policies(rendered.model()).all?.cell("app")?.disabled).toBe(true);
      expect(policies(rendered.model()).note).toBe(
        "A workspace admin sets the Opengeni app's approvals.",
      );
    } finally {
      await rendered.unmount();
    }
  });

  test("a failed load shows a retry in place of the table", async () => {
    const context = appContext(
      ["github:manage"],
      mock(async () => ({})),
    );
    let fail = true;
    const getPolicies = mock(async () => {
      if (fail) throw new Error("unavailable");
      return {
        enabled: true,
        actors: [workspaceAppActor(71, { routine: "ask", review: "ask", merge: "ask" })],
      };
    });
    (context.client as Record<string, unknown>).getGitHubActionPolicies = getPolicies;
    const rendered = await renderAdapter(context);
    try {
      expect(policies(rendered.model()).failure?.message).toBe(
        "Approval settings could not be loaded.",
      );
      fail = false;
      await act(async () => {
        policies(rendered.model()).failure!.onRetry();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(policies(rendered.model()).failure).toBeUndefined();
      expect(policyCell(rendered.model(), "merge").value).toBe("ask");
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
      expect(policyCell(rendered.model(), "routine").value).toBe("allow");

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

      expect(policyCell(rendered.model(), "routine").value).toBe("allow");
    } finally {
      await rendered.unmount();
    }
  });
});

for (const count of [1, 2])
  test(`repository configuration opens each of ${count} installations in a separate tab through a fresh link`, async () => {
    const context = appContext(
      ["github:manage"],
      mock(async () => ({})),
    );
    const installations = (suffix: string) =>
      Array.from({ length: count }, (_, index) => ({
        ...context.githubStatus.installations[0]!,
        installationId: 71 + index,
        accountLogin: `account-${71 + index}`,
        configureUrl: `https://api.example.test/github/configure/${71 + index}?state=${suffix}`,
      }));
    context.githubStatus.installations = installations("loaded");
    const getGitHubApp = mock(async () => ({
      ...githubStatus(),
      installations: installations("fresh"),
    }));
    (context.client as Record<string, unknown>).getGitHubApp = getGitHubApp;
    const rendered = await renderAdapter(context);
    const originalOpen = window.open;
    const visited: string[] = [];
    const open = mock(() => ({
      opener: {},
      location: { replace: (url: string) => visited.push(url) },
      close: () => {},
    }));
    window.open = open as unknown as typeof window.open;
    try {
      // One row per installation, and no shared header link that would open only the first.
      expect(rendered.model().access?.onEdit).toBeUndefined();
      for (let index = 0; index < count; index++) {
        const installationId = 71 + index;
        const action = installationRow(rendered.model(), installationId).action;
        expect(action).toMatchObject({
          label: "Change repositories",
          ariaLabel: `Change repositories for account-${installationId}`,
        });
        await act(async () => {
          installationRow(rendered.model(), installationId).action!.onClick();
          // A double-click while the link is minted opens one tab.
          installationRow(rendered.model(), installationId).action!.onClick();
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
      expect(open).toHaveBeenCalledTimes(count);
      // Back from GitHub, the composer's repository menu refreshes and syncs.
      expect(returningFromGitHub(WORKSPACE_ID)).toBe(true);
      expect(getGitHubApp).toHaveBeenCalledTimes(count);
      // Never the copy captured when the page loaded.
      expect(visited).toEqual(
        Array.from(
          { length: count },
          (_, index) => `https://api.example.test/github/configure/${71 + index}?state=fresh`,
        ),
      );
    } finally {
      window.open = originalOpen;
      await rendered.unmount();
    }
  });

function confirmButton(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) throw new Error(`Missing ${label} button`);
  return button;
}

test("several installations each remove on their own, after a confirm", async () => {
  const context = appContext(
    ["github:manage"],
    mock(async () => ({})),
  );
  context.githubStatus.installations = [
    { ...context.githubStatus.installations[0]!, installationId: 71, accountLogin: "Cloudgeni-ai" },
    {
      ...context.githubStatus.installations[0]!,
      installationId: 81,
      accountLogin: "benyhh",
      accountType: "User",
      repositoryCount: 4,
    },
  ];
  const unlinked: number[] = [];
  const rendered = await renderAdapter({
    ...context,
    disconnectGitHubInstallation: async (_workspaceId: string, installationId: number) => {
      unlinked.push(installationId);
      return true;
    },
  });
  try {
    const rows = installationRows(rendered.model());
    expect(rows.map((row) => [row.title, row.meta])).toEqual([
      ["Cloudgeni-ai", "Organization · 1 repository"],
      ["benyhh", "Personal account · 4 repositories"],
    ]);
    // Healthy rows carry no status.
    expect(rows.every((row) => row.attention === undefined)).toBe(true);
    const benyhh = rows[1]!;
    expect(benyhh.menu).toEqual([expect.objectContaining({ label: "Remove", destructive: true })]);
    await act(async () => {
      benyhh.menu![0]!.onClick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // Nothing is removed until the confirm.
    expect(unlinked).toEqual([]);
    expect(document.body.textContent).toContain("Remove benyhh from this workspace?");
    await act(async () => {
      confirmButton("Remove").click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(unlinked).toEqual([81]);
  } finally {
    await rendered.unmount();
  }
});

test("an installation that is not active says why, offers its fix, and stays removable", async () => {
  const context = appContext(
    ["github:manage"],
    mock(async () => ({})),
  );
  // Every installation suspended: GitHub reports the workspace unbound, but it is still linked.
  context.githubStatus.status = "unbound";
  context.githubStatus.installations = [
    {
      ...context.githubStatus.installations[0]!,
      installationId: 71,
      accountLogin: "Cloudgeni-ai",
      lifecycle: "suspended",
      issue: "suspended",
    },
  ];
  const unlinked: number[] = [];
  const rendered = await renderAdapter({
    ...context,
    personalGitHubStatus: { enabled: true, connection: null, reviewUrl: null },
    disconnectGitHubInstallation: async (_workspaceId: string, installationId: number) => {
      unlinked.push(installationId);
      return true;
    },
  } as typeof context);
  try {
    const model = rendered.model();
    expect(model.chip).toEqual({ label: "Needs attention", tone: "warn" });
    const row = installationRow(model, 71);
    expect(row.attention).toEqual({
      label: "Suspended on GitHub",
      detail: "The Opengeni app is suspended on Cloudgeni-ai. Unsuspend it in GitHub's settings.",
    });
    expect(row.action).toMatchObject({
      label: "Unsuspend on GitHub",
      ariaLabel: "Unsuspend on GitHub: Cloudgeni-ai",
      primary: true,
    });
    expect(model.footer).toMatchObject({
      kind: "actions",
      secondary: { label: "Disconnect Opengeni app" },
    });
    await act(async () => {
      row.menu!.find((item) => item.label === "Remove")!.onClick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.body.textContent).toContain("Remove Cloudgeni-ai from this workspace?");
    await act(async () => {
      confirmButton("Remove").click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(unlinked).toEqual([71]);
  } finally {
    await rendered.unmount();
  }
});

test("a member sees what is wrong without the fix they cannot make", async () => {
  const context = appContext(
    ["github:use"],
    mock(async () => ({})),
  );
  context.githubStatus.installations = [
    {
      ...context.githubStatus.installations[0]!,
      lifecycle: "deleted",
      issue: "uninstalled",
    },
  ];
  const rendered = await renderAdapter(context);
  try {
    const row = installationRow(rendered.model(), 71);
    expect(row.attention).toEqual({
      label: "Uninstalled on GitHub",
      detail: "The Opengeni app was removed from Cloudgeni-ai on GitHub.",
    });
    expect(row.action).toBeUndefined();
    expect(row.menu).toBeUndefined();
  } finally {
    await rendered.unmount();
  }
});

describe("githubInstallationAttention", () => {
  const base = githubStatus().installations[0]!;
  test("an active installation needs nothing", () => {
    expect(githubInstallationAttention(base)).toBeNull();
  });
  for (const [issue, label, fix, actionLabel] of [
    ["uninstalled", "Uninstalled on GitHub", "reinstall", "Reinstall"],
    ["suspended", "Suspended on GitHub", "configure", "Unsuspend on GitHub"],
    ["no_repositories", "No repositories", "configure", "Choose repositories"],
    ["github_unreachable", "Not checked", "recheck", "Check again"],
    ["account_changed", "Account changed", "remove", "Remove"],
    ["owner_unconfirmed", "Needs authorization", "authorize", "Authorize"],
  ] as const)
    test(`${issue} is named by its fix`, () => {
      expect(
        githubInstallationAttention({ ...base, lifecycle: "unverified", issue }),
      ).toMatchObject({ label, fix, actionLabel });
    });
  test("a server without the issue field falls back to the lifecycle", () => {
    expect(githubInstallationAttention({ ...base, lifecycle: "deleted" })?.fix).toBe("reinstall");
    expect(githubInstallationAttention({ ...base, lifecycle: "suspended" })?.fix).toBe("configure");
    expect(githubInstallationAttention({ ...base, lifecycle: "unverified" })?.fix).toBe(
      "authorize",
    );
  });
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
      // The rows say where it is installed.
      expect(app.status).toBeUndefined();
      expect(app.rows?.map((row) => row.title)).toEqual(["Cloudgeni-ai"]);
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

  test("a selection that has not loaded shows no repo count instead of 0 repos", async () => {
    // Bendik saw "Connected as @benyhh · 0 repos" while GitHub refused his
    // stale grant: the repository read failed and left no selection.
    const rendered = await renderAdapter(
      personalContext({
        personalGitHubStatus: {
          enabled: true,
          connection: personalConnection(),
          reviewUrl: null,
        },
        personalGitHubSelection: null,
      }),
    );
    try {
      const personal = section(rendered.model(), "github-personal");
      expect(personal.status).toBe("Connected as @octocat");
      expect(personal.action?.label).toBe("Choose repos");
      expect(personal.action?.primary).toBe(false);
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

  test("the connect link never opens the chooser for a viewer who can't save it", async () => {
    const page = (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;
    page.setURL("http://localhost/workspaces/w/plugins?open=integration%3Agithub&github=personal");
    const rendered = await renderAdapter(
      personalContext(
        {
          personalGitHubStatus: {
            enabled: true,
            connection: personalConnection(),
            reviewUrl: null,
          },
          personalGitHubSelection: { repositories: [] },
        },
        ["github:manage", "connections:read"],
      ),
    );
    try {
      expect(personalDialog.current?.open ?? false).toBe(false);
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
      // The header owns connecting; the app section holds only the installation rows.
      expect(model.sections?.map((entry) => [entry.id, entry.action])).toEqual([
        ["github-app", undefined],
      ]);
      expect(installationRows(model).map((row) => row.title)).toEqual(["Cloudgeni-ai"]);
      expect(model.description).toBe(
        "Work on repositories, issues, and pull requests through the Opengeni app.",
      );
      expect(model.access?.title).toBe("Repositories");
    } finally {
      await rendered.unmount();
    }
  });
});
