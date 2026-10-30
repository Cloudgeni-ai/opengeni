import { describe, expect, test } from "bun:test";
import { createElement, StrictMode } from "react";

import { FollowUpRepositoryMenuBody } from "@opengeni/react/app/components/follow-up-repository-menu-body";
import {
  RepositoryContextPicker,
  RepositoryContextMenuBody,
  defaultRepositoryIdentity,
  repositoryBindingPresentation,
  repositoryPickerRowGroups,
  type RepositoryContextPickerProps,
} from "@opengeni/react/app/components/repository-picker";
import { groupRepositories } from "@opengeni/react/app/lib/session-tools";
import { actRun, registerDom, renderComponent } from "../../../packages/react/test/render-hook";
import type {
  GitHubInstallationBinding,
  GitHubRepository,
  PersonalGitHubConnectionStatusResponse,
  PersonalGitHubRepositoryCatalogItem,
} from "@opengeni/react/app/types";

registerDom();

describe("repository picker GitHub binding status", () => {
  test("projects configured-but-unbound as actionable and never healthy", () => {
    const url = "https://api.opengeni.test/v1/workspaces/workspace/github/connect?state=fresh";
    const presentation = repositoryBindingPresentation("unbound", url);
    expect(presentation).toMatchObject({
      connectUrl: url,
      connectLabel: "Connect workspace App",
      healthy: false,
      canRefresh: false,
    });
    expect(presentation.setupDescription).toContain("no usable installation binding");
    expect(presentation.emptyDescription).toContain("no active installation binding");
    expect(presentation.emptyDescription).toContain("repository administrators");
  });

  test("hosted mode presents installation only, without operator credential setup", () => {
    const url = "https://api.opengeni.test/v1/workspaces/workspace/github/connect?state=fresh";
    const presentation = repositoryBindingPresentation("unbound", url, "platform");
    expect(presentation).toMatchObject({
      connectUrl: url,
      connectLabel: "Connect workspace App",
      healthy: false,
      canRefresh: false,
    });
    expect(presentation.setupDescription).toContain("Install Opengeni");
    expect(presentation.emptyDescription).not.toContain("server credentials");
    expect(presentation.emptyDescription).not.toContain(".env");
  });

  test("hosted disabled state reports deployment availability, not operator setup", () => {
    const presentation = repositoryBindingPresentation("disabled", null, "platform");
    expect(presentation.connectUrl).toBeNull();
    expect(presentation.emptyDescription).toContain("unavailable");
    expect(presentation.emptyDescription).not.toContain("not configured");
  });

  test("projects bound-empty as healthy with truthful provider-policy copy", () => {
    const presentation = repositoryBindingPresentation(
      "bound",
      "https://api.opengeni.test/github/connect",
    );
    expect(presentation).toMatchObject({
      connectLabel: "Install on another account",
      healthy: true,
      canRefresh: true,
    });
    expect(presentation.emptyDescription).toContain("none of its explicitly allowed repositories");
    expect(presentation.emptyDescription).toContain("policy approval");
  });

  test("projects disabled without a connect URL or healthy controls", () => {
    const presentation = repositoryBindingPresentation(
      "disabled",
      "https://api.opengeni.test/must-not-be-used",
    );
    expect(presentation).toMatchObject({
      connectUrl: null,
      healthy: false,
      canRefresh: false,
    });
    expect(presentation.emptyDescription).toContain("not configured");
  });
});

