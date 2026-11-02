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
      connectLabel: "Install",
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

  test("projects bound-empty as healthy with plain copy", () => {
    const presentation = repositoryBindingPresentation(
      "bound",
      "https://api.opengeni.test/github/connect",
    );
    expect(presentation).toMatchObject({
      connectLabel: "Install on another account",
      healthy: true,
      canRefresh: true,
    });
    expect(presentation.emptyDescription).toBe(
      "The Opengeni app is installed, but no repositories are shared with this workspace yet.",
    );
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
  test("install starts from a click, never a page-load link; managing goes to GitHub settings", async () => {
    const stale =
      "https://api.opengeni.test/v1/workspaces/workspace/github/connect?state=minted-at-load";
    let connects = 0;
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
        onOrgChange: () => {},
        onStartGitHubApp: () => {},
        onConnectWorkspaceApp: () => {
          connects += 1;
        },
        githubSettingsUrl: "/workspaces/workspace/plugins?open=integration:github",
      }),
    );
    // No anchor may carry a signed state captured when the page loaded.
    expect(
      [...rendered.container.querySelectorAll("a")].filter((anchor) =>
        anchor.getAttribute("href")?.includes("state="),
      ),
    ).toEqual([]);

    const buttons = () => [...rendered.container.querySelectorAll<HTMLButtonElement>("button")];
    expect(rendered.container.textContent).toContain("Connect GitHub to pick repositories.");
    const connect = buttons().find((button) => button.textContent === "Install");
    expect(connect).toBeTruthy();
    await actRun(() => connect!.click());
    expect(connects).toBe(1);

    // A stored installation is managed on the GitHub settings page, not in the picker.
    const manage = [...rendered.container.querySelectorAll("a")].find(
      (anchor) => anchor.textContent === "Manage GitHub access",
    );
    expect(manage?.getAttribute("href")).toBe(
      "/workspaces/workspace/plugins?open=integration:github",
    );
    expect(rendered.container.textContent).not.toContain("octo-org");
    expect(buttons().some((button) => /Unlink|Repositories/.test(button.textContent ?? ""))).toBe(
      false,
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
      onOrgChange: () => {},
      onStartGitHubApp: () => {},
      onConnectWorkspaceApp: () => {},
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
        onOrgChange: () => {},
        onStartGitHubApp: () => {},
        onConnectWorkspaceApp: () => {},
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
        onOrgChange: () => {},
        onStartGitHubApp: () => {},
        onConnectWorkspaceApp: () => {},
      }),
    );

    const mounted = rendered.container.querySelector<HTMLButtonElement>(
      'button[aria-label="example/app in this chat"]',
    );
    expect(mounted?.getAttribute("aria-disabled")).toBe("true");
    expect(mounted?.getAttribute("aria-checked")).toBe("true");
    expect(rendered.container.textContent).toContain("In chat");
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
      onOrgChange: () => {},
      onStartGitHubApp: () => {},
      onConnectWorkspaceApp: () => {},
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
      'button[aria-label="octocat/private-repository in this chat as you"]',
    );
    expect(row?.getAttribute("aria-disabled")).toBe("true");
    expect(mounted.container.textContent).toContain("In chat");
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
    expect(body.container.textContent).toContain("In chat");
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
      'button[aria-label="https://example.test/repo.git in this chat"]',
    );
    expect(manualSwitch?.getAttribute("aria-checked")).toBe("true");
    expect(manualSwitch?.getAttribute("aria-disabled")).toBe("true");
    expect(manual.container.textContent).toContain("release");
    expect(manual.container.textContent).toContain("No longer shared");
    expect(
      manual.container
        .querySelector('button[aria-label="https://github.com/removed/personal.git in this chat"]')
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
      org: "",
      pending: false,
      repoBusy: false,
      githubAppBusy: false,
      personalGitHubManageUrl: "/workspaces/w/plugins?open=integration:github&github=personal",
      githubSettingsUrl: "/workspaces/w/plugins?open=integration:github",
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
      onOrgChange: () => {},
      onStartGitHubApp: () => {},
      onConnectWorkspaceApp: () => calls.push("install-app"),
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
    // With your GitHub connected, every selected row says who it acts as;
    // only a repository reachable both ways offers a choice.
    expect(text).not.toContain("As you");
    expect(text.match(/Acts as/g)).toHaveLength(3);
    expect(text).toContain("Acts asYou (@octocat)");
    expect(text).toContain("Acts asOpengeni app");
    expect(rendered.container.querySelector('[aria-label="octocat/dotfiles acts as"]')).toBeNull();
    // A selected row shows its branch once, in the branch field.
    expect(text).not.toContain("release");
    await rendered.unmount();

    // Without your GitHub there is one identity, so nothing to explain.
    const appOnly = props({
      personalGitHubStatus: { enabled: true, connection: null, reviewUrl: null } as never,
      personalGitHubRepositories: [],
      selectedRepoIds: new Set([acmeApi.id]),
    });
    const second = await renderComponent(createElement(RepositoryContextMenuBody, appOnly.props));
    expect(second.container.textContent).not.toContain("Acts as");
    await second.unmount();
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
    // Account setup stays behind the settings link instead of jumping inline.
    expect(text).toContain("Manage GitHub access");
    expect(text).not.toContain("Your GitHub");
    await rendered.unmount();
  });

  test("account management sits behind one Manage GitHub access link", async () => {
    const { props: picker, calls } = props({
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
    expect(
      rendered.container.querySelector<HTMLAnchorElement>(
        "a[href='/workspaces/w/plugins?open=integration:github']",
      )?.textContent,
    ).toBe("Manage GitHub access");
    // The old "GitHub access" disclosure and its account rows are gone.
    expect(text.replace("Manage GitHub access", "")).not.toContain("GitHub access");
    for (const removed of [
      "Your GitHub",
      "Install on another account",
      "workspace repositories",
      "Choose repos",
    ]) {
      expect(text).not.toContain(removed);
    }
    expect(
      [...rendered.container.querySelectorAll("button")].some((button) =>
        /^(Unlink|Repositories)$/.test(
          button.getAttribute("aria-label") ?? button.textContent ?? "",
        ),
      ),
    ).toBe(false);
    expect(calls).toEqual([]);
    await rendered.unmount();

    const disconnected = props({
      personalGitHubStatus: { enabled: true, connection: null, reviewUrl: null } as never,
      personalGitHubRepositories: [],
    });
    const second = await renderComponent(
      createElement(RepositoryContextMenuBody, disconnected.props),
    );
    // With repositories to pick, connecting your GitHub is a settings task too.
    expect(second.container.textContent).not.toContain("Your GitHub");
    expect(second.container.textContent).toContain("Manage GitHub access");
    await second.unmount();
  });

  test("with nothing to pick, both ways to connect are offered in plain words", async () => {
    const first = props({
      status: "unbound",
      repositories: [],
      groups: [],
      personalGitHubStatus: { enabled: true, connection: null, reviewUrl: null } as never,
      personalGitHubRepositories: [],
    });
    const rendered = await renderComponent(createElement(RepositoryContextMenuBody, first.props));
    const text = rendered.container.textContent ?? "";
    expect(text).toContain("Connect GitHub to pick repositories.");
    expect(text).toContain("Your GitHubWork appears under your name.");
    expect(text).toContain(
      "Opengeni appWork appears as the Opengeni bot, shared with the workspace.",
    );
    // Nothing is connected yet: no settings link and no list to refresh.
    expect(text).not.toContain("Manage GitHub access");
    expect(text).not.toContain("Refresh list");
    expect(text).not.toContain("No repositories connected");
    const button = (label: string) =>
      [...rendered.container.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent === label,
      );
    await actRun(() => button("Connect")!.click());
    await actRun(() => button("Install")!.click());
    expect(first.calls).toEqual(["connect-personal", "install-app"]);
    await rendered.unmount();

    // Your GitHub connected without chosen repositories: choose them next.
    const chooseNext = props({
      status: "unbound",
      repositories: [],
      groups: [],
      personalGitHubRepositories: [],
    });
    const second = await renderComponent(
      createElement(RepositoryContextMenuBody, chooseNext.props),
    );
    expect(second.container.textContent).toContain("@octocat · 0 repos");
    expect(
      second.container.querySelector<HTMLAnchorElement>(
        "a[href='/workspaces/w/plugins?open=integration:github&github=personal']",
      )?.textContent,
    ).toBe("Choose repos");
    expect(second.container.textContent).toContain("Manage GitHub access");
    expect(second.container.textContent).toContain("Refresh list");
    await second.unmount();

    // A member who can't install sees why instead of a dead button.
    const member = props({
      status: "unbound",
      installUrl: null,
      repositories: [],
      groups: [],
      personalGitHubStatus: { enabled: true, connection: null, reviewUrl: null } as never,
      personalGitHubRepositories: [],
    });
    const third = await renderComponent(createElement(RepositoryContextMenuBody, member.props));
    expect(third.container.textContent).toContain("A workspace admin can install it.");
    expect(
      [...third.container.querySelectorAll("button")].some(
        (candidate) => candidate.textContent === "Install",
      ),
    ).toBe(false);
    await third.unmount();
  });
});

