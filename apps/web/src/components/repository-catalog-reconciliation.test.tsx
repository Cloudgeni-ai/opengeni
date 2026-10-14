// OPE-804: a new-task draft restored while the GitHub catalog is still loading
// must not end up with the same repository attached twice. This drives the
// production repository picker and the catalog reconciliation hook together:
// restore -> catalog arrives -> picker shows the repository selected -> one
// attachment.

import { describe, expect, test } from "bun:test";
import { createElement, useState } from "react";

import { RepositoryContextMenuBody } from "@/components/repository-picker";
import {
  buildResources,
  groupRepositories,
  rehydrateRepositoryResources,
  repositorySelectionFromResources,
  type RepoDraft,
} from "@/lib/session-tools";
import { useManualRepositoryCatalogReconciliation } from "@/lib/use-manual-repository-catalog-reconciliation";
import type { GitHubRepository, ResourceRef } from "@/types";
import {
  actRun,
  flush,
  registerDom,
  renderComponent,
} from "../../../../packages/react/test/render-hook";

registerDom();

const opengeni: GitHubRepository = {
  id: 1212552738,
  installationId: 143685771,
  fullName: "Cloudgeni-ai/opengeni",
  name: "opengeni",
  private: true,
  htmlUrl: "https://github.com/Cloudgeni-ai/opengeni",
  cloneUrl: "https://github.com/Cloudgeni-ai/opengeni.git",
  defaultBranch: "main",
  accountLogin: "Cloudgeni-ai",
  accountType: "Organization",
};
const benchmarks: GitHubRepository = {
  ...opengeni,
  id: 1419642237,
  fullName: "Cloudgeni-ai/agent-benchmarks",
  name: "agent-benchmarks",
  htmlUrl: "https://github.com/Cloudgeni-ai/agent-benchmarks",
  cloneUrl: "https://github.com/Cloudgeni-ai/agent-benchmarks.git",
};

const savedDraftResources: ResourceRef[] = [
  {
    kind: "repository",
    uri: benchmarks.cloneUrl,
    ref: "main",
    mountPath: "repos/github.com/Cloudgeni-ai/agent-benchmarks",
    provider: "github",
    githubRepositoryId: benchmarks.id,
    githubInstallationId: benchmarks.installationId,
  },
  {
    kind: "repository",
    uri: opengeni.cloneUrl,
    ref: "main",
    mountPath: "repos/github.com/Cloudgeni-ai/opengeni",
    provider: "github",
    githubRepositoryId: opengeni.id,
    githubInstallationId: opengeni.installationId,
  },
];

type HarnessProps = {
  catalogReady: boolean;
  repositories: GitHubRepository[];
  initialManualRepos: RepoDraft[];
  initialSelectedRepoIds: Set<number>;
  initialSelectedRepoRefs: Record<number, string>;
  onResources: (resources: ResourceRef[]) => void;
};