describe("repository picker GitHub App links", () => {
  test("connect and installation settings start from a click, never a page-load link", async () => {
    const stale =
      "https://api.opengeni.test/v1/workspaces/workspace/github/connect?state=minted-at-load";
    let connects = 0;
    const configured: number[] = [];
    const rendered = await renderComponent(
      createElement(RepositoryContextMenuBody, {
        setupMode: "platform",
        configured: true,
        status: "unbound",
        installUrl: stale,
        linkUrl: stale,
        installations: [
          {
            installationId: 42,
            accountLogin: "octo-org",
            lifecycle: "active",
            repositoryScope: "selected",
            repositoryCount: 2,
            configureUrl: `${stale}&configure=42`,
          } as unknown as GitHubInstallationBinding,
        ],
        repositories: [],
        groups: [],
        selectedRepoIds: new Set<number>(),
        selectedRepoRefs: {},
        manualRepos: [],
        manualOpen: false,
        githubAppOpen: false,
        org: "",
        pending: false,
        repoBusy: false,
        githubAppBusy: false,
        onRefresh: async () => {},
        onToggleRepo: () => {},
        onRefChange: () => {},
        onManualOpenChange: () => {},
        onManualAdd: () => {},
        onManualUpdate: () => {},
        onManualRemove: () => {},
        onGitHubAppOpenChange: () => {},
        onOrgChange: () => {},
        onStartGitHubApp: () => {},
        onConnectWorkspaceApp: () => {
          connects += 1;
        },
        onConfigureInstallation: async (installationId: number) => {
          configured.push(installationId);
          throw new Error("You can't change this installation's repositories.");
        },
        onDisconnectInstallation: async () => {},
      }),
    );
    // No anchor may carry a signed state captured when the page loaded.
    expect(
      [...rendered.container.querySelectorAll("a")].filter((anchor) =>
        anchor.getAttribute("href")?.includes("state="),
      ),
    ).toEqual([]);

    const buttons = () => [...rendered.container.querySelectorAll<HTMLButtonElement>("button")];
    const connect = buttons().find((button) => button.textContent === "Connect workspace App");
    expect(connect).toBeTruthy();
    await actRun(() => connect!.click());
    expect(connects).toBe(1);

    const settings = buttons().find((button) => button.textContent === "Repositories");
    await actRun(() => settings!.click());
    await actRun(() => Promise.resolve());
    expect(configured).toEqual([42]);
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't open GitHub. You can't change this installation's repositories.",
    );
    await rendered.unmount();
  });
});

describe("repository picker GitHub load failure", () => {
  function failedLoadProps(onRefresh: () => Promise<void>) {
    return {
      setupMode: "platform" as const,
      configured: true,
      // A failed first status load leaves the picker on its "disabled" fallback.
      status: "disabled" as const,
      installUrl: null,
      linkUrl: null,
      installations: [],
      repositories: [],
      groups: [],
      selectedRepoIds: new Set<number>(),
      selectedRepoRefs: {},
      manualRepos: [],
      manualOpen: false,
      githubAppOpen: false,
      org: "",
      pending: false,
      repoBusy: false,
      githubLoadFailed: true,
      githubAppBusy: false,
      onRefresh,
      onToggleRepo: () => {},
      onRefChange: () => {},
      onManualOpenChange: () => {},
      onManualAdd: () => {},
      onManualUpdate: () => {},
      onManualRemove: () => {},
      onGitHubAppOpenChange: () => {},
      onOrgChange: () => {},
      onStartGitHubApp: () => {},
      onConnectWorkspaceApp: () => {},
      onConfigureInstallation: async () => {},
      onDisconnectInstallation: async () => {},
    };
  }

  test("says GitHub couldn't load and offers a refresh instead of setup", async () => {
    let refreshes = 0;
    const rendered = await renderComponent(
      createElement(
        RepositoryContextMenuBody,
        failedLoadProps(async () => {
          refreshes += 1;
        }),
      ),
    );
    const text = rendered.container.textContent ?? "";
    expect(text).toContain("Couldn't load GitHub");
    expect(text).not.toContain("unavailable");
    expect(text).not.toContain("No repositories");
    const refresh = [...rendered.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Refresh list",
    );
    expect(refresh).toBeTruthy();
    await actRun(() => refresh!.click());
    await actRun(() => Promise.resolve());
    expect(refreshes).toBe(1);
    await rendered.unmount();
  });
});