describe("repository picker in a follow-up chat", () => {
  test("says how to change a repository already in the chat, in plain words", async () => {
    const repository: GitHubRepository = {
      id: 7,
      installationId: 1,
      fullName: "acme/app",
      name: "app",
      private: true,
      htmlUrl: "https://github.com/acme/app",
      cloneUrl: "https://github.com/acme/app.git",
      defaultBranch: "main",
      accountLogin: "acme",
      accountType: "Organization",
    };
    const removals: string[] = [];
    const rendered = await renderComponent(
      createElement(FollowUpRepositoryMenuBody, {
        setupMode: "platform",
        configured: true,
        status: "bound",
        installUrl: null,
        linkUrl: null,
        installations: [],
        repositories: [repository],
        groups: groupRepositories([repository]),
        selectedRepoIds: new Set([repository.id]),
        selectedRepoRefs: { [repository.id]: "main" },
        lockedRepoIds: new Set([repository.id]),
        manualRepos: [],
        manualOpen: false,
        org: "",
        pending: false,
        repoBusy: false,
        githubAppBusy: false,
        newChatUrl: "/workspaces/w",
        onRemoveMountedRepository: (target) => removals.push(target.kind),
        onRefresh: async () => {},
        onToggleRepo: () => {},
        onRefChange: () => {},
        onManualOpenChange: () => {},
        onManualAdd: () => {},
        onManualUpdate: () => {},
        onManualRemove: () => {},
        onOrgChange: () => {},
        onStartGitHubApp: () => {},
        onConnectWorkspaceApp: () => {},
      }),
    );
    const text = rendered.container.textContent ?? "";
    expect(text).toContain("In chat");
    expect(text).toContain(
      "To change the branch of a repository already in this chat, start a new chat.",
    );
    expect(text).not.toMatch(/[Mm]ounted|retarget/);
    expect(rendered.container.querySelector("a[href='/workspaces/w']")?.textContent).toBe(
      "start a new chat",
    );
    const row = rendered.container.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="acme/app in this chat"]',
    );
    await actRun(() => row!.click());
    expect(removals).toEqual(["app"]);
    await rendered.unmount();
  });
});
