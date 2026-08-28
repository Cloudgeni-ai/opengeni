import { describe, expect, test } from "bun:test";
import { createElement } from "react";

import { FollowUpRepositoryMenuBody } from "@/components/follow-up-repository-picker";
import {
  RepositoryContextPicker,
  repositoryBindingPresentation,
} from "@/components/repository-picker";
import { registerDom, renderComponent } from "../../../packages/react/test/render-hook";
import type {
  GitHubRepository,
  PersonalGitHubConnectionStatusResponse,
  PersonalGitHubRepositoryCatalogItem,
} from "@/types";

registerDom();

describe("repository picker GitHub binding status", () => {
  test("projects configured-but-unbound as actionable and never healthy", () => {
    const url = "https://api.opengeni.test/v1/workspaces/workspace/github/connect?state=fresh";
    const presentation = repositoryBindingPresentation("unbound", url);
    expect(presentation).toMatchObject({
      connectUrl: url,
      connectLabel: "Connect GitHub",
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
      connectLabel: "Install or connect GitHub",
      healthy: false,
      canRefresh: false,
    });
    expect(presentation.setupDescription).toContain("Install OpenGeni");
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
      connectLabel: "Configure another installation",
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
        selectedInstallationId: repository.installationId,
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
        selectedInstallationId: repository.installationId,
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
        onDisconnectInstallation: async () => {},
      }),
    );

    const mounted = rendered.container.querySelector<HTMLButtonElement>(
      'button[aria-label="example/app mounted"]',
    );
    expect(mounted?.disabled).toBe(true);
    expect(rendered.container.textContent).toContain("Mounted");
    expect(
      rendered.container.querySelector<HTMLInputElement>('input[aria-label="example/app ref"]')
        ?.disabled,
    ).toBe(true);
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
      selectedInstallationId: null,
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
    expect(row?.disabled).toBe(true);
    expect(mounted.container.textContent).toContain("@octocat");
    expect(mounted.container.textContent).toContain("Mounted");
    await mounted.unmount();
  });
});