describe("additive repository picker", () => {
  const personalRepository: PersonalGitHubRepositoryCatalogItem = {
    repositoryId: "9007199254740993123",
    fullName: "octocat/private-repository",
    canonicalUrl: "https://github.com/octocat/private-repository",
    defaultBranch: "main",
    visibility: "private",
    private: true,
    archived: false,
    disabled: false,
    permissions: { pull: true, push: true, admin: false, maintain: false, triage: false },
    selectedAccess: "write",
  };
  const personalStatus = {
    enabled: true,
    connection: {
      status: "active",
      metadata: { githubLogin: "octocat" },
    },
    reviewUrl: null,
  } as unknown as PersonalGitHubConnectionStatusResponse;

  test("keeps one selected repository identifiable in the compact trigger", async () => {
    const repository: GitHubRepository = {
      id: 456,
      installationId: 123,
      fullName: "Cloudgeni-ai/opengeni",
      name: "opengeni",
      private: true,
      htmlUrl: "https://github.com/Cloudgeni-ai/opengeni",
      cloneUrl: "https://github.com/Cloudgeni-ai/opengeni.git",
      defaultBranch: "main",
      accountLogin: "Cloudgeni-ai",
      accountType: "Organization",
    };
    const rendered = await renderComponent(
      createElement(RepositoryContextPicker, {
        setupMode: "platform",
        configured: true,
        status: "bound",
        installUrl: null,
        linkUrl: null,
        installations: [],
        repositories: [repository],
        groups: [],
        selectedRepoIds: new Set([repository.id]),
        selectedRepoRefs: { [repository.id]: "main" },
        manualRepos: [],
        manualOpen: false,
        githubAppOpen: false,
        org: "",
        pending: false,
        repoBusy: false,
        githubAppBusy: false,
        onRefresh: async () => {},
        onToggleRepo: () => {},
        onRefChange: () => {},
        onManualOpenChange: () => {},
        onManualAdd: () => {},
        onManualUpdate: () => {},
        onManualRemove: () => {},
        onGitHubAppOpenChange: () => {},
        onOrgChange: () => {},
        onStartGitHubApp: () => {},
        onConnectWorkspaceApp: () => {},
        onConfigureInstallation: async () => {},
        onDisconnectInstallation: async () => {},
      }),
    );

    const trigger = rendered.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Repository context: Cloudgeni-ai/opengeni"]',
    );
    expect(trigger?.textContent).toContain("Cloudgeni-ai/opengeni");
    expect(trigger?.title).toBe("Cloudgeni-ai/opengeni");
    await rendered.unmount();
  });

  test("renders already-mounted repositories as locked", async () => {
    const repository: GitHubRepository = {
      id: 456,
      installationId: 123,
      fullName: "example/app",
      name: "app",
      private: false,
      htmlUrl: "https://github.com/example/app",
      cloneUrl: "https://github.com/example/app.git",
      defaultBranch: "main",
      accountLogin: "example",
      accountType: "Organization",
    };
    const rendered = await renderComponent(
      createElement(FollowUpRepositoryMenuBody, {
        setupMode: "platform",
        configured: true,
        status: "bound",
        installUrl: null,
        linkUrl: null,
        installations: [],
        repositories: [repository],
        groups: [
          {
            installationId: repository.installationId,
            label: repository.accountLogin,
            detail: repository.accountType ?? "GitHub account",
            repositories: [repository],
          },
        ],
        selectedRepoIds: new Set([repository.id]),
        selectedRepoRefs: { [repository.id]: "main" },
        manualRepos: [],
        manualOpen: false,
        githubAppOpen: false,
        org: "",
        pending: false,
        repoBusy: false,
        githubAppBusy: false,
        lockedRepoIds: new Set([repository.id]),
        onRefresh: async () => {},
        onToggleRepo: () => {},
        onRefChange: () => {},
        onManualOpenChange: () => {},
        onManualAdd: () => {},
        onManualUpdate: () => {},
        onManualRemove: () => {},
        onGitHubAppOpenChange: () => {},
        onOrgChange: () => {},
        onStartGitHubApp: () => {},
        onConnectWorkspaceApp: () => {},
        onConfigureInstallation: async () => {},
        onDisconnectInstallation: async () => {},
      }),
    );

    const mounted = rendered.container.querySelector<HTMLButtonElement>(
      'button[aria-label="example/app mounted"]',
    );
    expect(mounted?.getAttribute("aria-disabled")).toBe("true");
    expect(mounted?.getAttribute("aria-checked")).toBe("true");
    expect(rendered.container.textContent).toContain("Mounted");
    expect(rendered.container.querySelector('input[aria-label="example/app ref"]')).toBeNull();
    expect(rendered.container.textContent).toContain("main");
    await rendered.unmount();
  });

  test("keeps a selected personal identity compact and locks it after mounting", async () => {
    const props = {
      setupMode: "platform" as const,
      configured: false,
      status: "disabled" as const,
      installUrl: null,
      linkUrl: null,
      installations: [],
      repositories: [],
      groups: [],
      personalGitHubStatus: personalStatus,
      personalGitHubRepositories: [personalRepository],
      selectedPersonalGitHubRepoIds: new Set([personalRepository.repositoryId]),
      selectedPersonalGitHubRepoRefs: { [personalRepository.repositoryId]: "main" },
      selectedRepoIds: new Set<number>(),
      selectedRepoRefs: {},
      manualRepos: [],
      manualOpen: false,
      githubAppOpen: false,
      org: "",
      pending: false,
      repoBusy: false,
      githubAppBusy: false,
      onRefresh: async () => {},
      onConnectPersonalGitHub: () => {},
      onTogglePersonalGitHubRepo: () => {},
      onPersonalGitHubRefChange: () => {},
      onToggleRepo: () => {},
      onRefChange: () => {},
      onManualOpenChange: () => {},
      onManualAdd: () => {},
      onManualUpdate: () => {},
      onManualRemove: () => {},
      onGitHubAppOpenChange: () => {},
      onOrgChange: () => {},
      onStartGitHubApp: () => {},
      onConnectWorkspaceApp: () => {},
      onConfigureInstallation: async () => {},
      onDisconnectInstallation: async () => {},
    };
    const trigger = await renderComponent(createElement(RepositoryContextPicker, props));
    expect(
      trigger.container.querySelector<HTMLButtonElement>(
        'button[aria-label="Repository context: octocat/private-repository"]',
      )?.textContent,
    ).toContain("octocat/private-repository");
    await trigger.unmount();

    const mounted = await renderComponent(
      createElement(FollowUpRepositoryMenuBody, {
        ...props,
        lockedPersonalGitHubRepoIds: new Set([personalRepository.repositoryId]),
      }),
    );
    const row = mounted.container.querySelector<HTMLButtonElement>(
      'button[aria-label="octocat/private-repository mounted as you"]',
    );
    expect(row?.getAttribute("aria-disabled")).toBe("true");
    expect(mounted.container.textContent).toContain("GitHub access");
    expect(mounted.container.textContent).toContain("Mounted");
    await mounted.unmount();

    let openRefreshes = 0;
    let explicitRefreshes = 0;
    let toggles = 0;
    let manualAdds = 0;
    const bodyProps = {
      ...props,
      lockedPersonalGitHubRepoIds: new Set([personalRepository.repositoryId]),
      onManualAdd: () => {
        manualAdds += 1;
      },
      onTogglePersonalGitHubRepo: () => {
        toggles += 1;
      },
      onOpenRefresh: async () => {
        openRefreshes += 1;
      },
      onRefresh: async () => {
        explicitRefreshes += 1;
        throw new Error("Catalog unavailable");
      },
    };
    const body = await renderComponent(
      createElement(StrictMode, null, createElement(RepositoryContextMenuBody, bodyProps)),
    );
    expect(openRefreshes).toBe(1);
    expect(explicitRefreshes).toBe(0);
    expect(body.container.textContent).toContain("Repositories");
    const mountedSwitch = body.container.querySelector<HTMLButtonElement>('button[role="switch"]');
    expect(mountedSwitch?.getAttribute("aria-checked")).toBe("true");
    expect(mountedSwitch?.getAttribute("aria-disabled")).toBe("true");
    await actRun(() => mountedSwitch?.click());
    expect(toggles).toBe(0);
    expect(
      body.container.querySelector('input[aria-label="octocat/private-repository ref"]'),
    ).toBeNull();
    expect(body.container.textContent).toContain("main");
    const addActions = [...body.container.querySelectorAll<HTMLButtonElement>("button")].filter(
      (button) => button.textContent?.includes("Add repository URL"),
    );
    expect(addActions).toHaveLength(1);
    expect(
      [...body.container.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "Add",
      ),
    ).toBe(false);
    await actRun(() => addActions[0]?.click());
    expect(manualAdds).toBe(1);
    expect(body.container.textContent).toContain("Mounted");
    expect(body.container.querySelector('button[aria-label="Refresh repositories"]')).toBeNull();
    await body.rerender(
      createElement(
        StrictMode,
        null,
        createElement(RepositoryContextMenuBody, {
          ...bodyProps,
          onOpenRefresh: async () => {
            openRefreshes += 1;
          },
        }),
      ),
    );
    expect(openRefreshes).toBe(1);
    const refresh = [...body.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("Refresh list"),
    );
    await actRun(() => refresh?.click());
    expect(explicitRefreshes).toBe(1);
    expect(body.container.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't refresh the list. Catalog unavailable",
    );
    await body.rerender(
      createElement(RepositoryContextMenuBody, {
        ...bodyProps,
        lockedPersonalGitHubRepoIds: new Set<string>(),
      }),
    );
    expect(
      body.container.querySelector<HTMLInputElement>(
        'input[aria-label="octocat/private-repository ref"]',
      )?.disabled,
    ).toBe(false);
    await body.unmount();

    const manual = await renderComponent(
      createElement(FollowUpRepositoryMenuBody, {
        ...props,
        manualRepos: [
          { id: -1, url: "https://example.test/repo.git", ref: "release", attached: true },
        ],
        lockedManualRepoIds: new Set([-1]),
        manualOpen: false,
        unavailableMountedRepositories: [
          { uri: "https://github.com/removed/personal.git", ref: "pinned" },
        ],
      }),
    );
    const manualSwitch = manual.container.querySelector<HTMLButtonElement>(
      'button[aria-label="https://example.test/repo.git mounted"]',
    );
    expect(manualSwitch?.getAttribute("aria-checked")).toBe("true");
    expect(manualSwitch?.getAttribute("aria-disabled")).toBe("true");
    expect(manual.container.textContent).toContain("release");
    expect(manual.container.textContent).toContain("Unavailable in catalog");
    expect(
      manual.container
        .querySelector('button[aria-label="https://github.com/removed/personal.git mounted"]')
        ?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(manual.container.querySelector('input[aria-label="Repository URL"]')).toBeNull();
    await manual.unmount();
  });
});

