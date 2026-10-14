// OPE-804: a new-task draft restored while the GitHub catalog is still loading
// must not end up with the same repository attached twice. This drives the
// production repository picker and the catalog reconciliation hook together:
// restore -> catalog arrives -> picker shows the repository selected -> one
// attachment.

import { describe, expect, test } from "bun:test";
import { createElement, useState } from "react";
import { flushSync } from "react-dom";

import { RepositoryContextMenuBody } from "@/components/repository-picker";
import { attachManualRepository } from "@/lib/manual-repositories";
import {
  buildResources,
  groupRepositories,
  rehydrateRepositoryResources,
  repositorySelectionFromResources,
  type RepoDraft,
} from "@/lib/session-tools";
import { useManualRepositoryCatalogReconciliation } from "@/lib/use-manual-repository-catalog-reconciliation";
import type { GitHubRepository, PersonalGitHubRepositoryCatalogItem, ResourceRef } from "@/types";
import {
  actRun,
  flush,
  registerDom,
  renderComponent,
  renderHook,
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
/** The same GitHub repository as `opengeni`, reachable through the user's personal GitHub. */
const personalOpengeni = {
  repositoryId: String(opengeni.id),
  fullName: opengeni.fullName,
  canonicalUrl: opengeni.htmlUrl,
  defaultBranch: "main",
  visibility: "private",
  private: true,
  archived: false,
  disabled: false,
  permissions: { pull: true, push: true, admin: false, maintain: false, triage: false },
  selectedAccess: "write",
} satisfies PersonalGitHubRepositoryCatalogItem;
const personalBindingId = "7f0c8f5e-2a51-4f40-9d8e-1c3e7b9a6d21";

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
  personalRepositories?: PersonalGitHubRepositoryCatalogItem[];
  initialSelectedPersonalRepoIds?: Set<string>;
  initialSelectedPersonalRepoRefs?: Record<string, string>;
  /** False when the picker menu is closed: its body, and any open editor, unmount. */
  pickerOpen?: boolean;
  onResources: (resources: ResourceRef[]) => void;
  onResourceError?: (error: string | null) => void;
};

/** The composer's repository state owner, reduced to the picker contract. */
function ComposerRepositories(props: HarnessProps) {
  const [manualRepos, setManualRepos] = useState(props.initialManualRepos);
  const [selectedRepoIds, setSelectedRepoIds] = useState(props.initialSelectedRepoIds);
  const [selectedRepoRefs, setSelectedRepoRefs] = useState(props.initialSelectedRepoRefs);
  const [selectedPersonalRepoIds] = useState(
    () => props.initialSelectedPersonalRepoIds ?? new Set<string>(),
  );
  const [selectedPersonalRepoRefs] = useState(() => props.initialSelectedPersonalRepoRefs ?? {});
  const personalRepositories = props.personalRepositories ?? [];
  useManualRepositoryCatalogReconciliation({
    manualRepos,
    selectedRepoIds,
    selectedRepoRefs,
    repositories: props.repositories,
    catalogReady: props.catalogReady,
    personalRepositories,
    selectedPersonalRepoIds,
    selectedPersonalRepoRefs,
    setManualRepos,
    setSelectedRepoIds,
    setSelectedRepoRefs,
  });
  try {
    props.onResources(
      buildResources(
        manualRepos,
        props.repositories,
        selectedRepoIds,
        selectedRepoRefs,
        personalRepositories,
        selectedPersonalRepoIds,
        selectedPersonalRepoRefs,
        personalBindingId,
      ),
    );
    props.onResourceError?.(null);
  } catch (error) {
    // The composer shows this as the picker's validation error and blocks Start.
    props.onResourceError?.(error instanceof Error ? error.message : String(error));
  }
  if (props.pickerOpen === false) return null;
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
    onManualUpdate: (id, patch) =>
      setManualRepos((current) =>
        current.map((repo) => (repo.id === id ? { ...repo, ...patch } : repo)),
      ),
    onManualRemove: (id) => setManualRepos((current) => current.filter((repo) => repo.id !== id)),
    onManualAttach: async (repository) =>
      await attachManualRepository({
        repository,
        workspaceRepositories: props.repositories,
        personalRepositories,
        selectWorkspaceRepository: (matched, ref) => {
          setSelectedRepoIds((current) => new Set(current).add(matched.id));
          setSelectedRepoRefs((current) => ({ ...current, [matched.id]: ref }));
        },
        selectPersonalRepository: () => {
          throw new Error("Personal selection is not exercised here.");
        },
        verifyPublicGitHubRepository: async () => {
          throw new Error("Public verification is not exercised here.");
        },
        attach: (attached) =>
          setManualRepos((current) =>
            current.map((candidate) => (candidate.id === attached.id ? attached : candidate)),
          ),
        remove: (id) =>
          setManualRepos((current) => current.filter((candidate) => candidate.id !== id)),
      }),
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

function buttonNamed(container: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === label,
    ) ?? null
  );
}