/** The composer's repository state owner, reduced to the picker contract. */
function ComposerRepositories(props: HarnessProps) {
  const [manualRepos, setManualRepos] = useState(props.initialManualRepos);
  const [selectedRepoIds, setSelectedRepoIds] = useState(props.initialSelectedRepoIds);
  const [selectedRepoRefs, setSelectedRepoRefs] = useState(props.initialSelectedRepoRefs);
  useManualRepositoryCatalogReconciliation({
    manualRepos,
    selectedRepoIds,
    selectedRepoRefs,
    repositories: props.repositories,
    catalogReady: props.catalogReady,
    setManualRepos,
    setSelectedRepoIds,
    setSelectedRepoRefs,
  });
  props.onResources(
    buildResources(manualRepos, props.repositories, selectedRepoIds, selectedRepoRefs),
  );
  return createElement(RepositoryContextMenuBody, {
    setupMode: "platform",
    configured: true,
    status: "bound",
    installUrl: null,
    linkUrl: null,
    installations: [],
    repositories: props.repositories,
    groups: groupRepositories(props.repositories),
    selectedRepoIds,
    selectedRepoRefs,
    selectedInstallationId:
      props.repositories.find((repo) => selectedRepoIds.has(repo.id))?.installationId ?? null,
    manualRepos,
    manualOpen: true,
    githubAppOpen: false,
    org: "",
    pending: false,
    repoBusy: !props.catalogReady,
    githubAppBusy: false,
    onRefresh: async () => {},
    onToggleRepo: (repo) =>
      setSelectedRepoIds((current) => {
        const next = new Set(current);
        if (next.has(repo.id)) next.delete(repo.id);
        else next.add(repo.id);
        return next;
      }),
    onRefChange: (repoId, ref) => setSelectedRepoRefs((current) => ({ ...current, [repoId]: ref })),
    onManualOpenChange: () => {},
    onManualAdd: () => {},
    onManualUpdate: () => {},
    onManualRemove: (id) => setManualRepos((current) => current.filter((repo) => repo.id !== id)),
    onGitHubAppOpenChange: () => {},
    onOrgChange: () => {},
    onStartGitHubApp: () => {},
    onConnectWorkspaceApp: () => {},
    onConfigureInstallation: async () => {},
    onDisconnectInstallation: async () => {},
  });
}

function switchFor(container: HTMLElement, fullName: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    `button[role="switch"][aria-label="Select ${fullName}"]`,
  );
}

describe("repository picker catalog reconciliation (OPE-804)", () => {
  test("a draft restored before the catalog loads shows the repository selected once", async () => {
    // Draft hydration runs while the GitHub catalog is unknown.
    const restored = repositorySelectionFromResources(
      rehydrateRepositoryResources(savedDraftResources, [], { catalogReady: false }),
      [],
    );
    let resources: ResourceRef[] = [];
    const props = (catalogReady: boolean): HarnessProps => ({
      catalogReady,
      repositories: catalogReady ? [benchmarks, opengeni] : [],
      initialManualRepos: restored.manualRepos,
      initialSelectedRepoIds: restored.selectedRepoIds,
      initialSelectedRepoRefs: restored.selectedRepoRefs,
      onResources: (next) => {
        resources = next;
      },
    });
    const rendered = await renderComponent(createElement(ComposerRepositories, props(false)));
    // While loading, the restored draft still autosaves the same bound resources.
    expect(resources).toEqual(savedDraftResources);

    await rendered.rerender(createElement(ComposerRepositories, props(true)));
    await flush();

    expect(switchFor(rendered.container, opengeni.fullName)?.getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(switchFor(rendered.container, benchmarks.fullName)?.getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(rendered.container.textContent).not.toContain(opengeni.cloneUrl);
    expect(resources).toEqual(savedDraftResources);
    await rendered.unmount();
  });

  test("selecting a repository whose URL was added manually leaves one attachment", async () => {
    let resources: ResourceRef[] = [];
    const rendered = await renderComponent(
      createElement(ComposerRepositories, {
        catalogReady: true,
        repositories: [opengeni],
        // A same-ref manual URL that was attached before the catalog was known.
        initialManualRepos: [{ id: 1, url: opengeni.htmlUrl, ref: "main", attached: true }],
        initialSelectedRepoIds: new Set<number>(),
        initialSelectedRepoRefs: {},
        onResources: (next) => {
          resources = next;
        },
      }),
    );
    await flush();
    const toggle = switchFor(rendered.container, opengeni.fullName)!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(resources).toEqual([savedDraftResources[1]!]);

    // Unselect and select again: still exactly one attachment, never two.
    await actRun(() => toggle.click());
    expect(resources).toEqual([]);
    await actRun(() => switchFor(rendered.container, opengeni.fullName)!.click());
    await flush();
    expect(resources).toEqual([savedDraftResources[1]!]);
    await rendered.unmount();
  });
});