describe("repositories from several GitHub accounts and your GitHub", () => {
  function appRepository(id: number, installationId: number, fullName: string): GitHubRepository {
    const [owner = "", name = ""] = fullName.split("/");
    return {
      id,
      installationId,
      fullName,
      name,
      private: true,
      htmlUrl: `https://github.com/${fullName}`,
      cloneUrl: `https://github.com/${fullName}.git`,
      defaultBranch: "main",
      accountLogin: owner,
      accountType: "Organization",
    };
  }
  function personalRepository(
    repositoryId: string,
    fullName: string,
    selectedAccess: "read" | "write" | null = "write",
  ): PersonalGitHubRepositoryCatalogItem {
    return {
      repositoryId,
      fullName,
      canonicalUrl: `https://github.com/${fullName}`,
      defaultBranch: "main",
      visibility: "private",
      private: true,
      archived: false,
      disabled: false,
      permissions: {
        pull: true,
        push: selectedAccess === "write",
        admin: false,
        maintain: false,
        triage: false,
      },
      selectedAccess,
    };
  }
  const personalStatus = {
    enabled: true,
    connection: { status: "active", metadata: { githubLogin: "octocat" } },
    reviewUrl: null,
  } as unknown as PersonalGitHubConnectionStatusResponse;
  const acmeApi = appRepository(1, 100, "acme/api");
  const acmeWeb = appRepository(2, 100, "acme/web");
  const globexCore = appRepository(3, 200, "globex/core");
  const globexDocs = appRepository(4, 200, "globex/docs");
  const sharedViaApp = appRepository(5, 200, "globex/shared");
  const repositories = [acmeApi, acmeWeb, globexCore, globexDocs, sharedViaApp];
  const personalOnly = personalRepository("900", "octocat/dotfiles");
  const sharedViaYou = personalRepository("901", "Globex/Shared");

  function props(overrides: Partial<RepositoryContextPickerProps> = {}) {
    const calls: string[] = [];
    const base: RepositoryContextPickerProps = {
      setupMode: "platform",
      configured: true,
      status: "bound",
      installUrl: "https://api.opengeni.test/github/connect",
      linkUrl: null,
      installations: [],
      repositories,
      groups: groupRepositories(repositories),
      personalGitHubStatus: personalStatus,
      personalGitHubRepositories: [personalOnly, sharedViaYou],
      selectedPersonalGitHubRepoIds: new Set<string>(),
      selectedPersonalGitHubRepoRefs: {},
      selectedRepoIds: new Set<number>(),
      selectedRepoRefs: {},
      manualRepos: [],
      manualOpen: false,
      githubAppOpen: false,
      org: "",
      pending: false,
      repoBusy: false,
      githubAppBusy: false,
      personalGitHubManageUrl: "/workspaces/w/plugins?open=integration:github",
      onRefresh: async () => {},
      onTogglePersonalGitHubRepo: (repo) => calls.push(`personal:${repo.fullName}`),
      onPersonalGitHubRefChange: (id, ref) => calls.push(`personal-ref:${id}:${ref}`),
      onConnectPersonalGitHub: () => calls.push("connect-personal"),
      onToggleRepo: (repo) => calls.push(`app:${repo.fullName}`),
      onRefChange: (id, ref) => calls.push(`app-ref:${id}:${ref}`),
      onManualOpenChange: () => {},
      onManualAdd: () => {},
      onManualUpdate: () => {},
      onManualRemove: () => {},
      onGitHubAppOpenChange: () => {},
      onOrgChange: () => {},
      onStartGitHubApp: () => {},
      onConnectWorkspaceApp: () => calls.push("install-app"),
      onConfigureInstallation: async () => {},
      onDisconnectInstallation: async () => {},
      ...overrides,
    };
    return { props: base, calls };
  }
  const switchFor = (container: HTMLElement, name: string) =>
    container.querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="${name}"]`);

  test("merges both catalogs into one row per repository, grouped by owner", () => {
    const groups = repositoryPickerRowGroups(groupRepositories(repositories), [
      personalOnly,
      sharedViaYou,
      personalRepository("902", "octocat/not-allowed", null),
    ]);
    expect(groups.map((group) => group.label)).toEqual(["acme", "globex", "octocat"]);
    const rows = groups.flatMap((group) => group.rows);
    expect(rows.map((row) => row.fullName)).toEqual([
      "acme/api",
      "acme/web",
      "globex/core",
      "globex/docs",
      "globex/shared",
      "octocat/dotfiles",
    ]);
    const shared = rows.find((row) => row.fullName === "globex/shared")!;
    expect(shared.app?.id).toBe(sharedViaApp.id);
    expect(shared.personal?.repositoryId).toBe(sharedViaYou.repositoryId);
    expect(defaultRepositoryIdentity(shared)).toBe("personal");
    expect(
      defaultRepositoryIdentity({
        ...shared,
        personal: { ...sharedViaYou, selectedAccess: "read" },
      }),
    ).toBe("app");
    expect(defaultRepositoryIdentity(rows.find((row) => row.app === null)!)).toBe("personal");
  });

  test("selects repositories from two installations and your GitHub together", async () => {
    const { props: picker, calls } = props({
      selectedRepoIds: new Set([acmeApi.id, globexCore.id]),
      selectedRepoRefs: { [acmeApi.id]: "main", [globexCore.id]: "release" },
      selectedPersonalGitHubRepoIds: new Set([personalOnly.repositoryId]),
    });
    const rendered = await renderComponent(createElement(RepositoryContextMenuBody, picker));
    const text = rendered.container.textContent ?? "";
    expect(text).not.toContain("Other app");
    for (const name of ["acme/api", "globex/core", "octocat/dotfiles"]) {
      expect(switchFor(rendered.container, `Select ${name}`)?.getAttribute("aria-checked")).toBe(
        "true",
      );
    }
    // Another installation's repository stays selectable next to both.
    const docs = switchFor(rendered.container, "Select globex/docs");
    expect(docs?.getAttribute("aria-checked")).toBe("false");
    expect(docs?.disabled).toBe(false);
    await actRun(() => docs!.click());
    expect(calls).toEqual(["app:globex/docs"]);
    // Personal-only rows say how they act, without an identity choice.
    expect(text).toContain("As you");
    expect(rendered.container.querySelector('[aria-label="octocat/dotfiles acts as"]')).toBeNull();
    await rendered.unmount();
  });

  test("a repository reachable both ways is one row that acts as you by default", async () => {
    const { props: picker, calls } = props();
    const rendered = await renderComponent(createElement(RepositoryContextMenuBody, picker));
    const rows = [...rendered.container.querySelectorAll('button[role="switch"]')].filter(
      (button) => button.getAttribute("aria-label")?.toLowerCase().includes("globex/shared"),
    );
    expect(rows).toHaveLength(1);
    await actRun(() => switchFor(rendered.container, "Select globex/shared")!.click());
    expect(calls).toEqual(["personal:Globex/Shared"]);
    await rendered.unmount();

    const readOnly = props({
      personalGitHubRepositories: [personalRepository("901", "globex/shared", "read")],
    });
    const second = await renderComponent(createElement(RepositoryContextMenuBody, readOnly.props));
    await actRun(() => switchFor(second.container, "Select globex/shared")!.click());
    expect(readOnly.calls).toEqual(["app:globex/shared"]);
    await second.unmount();
  });

  test("switching who a selected repository acts as keeps its branch", async () => {
    const { props: picker, calls } = props({
      selectedRepoIds: new Set([sharedViaApp.id]),
      selectedRepoRefs: { [sharedViaApp.id]: "release" },
    });
    const rendered = await renderComponent(createElement(RepositoryContextMenuBody, picker));
    const choice = rendered.container.querySelector('[aria-label="globex/shared acts as"]');
    expect(choice).toBeTruthy();
    const option = (label: string) =>
      [...choice!.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === label,
      );
    expect(option("Opengeni app")?.getAttribute("aria-checked")).toBe("true");
    await actRun(() => option("You (@octocat)")!.click());
    expect(calls).toEqual(["personal-ref:901:release", "personal:Globex/Shared"]);
    await rendered.unmount();

    const asYou = props({
      selectedPersonalGitHubRepoIds: new Set([sharedViaYou.repositoryId]),
      selectedPersonalGitHubRepoRefs: { [sharedViaYou.repositoryId]: "feature" },
    });
    const second = await renderComponent(createElement(RepositoryContextMenuBody, asYou.props));
    const appOption = [
      ...second.container.querySelectorAll<HTMLButtonElement>(
        '[aria-label="globex/shared acts as"] button',
      ),
    ].find((button) => button.textContent === "Opengeni app");
    await actRun(() => appOption!.click());
    expect(asYou.calls).toEqual([`app-ref:${sharedViaApp.id}:feature`, "app:globex/shared"]);
    await second.unmount();
  });

  test("a search with no match keeps the list's own empty state and footer", async () => {
    const { props: picker } = props({
      status: "unbound",
      repositories: [],
      groups: [],
      personalGitHubRepositories: [personalOnly],
      onTogglePersonalGitHubRepo: undefined,
    });
    const rendered = await renderComponent(
      createElement(RepositoryContextMenuBody, {
        ...picker,
        // More than five rows show the search box.
        personalGitHubRepositories: Array.from({ length: 6 }, (_, index) =>
          personalRepository(String(800 + index), `octocat/repo-${index}`),
        ),
      }),
    );
    // Without a personal toggle, personal rows cannot be switched on.
    expect(switchFor(rendered.container, "Select octocat/repo-0")?.disabled).toBe(true);
    const search = rendered.container.querySelector<HTMLInputElement>(
      'input[aria-label="Search repositories"]',
    )!;
    await actRun(() => search.focus());
    await actRun(() => {
      const setValue = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(search) as HTMLInputElement,
        "value",
      )!.set!;
      setValue.call(search, "nothing-matches");
      // React may have loaded before the DOM was registered, so it can be
      // watching key events instead of input events for value changes.
      for (const type of ["input", "keyup"])
        search.dispatchEvent(new Event(type, { bubbles: true }));
    });
    const text = rendered.container.textContent ?? "";
    expect(text).toContain("No repositories match your search.");
    expect(text).not.toContain("No repositories connected");
    // The access entries stay behind the footer instead of jumping inline.
    expect(text).toContain("GitHub access");
    expect(text).not.toContain("Your GitHub");
    await rendered.unmount();
  });

  test("GitHub access lists your GitHub and the Opengeni app", async () => {
    const { props: picker, calls } = props({
      githubAppOpen: true,
      installations: [
        {
          installationId: 100,
          accountLogin: "acme",
          lifecycle: "active",
          repositoryScope: "selected",
          repositoryCount: 2,
          configureUrl: null,
        } as unknown as GitHubInstallationBinding,
      ],
    });
    const rendered = await renderComponent(createElement(RepositoryContextMenuBody, picker));
    const text = rendered.container.textContent ?? "";
    expect(text).toContain("GitHub access");
    expect(text).not.toContain("Connected GitHub accounts");
    expect(text).toContain("Your GitHub");
    expect(text).toContain("@octocat · 2 repos");
    expect(
      rendered.container.querySelector<HTMLAnchorElement>(
        "a[href='/workspaces/w/plugins?open=integration:github']",
      )?.textContent,
    ).toBe("Choose repos");
    expect(text).toContain("Opengeni app");
    expect(text).toContain("acme");
    const install = [...rendered.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Install on another account",
    );
    await actRun(() => install!.click());
    expect(calls).toEqual(["install-app"]);
    await rendered.unmount();

    const disconnected = props({
      githubAppOpen: true,
      personalGitHubStatus: { enabled: true, connection: null, reviewUrl: null } as never,
      personalGitHubRepositories: [],
    });
    const second = await renderComponent(
      createElement(RepositoryContextMenuBody, disconnected.props),
    );
    expect(second.container.textContent).toContain(
      "Connect your GitHub – work appears under your name",
    );
    const connect = [...second.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Connect",
    );
    await actRun(() => connect!.click());
    expect(disconnected.calls).toEqual(["connect-personal"]);
    await second.unmount();
  });
});