function inputNamed(container: HTMLElement, label: string): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
}

// happy-dom does not drive React's controlled-input tracker from dispatched
// events; set the DOM value and invoke the fiber's own onChange prop.
function typeInto(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  const reactPropsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
  const onChange = (
    input as unknown as Record<string, { onChange?: (event: { target: HTMLInputElement }) => void }>
  )[reactPropsKey!]!.onChange;
  onChange!({ target: input });
}

const noPersonalSelection = new Set<string>();

type CatalogProps = { catalogReady: boolean; repositories: GitHubRepository[] };

/** The composer's three repository states, restored before the catalog loads. */
async function renderOpengeniRestoredWhileCatalogLoads() {
  const restored = repositorySelectionFromResources(
    rehydrateRepositoryResources([savedDraftResources[1]!], [], { catalogReady: false }),
    [],
  );
  return await renderHook(
    (props: CatalogProps) => {
      const [manualRepos, setManualRepos] = useState(restored.manualRepos);
      const [selectedRepoIds, setSelectedRepoIds] = useState(restored.selectedRepoIds);
      const [selectedRepoRefs, setSelectedRepoRefs] = useState(restored.selectedRepoRefs);
      useManualRepositoryCatalogReconciliation({
        manualRepos,
        selectedRepoIds,
        selectedRepoRefs,
        repositories: props.repositories,
        catalogReady: props.catalogReady,
        personalRepositories: [],
        selectedPersonalRepoIds: noPersonalSelection,
        selectedPersonalRepoRefs: {},
        setManualRepos,
        setSelectedRepoIds,
        setSelectedRepoRefs,
      });
      return {
        manualRepos,
        selectedRepoIds,
        selectedRepoRefs,
        setManualRepos,
        setSelectedRepoIds,
        setSelectedRepoRefs,
      };
    },
    { catalogReady: false, repositories: [] } as CatalogProps,
  );
}

/**
 * Apply an update the way a click handler or fetch callback does in the
 * browser: synchronously, after the catalog-ready render committed and before
 * React runs that render's passive effects. Pair with rerenderThroughLayout;
 * assertions and cleanup return to `act`.
 */
function updateBeforePassiveEffects(update: () => void): void {
  const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    flushSync(update);
  } finally {
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
}

