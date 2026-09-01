import { mergeResourceRefs } from "@opengeni/contracts";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import type { RepositoryContextPickerProps } from "@/components/repository-picker";
import { useAppContext } from "@/context";
import { attachManualRepository, attachedManualRepositoryCount } from "@/lib/manual-repositories";
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
  const [pendingPersonalRepoIds, setPendingPersonalRepoIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [pendingPersonalRepoRefs, setPendingPersonalRepoRefs] = useState<Record<string, string>>(
    {},
  );
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
  const mountedPersonalRepoIds = useMemo(
    () =>
      new Set(
        mountedRepositoryResources.flatMap((resource) =>
          resource.connectionType === "github_personal" && typeof resource.repositoryId === "string"
            ? [resource.repositoryId]
            : [],
        ),
      ),
    [mountedRepositoryResources],
  );
  const selectedPersonalRepoIds = useMemo(
    () => new Set([...mountedPersonalRepoIds, ...pendingPersonalRepoIds]),
    [mountedPersonalRepoIds, pendingPersonalRepoIds],
  );
  const selectedPersonalRepoRefs = useMemo(() => {
    const mounted = Object.fromEntries(
      mountedRepositoryResources.flatMap((resource) =>
        resource.connectionType === "github_personal"
          ? [[resource.repositoryId, resource.ref] as const]
          : [],
      ),
    );
    return { ...mounted, ...pendingPersonalRepoRefs };
  }, [mountedRepositoryResources, pendingPersonalRepoRefs]);
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
          personalRepositories: context.personalGitHubRepositories,
          selectedPersonalRepositoryIds: pendingPersonalRepoIds,
          selectedPersonalRepositoryRefs: pendingPersonalRepoRefs,
          personalCredentialBindingId: context.personalGitHubSelection?.credentialBindingId,
        }),
        error: null,
      };
    } catch (error) {
      return {
        resources: [] as ResourceRef[],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, [
    context.githubRepos,
    context.personalGitHubRepositories,
    context.personalGitHubSelection?.credentialBindingId,
    mountedResources,
    pendingManualRepos,
    pendingPersonalRepoIds,
    pendingPersonalRepoRefs,
    pendingRepoIds,
    pendingRepoRefs,
  ]);
  const selectionCount =
    selectedRepoIds.size +
    selectedPersonalRepoIds.size +
    attachedManualRepositoryCount([...mountedManualRepos, ...pendingManualRepos]);

  const togglePendingRepository = useCallback(
    (repo: GitHubRepository) => {
      if (mountedRepositorySelection.selectedRepoIds.has(repo.id)) return;
      const mountedPersonalConflict = context.personalGitHubRepositories.some(
        (personalRepo) =>
          mountedPersonalRepoIds.has(personalRepo.repositoryId) &&
          personalRepo.fullName === repo.fullName,
      );
      if (mountedPersonalConflict) {
        toast.info("This repository is already mounted as you");
        return;
      }
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
      const personalConflictIds = new Set(
        context.personalGitHubRepositories
          .filter((personalRepo) => personalRepo.fullName === repo.fullName)
          .map((personalRepo) => personalRepo.repositoryId),
      );
      setPendingPersonalRepoIds(
        (current) => new Set([...current].filter((id) => !personalConflictIds.has(id))),
      );
    },
    [
      context.personalGitHubRepositories,
      mountedPersonalRepoIds,
      mountedRepositorySelection.selectedRepoIds,
      pendingRepoIds,
      selectedInstallationId,
    ],
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

  const togglePendingPersonalRepository = useCallback(
    async (repo: (typeof context.personalGitHubRepositories)[number]) => {
      if (mountedPersonalRepoIds.has(repo.repositoryId)) return;
      if (pendingPersonalRepoIds.has(repo.repositoryId)) {
        setPendingPersonalRepoIds((current) => {
          const next = new Set(current);
          next.delete(repo.repositoryId);
          return next;
        });
        return;
      }
      if (!repo.selectedAccess) return;
      const mountedWorkspaceConflict = context.githubRepos.some(
        (workspaceRepo) =>
          mountedRepositorySelection.selectedRepoIds.has(workspaceRepo.id) &&
          workspaceRepo.fullName === repo.fullName,
      );
      if (mountedWorkspaceConflict) {
        toast.info("This repository is already mounted with the workspace GitHub App");
        return;
      }
      if (!(await context.ensurePersonalGitHubAuthority(session.workspaceId))) return;
      const workspaceConflictIds = new Set(
        context.githubRepos
          .filter((workspaceRepo) => workspaceRepo.fullName === repo.fullName)
          .map((workspaceRepo) => workspaceRepo.id),
      );
      setPendingRepoIds(
        (current) => new Set([...current].filter((id) => !workspaceConflictIds.has(id))),
      );
      setPendingPersonalRepoIds((current) => new Set(current).add(repo.repositoryId));
      setPendingPersonalRepoRefs((current) => ({
        ...current,
        [repo.repositoryId]: current[repo.repositoryId] ?? repo.defaultBranch,
      }));
    },
    [
      context,
      mountedPersonalRepoIds,
      mountedRepositorySelection.selectedRepoIds,
      pendingPersonalRepoIds,
      session.workspaceId,
    ],
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
      personalGitHubStatus: context.personalGitHubStatus,
      personalGitHubRepositories: context.personalGitHubRepositories,
      selectedPersonalGitHubRepoIds: selectedPersonalRepoIds,
      selectedPersonalGitHubRepoRefs: selectedPersonalRepoRefs,
      personalGitHubBusy: context.personalGitHubBusy,
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
      lockedPersonalGitHubRepoIds: mountedPersonalRepoIds,
      lockedManualRepoIds,
      validationError: pendingBuild.error,
      onRefresh: async () => {
        await Promise.all([
          context.refreshGitHub(session.workspaceId, undefined, { sync: true }),
          context.refreshPersonalGitHub(session.workspaceId),
        ]);
      },
      onConnectPersonalGitHub: () => void context.connectPersonalGitHub(session.workspaceId),
      onTogglePersonalGitHubRepo: (repo) => void togglePendingPersonalRepository(repo),
      onPersonalGitHubRefChange: (repositoryId, ref) =>
        setPendingPersonalRepoRefs((current) => ({ ...current, [repositoryId]: ref })),
      onToggleRepo: togglePendingRepository,
      onRefChange: (repoId, ref) =>
        setPendingRepoRefs((current) => ({ ...current, [repoId]: ref })),
      onLoadGitHubBranches: async (repository) =>
        (
          await context.client.listGitHubRepositoryBranches(
            session.workspaceId,
            repository.installationId,
            repository.id,
            { limit: 100 },
          )
        ).branches,
      onLoadPersonalGitHubBranches: async (repository) => {
        const connectionId = context.personalGitHubStatus?.connection?.id;
        if (!connectionId) throw new Error("Connect your GitHub identity to load branches.");
        return (
          await context.client.listPersonalGitHubRepositoryBranches(
            session.workspaceId,
            connectionId,
            repository.repositoryId,
            { limit: 100 },
          )
        ).branches;
      },
      onManualOpenChange: setManualReposOpen,
      onManualAdd: () => {
        const id = nextManualRepoId.current++;
        setPendingManualRepos((current) => [
          ...current,
          { id, url: "", ref: "main", attached: false },
        ]);
        setManualReposOpen(true);
      },
      onManualUpdate: (id, patch) =>
        setPendingManualRepos((current) =>
          current.map((repo) => (repo.id === id ? { ...repo, ...patch } : repo)),
        ),
      onManualRemove: (id) =>
        setPendingManualRepos((current) => current.filter((repo) => repo.id !== id)),
      onManualAttach: async (repository) =>
        await attachManualRepository({
          repository,
          workspaceRepositories: context.githubRepos,
          personalRepositories: context.personalGitHubRepositories,
          selectWorkspaceRepository: (matched, ref) => {
            const mountedPersonalConflict = context.personalGitHubRepositories.some(
              (candidate) =>
                mountedPersonalRepoIds.has(candidate.repositoryId) &&
                candidate.fullName.toLowerCase() === matched.fullName.toLowerCase(),
            );
            if (mountedPersonalConflict) {
              throw new Error("This repository is already mounted as your GitHub identity.");
            }
            const mountedInstallationId = context.githubRepos.find((candidate) =>
              mountedRepositorySelection.selectedRepoIds.has(candidate.id),
            )?.installationId;
            if (
              mountedInstallationId !== undefined &&
              mountedInstallationId !== matched.installationId
            ) {
              throw new Error(
                "This session already has repositories mounted from another App account.",
              );
            }
            setPendingRepoIds((current) => {
              const next =
                selectedInstallationId !== null && selectedInstallationId !== matched.installationId
                  ? new Set<number>()
                  : new Set(current);
              next.add(matched.id);
              return next;
            });
            setPendingRepoRefs((current) => ({ ...current, [matched.id]: ref }));
            setPendingPersonalRepoIds(
              (current) =>
                new Set(
                  [...current].filter(
                    (id) =>
                      context.personalGitHubRepositories
                        .find((candidate) => candidate.repositoryId === id)
                        ?.fullName.toLowerCase() !== matched.fullName.toLowerCase(),
                  ),
                ),
            );
          },
          selectPersonalRepository: async (matched, ref) => {
            const mountedWorkspaceConflict = context.githubRepos.some(
              (candidate) =>
                mountedRepositorySelection.selectedRepoIds.has(candidate.id) &&
                candidate.fullName.toLowerCase() === matched.fullName.toLowerCase(),
            );
            if (mountedWorkspaceConflict) {
              throw new Error("This repository is already mounted with the workspace App.");
            }
            if (!(await context.ensurePersonalGitHubAuthority(session.workspaceId))) {
              throw new Error("Your GitHub identity could not be authorized for this workspace.");
            }
            setPendingRepoIds(
              (current) =>
                new Set(
                  [...current].filter(
                    (id) =>
                      context.githubRepos
                        .find((candidate) => candidate.id === id)
                        ?.fullName.toLowerCase() !== matched.fullName.toLowerCase(),
                  ),
                ),
            );
            setPendingPersonalRepoIds((current) => new Set(current).add(matched.repositoryId));
            setPendingPersonalRepoRefs((current) => ({
              ...current,
              [matched.repositoryId]: ref,
            }));
          },
          verifyPublicGitHubRepository: async (request) =>
            await context.client.verifyPublicGitHubRepositoryRef(session.workspaceId, request),
          attach: (attached) =>
            setPendingManualRepos((current) =>
              current.map((candidate) => (candidate.id === attached.id ? attached : candidate)),
            ),
          remove: (id) =>
            setPendingManualRepos((current) => current.filter((candidate) => candidate.id !== id)),
        }),
      newChatUrl: `/workspaces/${session.workspaceId}`,
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
      mountedPersonalRepoIds,
      mountedRepositorySelection.selectedRepoIds,
      pendingBuild.error,
      pendingManualRepos,
      selectedInstallationId,
      selectedPersonalRepoIds,
      selectedPersonalRepoRefs,
      selectedRepoIds,
      selectedRepoRefs,
      session.workspaceId,
      togglePendingRepository,
      togglePendingPersonalRepository,
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
    setPendingPersonalRepoIds(new Set());
    setPendingPersonalRepoRefs({});
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
