import { mergeResourceRefs } from "@opengeni/contracts";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import type { RepositoryContextPickerProps } from "@/components/repository-picker";
import { useAppContext } from "@/context";
import {
  buildAdditionalRepositoryResources,
  repositorySelectionFromResources,
  type RepoDraft,
} from "@/lib/session-tools";
import type { GitHubRepository, ResourceRef, Session } from "@/types";

/**
 * Session-scoped repository additions for the follow-up composer. Session
 * resources are additive, so accepted resources become locked while only the
 * not-yet-sent selection remains editable.
 */
export function useFollowUpRepositories(session: Session): {
  pendingResources: ResourceRef[];
  error: string | null;
  selectionCount: number;
  pickerProps: (disabled: boolean) => RepositoryContextPickerProps;
  commitSent: (resources: ResourceRef[]) => void;
} {
  const context = useAppContext();
  const [pendingRepoIds, setPendingRepoIds] = useState<Set<number>>(() => new Set());
  const [pendingRepoRefs, setPendingRepoRefs] = useState<Record<number, string>>({});
  const [pendingManualRepos, setPendingManualRepos] = useState<RepoDraft[]>([]);
  const [manualReposOpen, setManualReposOpen] = useState(false);
  const [optimisticMountedRepos, setOptimisticMountedRepos] = useState<ResourceRef[]>([]);
  const nextManualRepoId = useRef(1);

  const mountedResources = useMemo(
    () => mergeResourceRefs(session.resources, optimisticMountedRepos),
    [optimisticMountedRepos, session.resources],
  );
  const mountedRepositoryResources = useMemo(
    () => mountedResources.filter((resource) => resource.kind === "repository"),
    [mountedResources],
  );
  const mountedRepositorySelection = useMemo(
    () => repositorySelectionFromResources(mountedRepositoryResources, context.githubRepos),
    [context.githubRepos, mountedRepositoryResources],
  );
  const mountedManualRepos = useMemo(
    () =>
      mountedRepositorySelection.manualRepos.map((repo, index) => ({
        ...repo,
        id: -(index + 1),
      })),
    [mountedRepositorySelection.manualRepos],
  );
  const lockedManualRepoIds = useMemo(
    () => new Set(mountedManualRepos.map((repo) => repo.id)),
    [mountedManualRepos],
  );
  const selectedRepoIds = useMemo(
    () => new Set([...mountedRepositorySelection.selectedRepoIds, ...pendingRepoIds]),
    [mountedRepositorySelection.selectedRepoIds, pendingRepoIds],
  );
  const selectedRepoRefs = useMemo(
    () => ({ ...mountedRepositorySelection.selectedRepoRefs, ...pendingRepoRefs }),
    [mountedRepositorySelection.selectedRepoRefs, pendingRepoRefs],
  );
  const selectedInstallationId = useMemo(
    () =>
      context.githubRepos.find((repository) => selectedRepoIds.has(repository.id))
        ?.installationId ?? null,
    [context.githubRepos, selectedRepoIds],
  );
  const pendingBuild = useMemo(() => {
    try {
      return {
        resources: buildAdditionalRepositoryResources({
          mountedResources,
          manualRepos: pendingManualRepos,
          repositories: context.githubRepos,
          selectedRepoIds: pendingRepoIds,
          selectedRepoRefs: pendingRepoRefs,
        }),
        error: null,
      };
    } catch (error) {
      return {
        resources: [] as ResourceRef[],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, [context.githubRepos, mountedResources, pendingManualRepos, pendingRepoIds, pendingRepoRefs]);
  const selectionCount =
    selectedRepoIds.size +
    [...mountedManualRepos, ...pendingManualRepos].filter((repo) => repo.url.trim().length > 0)
      .length;

  const togglePendingRepository = useCallback(
    (repo: GitHubRepository) => {
      if (mountedRepositorySelection.selectedRepoIds.has(repo.id)) return;
      if (
        selectedInstallationId !== null &&
        selectedInstallationId !== repo.installationId &&
        !pendingRepoIds.has(repo.id)
      ) {
        toast.info("This session uses one GitHub token", {
          description: "Clear pending repositories to choose repositories from another account.",
        });
        return;
      }
      setPendingRepoIds((current) => {
        const next = new Set(current);
        if (next.has(repo.id)) next.delete(repo.id);
        else next.add(repo.id);
        return next;
      });
      setPendingRepoRefs((current) => ({
        ...current,
        [repo.id]: current[repo.id] ?? repo.defaultBranch,
      }));
    },
    [mountedRepositorySelection.selectedRepoIds, pendingRepoIds, selectedInstallationId],
  );

  const disconnectRepositoryInstallation = useCallback(
    async (installationId: number) => {
      const removedIds = new Set(
        context.githubRepos
          .filter((repository) => repository.installationId === installationId)
          .map((repository) => repository.id),
      );
      setPendingRepoIds(
        (current) => new Set([...current].filter((repositoryId) => !removedIds.has(repositoryId))),
      );
      setPendingRepoRefs((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([repositoryId]) => !removedIds.has(Number(repositoryId))),
        ),
      );
      await context.disconnectGitHubInstallation(session.workspaceId, installationId);
    },
    [context, session.workspaceId],
  );

  const pickerProps = useCallback(
    (disabled: boolean): RepositoryContextPickerProps => ({
      setupMode:
        context.githubStatus?.setupMode ??
        (context.clientConfig.productAccessMode === "managed" ? "platform" : "operator"),
      configured: context.githubStatus?.configured === true,
      status: context.githubStatus?.status ?? "disabled",
      installUrl: context.githubStatus?.installUrl ?? null,
      linkUrl: context.githubStatus?.linkUrl ?? null,
      installations: context.githubStatus?.installations ?? [],
      repositories: context.githubRepos,
      groups: context.repositoryGroups,
      selectedRepoIds,
      selectedRepoRefs,
      selectedInstallationId,
      manualRepos: [...mountedManualRepos, ...pendingManualRepos],
      manualOpen: manualReposOpen,
      githubAppOpen: context.githubAppOpen,
      org: context.githubOrg,
      pending: disabled || context.busy,
      repoBusy: context.repoBusy,
      githubAppBusy: context.githubAppBusy,
      lockedRepoIds: mountedRepositorySelection.selectedRepoIds,
      lockedManualRepoIds,
      validationError: pendingBuild.error,
      onRefresh: () => context.refreshGitHub(session.workspaceId, undefined, { sync: true }),
      onToggleRepo: togglePendingRepository,
      onRefChange: (repoId, ref) =>
        setPendingRepoRefs((current) => ({ ...current, [repoId]: ref })),
      onManualOpenChange: setManualReposOpen,
      onManualAdd: () => {
        const id = nextManualRepoId.current++;
        setPendingManualRepos((current) => [...current, { id, url: "", ref: "main" }]);
        setManualReposOpen(true);
      },
      onManualUpdate: (id, patch) =>
        setPendingManualRepos((current) =>
          current.map((repo) => (repo.id === id ? { ...repo, ...patch } : repo)),
        ),
      onManualRemove: (id) =>
        setPendingManualRepos((current) => current.filter((repo) => repo.id !== id)),
      onGitHubAppOpenChange: context.setGithubAppOpen,
      onOrgChange: context.setGithubOrg,
      onStartGitHubApp: () => void context.startGitHubAppManifestFlow(session.workspaceId),
      onDisconnectInstallation: disconnectRepositoryInstallation,
    }),
    [
      context,
      disconnectRepositoryInstallation,
      lockedManualRepoIds,
      manualReposOpen,
      mountedManualRepos,
      mountedRepositorySelection.selectedRepoIds,
      pendingBuild.error,
      pendingManualRepos,
      selectedInstallationId,
      selectedRepoIds,
      selectedRepoRefs,
      session.workspaceId,
      togglePendingRepository,
    ],
  );

  const commitSent = useCallback((resources: ResourceRef[]) => {
    const repositories = resources.filter(
      (resource): resource is Extract<ResourceRef, { kind: "repository" }> =>
        resource.kind === "repository",
    );
    if (repositories.length === 0) return;
    setOptimisticMountedRepos((current) => mergeResourceRefs(current, repositories));
    // The picker is disabled during delivery, so every pending selection belongs
    // to the immutable wire input accepted by this callback.
    setPendingRepoIds(new Set());
    setPendingRepoRefs({});
    setPendingManualRepos([]);
  }, []);

  return {
    pendingResources: pendingBuild.resources,
    error: pendingBuild.error,
    selectionCount,
    pickerProps,
    commitSent,
  };
}