const sortedIds = (ids: Set<number>) => [...ids].sort((left, right) => left - right);

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

  test("a picker toggle right after the catalog arrives is kept", async () => {
    const hook = await renderOpengeniRestoredWhileCatalogLoads();
    expect(hook.result.current.manualRepos).toHaveLength(1);

    await hook.rerenderThroughLayout({ catalogReady: true, repositories: [benchmarks, opengeni] });
    updateBeforePassiveEffects(() =>
      hook.result.current.setSelectedRepoIds((current) => new Set(current).add(benchmarks.id)),
    );
    await flush();

    expect(hook.result.current.manualRepos).toEqual([]);
    expect(sortedIds(hook.result.current.selectedRepoIds)).toEqual(
      sortedIds(new Set([opengeni.id, benchmarks.id])),
    );
    expect(hook.result.current.selectedRepoRefs).toEqual({ [opengeni.id]: "main" });
    await hook.unmount();
  });

  test("a workspace reset right after the catalog arrives is kept", async () => {
    const hook = await renderOpengeniRestoredWhileCatalogLoads();

    await hook.rerenderThroughLayout({ catalogReady: true, repositories: [benchmarks, opengeni] });
    updateBeforePassiveEffects(() => {
      hook.result.current.setManualRepos([]);
      hook.result.current.setSelectedRepoIds(new Set());
      hook.result.current.setSelectedRepoRefs({});
    });
    await flush();

    expect(hook.result.current.manualRepos).toEqual([]);
    expect(sortedIds(hook.result.current.selectedRepoIds)).toEqual([]);
    expect(hook.result.current.selectedRepoRefs).toEqual({});
    await hook.unmount();
  });

  describe("an edit in progress on a restored row", () => {
    const restoredOpengeni = () =>
      repositorySelectionFromResources(
        rehydrateRepositoryResources([savedDraftResources[1]!], [], { catalogReady: false }),
        [],
      );
    const harness = (
      catalogReady: boolean,
      restored: ReturnType<typeof restoredOpengeni>,
      onResources: (resources: ResourceRef[]) => void,
      pickerOpen = true,
    ): HarnessProps => ({
      catalogReady,
      repositories: catalogReady ? [benchmarks, opengeni] : [],
      initialManualRepos: restored.manualRepos,
      initialSelectedRepoIds: restored.selectedRepoIds,
      initialSelectedRepoRefs: restored.selectedRepoRefs,
      pickerOpen,
      onResources,
    });

    test("survives the catalog finishing loading and attaches at the edited ref", async () => {
      const restored = restoredOpengeni();
      let resources: ResourceRef[] = [];
      const record = (next: ResourceRef[]) => {
        resources = next;
      };
      const rendered = await renderComponent(
        createElement(ComposerRepositories, harness(false, restored, record)),
      );
      await actRun(() => buttonNamed(rendered.container, "Edit")!.click());
      await actRun(() => typeInto(inputNamed(rendered.container, "Repository ref")!, "release"));

      await rendered.rerender(createElement(ComposerRepositories, harness(true, restored, record)));
      await flush();

      // The unsaved edit is still on screen and the saved attachment is unchanged.
      expect(inputNamed(rendered.container, "Repository ref")?.value).toBe("release");
      expect(inputNamed(rendered.container, "Repository URL")?.value).toBe(opengeni.cloneUrl);
      expect(resources).toEqual([savedDraftResources[1]!]);

      await actRun(() => buttonNamed(rendered.container, "Attach")!.click());
      await flush();

      expect(inputNamed(rendered.container, "Repository ref")).toBeNull();
      expect(switchFor(rendered.container, opengeni.fullName)?.getAttribute("aria-checked")).toBe(
        "true",
      );
      const opengeniAtMain = savedDraftResources[1] as Extract<ResourceRef, { kind: "repository" }>;
      expect(resources).toEqual([{ ...opengeniAtMain, ref: "release" }]);
      await rendered.unmount();
    });

    test("cancelling the edit lets the row reconcile into one selection", async () => {
      const restored = restoredOpengeni();
      let resources: ResourceRef[] = [];
      const record = (next: ResourceRef[]) => {
        resources = next;
      };
      const rendered = await renderComponent(
        createElement(ComposerRepositories, harness(false, restored, record)),
      );
      await actRun(() => buttonNamed(rendered.container, "Edit")!.click());
      await actRun(() => typeInto(inputNamed(rendered.container, "Repository ref")!, "release"));
      await rendered.rerender(createElement(ComposerRepositories, harness(true, restored, record)));
      await flush();
      expect(inputNamed(rendered.container, "Repository ref")?.value).toBe("release");

      await actRun(() => buttonNamed(rendered.container, "Cancel edit")!.click());
      await flush();

      expect(switchFor(rendered.container, opengeni.fullName)?.getAttribute("aria-checked")).toBe(
        "true",
      );
      expect(rendered.container.textContent).not.toContain(opengeni.cloneUrl);
      expect(resources).toEqual([savedDraftResources[1]!]);
      await rendered.unmount();
    });

    test("closing the editor without saving does not keep the row out of reconciliation", async () => {
      const restored = restoredOpengeni();
      let resources: ResourceRef[] = [];
      const record = (next: ResourceRef[]) => {
        resources = next;
      };
      const rendered = await renderComponent(
        createElement(ComposerRepositories, harness(false, restored, record)),
      );
      await actRun(() => buttonNamed(rendered.container, "Edit")!.click());
      await actRun(() => typeInto(inputNamed(rendered.container, "Repository ref")!, "release"));
      // The picker menu closes, unmounting the editor and its unsaved edit.
      await rendered.rerender(
        createElement(ComposerRepositories, harness(false, restored, record, false)),
      );
      await flush();
      await rendered.rerender(
        createElement(ComposerRepositories, harness(true, restored, record, false)),
      );
      await flush();
      await rendered.rerender(createElement(ComposerRepositories, harness(true, restored, record)));
      await flush();

      expect(switchFor(rendered.container, opengeni.fullName)?.getAttribute("aria-checked")).toBe(
        "true",
      );
      expect(resources).toEqual([savedDraftResources[1]!]);
      await rendered.unmount();
    });
  });

  describe("a repository also selected through personal GitHub", () => {
    const personalResource = () =>
      buildResources(
        [],
        [],
        new Set(),
        {},
        [personalOpengeni],
        new Set([personalOpengeni.repositoryId]),
        { [personalOpengeni.repositoryId]: "main" },
        personalBindingId,
      )[0]!;
    // The incident draft's bare third row: the same remote without provider or ids.
    const bareRow = (ref: string): RepoDraft => ({
      id: 3,
      url: opengeni.cloneUrl,
      ref,
      attached: true,
    });

    async function renderWithPersonal(manualRepos: RepoDraft[]) {
      let resources: ResourceRef[] = [];
      let error: string | null = null;
      const rendered = await renderComponent(
        createElement(ComposerRepositories, {
          catalogReady: true,
          repositories: [benchmarks, opengeni],
          initialManualRepos: manualRepos,
          initialSelectedRepoIds: new Set<number>(),
          initialSelectedRepoRefs: {},
          personalRepositories: [personalOpengeni],
          initialSelectedPersonalRepoIds: new Set([personalOpengeni.repositoryId]),
          initialSelectedPersonalRepoRefs: { [personalOpengeni.repositoryId]: "main" },
          onResources: (next) => {
            resources = next;
          },
          onResourceError: (next) => {
            error = next;
          },
        }),
      );
      await flush();
      return { rendered, resources: () => resources, error: () => error };
    }

    test("keeps the personal selection and attaches the repository once", async () => {
      const { rendered, resources, error } = await renderWithPersonal([bareRow("main")]);

      expect(error()).toBeNull();
      // Authority is never switched to the workspace App behind the user's back.
      expect(switchFor(rendered.container, opengeni.fullName)?.getAttribute("aria-checked")).toBe(
        "false",
      );
      expect(resources()).toEqual([personalResource()]);
      await rendered.unmount();
    });

    test("keeps a manual row at a different ref next to the personal selection", async () => {
      const { rendered, resources, error } = await renderWithPersonal([bareRow("release")]);

      expect(error()).toBeNull();
      expect(switchFor(rendered.container, opengeni.fullName)?.getAttribute("aria-checked")).toBe(
        "false",
      );
      expect(resources()).toEqual([
        personalResource(),
        {
          kind: "repository",
          uri: opengeni.cloneUrl,
          ref: "release",
          mountPath: "repos/github.com/Cloudgeni-ai/opengeni.git",
        },
      ]);
      await rendered.unmount();
    });
  });
});
