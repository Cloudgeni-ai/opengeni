import {
  findSessionRemovedRepository,
  mergeResourceRefs,
  normalizeRepositoryTransportUri,
  repositoryMembershipKey,
  resourceMountPath,
  stableJson,
} from "@opengeni/contracts";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "./toast";

import { openGitHubInstallationSettings } from "./github-app-connect";
import type {
  MountedRepositoryTarget,
  RepositoryContextPickerProps,
} from "../components/repository-picker";
import { useAppContext } from "../app-context";
import { hasWorkspacePermission } from "./permissions";
import {
  buildAdditionalRepositoryResources,
  isRepositoryResourceForGitHubRepo,
  repositorySelectionFromResources,
  type RepoDraft,
} from "./session-tools";
import type { GitStatusResponse } from "@opengeni/contracts";
import type { GitHubRepository, ResourceRef, Session } from "../types";
import { usePage } from "./navigation";
import { errorMessage } from "@opengeni/contracts/values";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { userErrorText } from "../../ui/api-error";

type RepositoryResource = Extract<ResourceRef, { kind: "repository" }>;

/**
 * What the confirmation knows about the folder: `checking` while Git status
 * runs, `unknown` when the check failed or timed out, `kept` on a Connected
 * Machine, whose files Opengeni never deletes.
 */
export type RepositoryRemovalFolderState = "checking" | "clean" | "unsaved" | "unknown" | "kept";

type RepositoryRemoval = {
  open: boolean;
  resource: RepositoryResource;
  name: string;
  folder: RepositoryRemovalFolderState;
};

const REMOVAL_FOLDER_COPY: Record<RepositoryRemovalFolderState, string> = {
  checking: "The agent loses access and its folder is removed.",
  clean: "The agent loses access and its folder is removed.",
  unsaved: "The agent loses access and its folder is removed. It has unsaved changes.",
  unknown:
    "The agent loses access and its folder is removed. Couldn't check it for unsaved changes.",
  kept: "The agent loses access. Files on your computer are left alone.",
};

const REMOVAL_STATUS_TIMEOUT_MS = 10_000;

/** Uncommitted files, unpushed commits, or a local branch that was never pushed. */
export function gitStatusHasUnsavedChanges(status: GitStatusResponse): boolean {
  if (!status.isRepo) return false;
  return (
    status.files.length > 0 ||
    status.ahead > 0 ||
    (!status.detached && status.head !== null && status.upstream === null)
  );
}

function repositoryDisplayName(uri: string): string {
  const path = uri.replace(/[?#].*$/, "").replace(/\/+$/, "");
  const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.git$/i, "");
  return name || uri;
}

/** Confirms removing one mounted repository from a chat. */
export function RepositoryRemovalDialog(props: {
  open: boolean;
  name: string;
  /** Remove waits while the folder is `checking`. */
  folder: RepositoryRemovalFolderState;
  onClose: () => void;
  onConfirm: () => Promise<boolean>;
}) {
  return (
    <ConfirmDialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      title={`Remove ${props.name} from this chat?`}
      description={REMOVAL_FOLDER_COPY[props.folder]}
      confirmLabel="Remove"
      pendingLabel="Removing…"
      confirmDisabled={props.folder === "checking"}
      onConfirm={props.onConfirm}
    />
  );
}

type RepositoryRefreshContext = Pick<
  ReturnType<typeof useAppContext>,
  | "accessContext"
  | "captureWorkspaceInvocation"
  | "refreshGitHub"
  | "refreshPersonalGitHub"
  | "repoBusy"
  | "personalGitHubBusy"
>;

/** Keep this above the lazily mounted menu so rapid reopenings share one cooldown. */
export function useRepositoryCatalogRefresh(
  workspaceId: string,
  context: RepositoryRefreshContext,
) {
  const gate = useRef<{ key: string; attemptedAt: number; inFlight: Promise<void> | null } | null>(
    null,
  );
  const canUseGitHub = hasWorkspacePermission(context.accessContext, workspaceId, "github:use");
  const canManageGitHub = hasWorkspacePermission(
    context.accessContext,
    workspaceId,
    "github:manage",
  );
  const canReadPersonal = hasWorkspacePermission(
    context.accessContext,
    workspaceId,
    "connections:read",
  );
  const refresh = useCallback(
    async (explicit: boolean) => {
      const transition = context.captureWorkspaceInvocation(workspaceId);
      if (!transition || (!canUseGitHub && !canReadPersonal)) return;
      // A principal/workspace/permission transition must not inherit another scope's cooldown.
      const key = JSON.stringify([
        context.accessContext.subjectId,
        workspaceId,
        transition.revision,
        canUseGitHub,
        canManageGitHub,
        canReadPersonal,
      ]);
      const previous = gate.current;
      if (previous?.key === key) {
        if (previous.inFlight) return previous.inFlight;
        if (!explicit && Date.now() - previous.attemptedAt < 30_000) return;
      }
      if ((canUseGitHub && context.repoBusy) || (canReadPersonal && context.personalGitHubBusy))
        return;
      const accepted = { key, attemptedAt: Date.now(), inFlight: null as Promise<void> | null };
      gate.current = accepted;
      // Opening is read-only. Explicit refresh may sync for an App manager;
      // ordinary users keep catalog reads. Context retains its async ownership fences.
      const request = Promise.all([
        ...(canUseGitHub
          ? [
              context.refreshGitHub(workspaceId, undefined, {
                sync: explicit && canManageGitHub,
                userInitiated: explicit,
              }),
            ]
          : []),
        ...(canReadPersonal
          ? [context.refreshPersonalGitHub(workspaceId, undefined, { userInitiated: explicit })]
          : []),
      ]).then(() => undefined);
      accepted.inFlight = request;
      try {
        await request;
      } finally {
        accepted.inFlight = null;
      }
    },
    [context, workspaceId, canUseGitHub, canManageGitHub, canReadPersonal],
  );
  return {
    refreshAllowed: canUseGitHub || canReadPersonal,
    onOpenRefresh: useCallback(() => refresh(false), [refresh]),
    onRefresh: useCallback(() => refresh(true), [refresh]),
  };
}

function withoutMounted<T>(pending: ReadonlySet<T>, mounted: ReadonlySet<T>): Set<T> {
  return new Set([...pending].filter((id) => !mounted.has(id)));
}

function manualDraftSignature(draft: RepoDraft): string | null {
  try {
    const uri = normalizeRepositoryTransportUri(
      draft.url.includes("://") ? draft.url : `https://${draft.url}`,
    );
    return `${uri}\u0000${draft.ref.trim()}\u0000${draft.expectedCommitSha ?? ""}`;
  } catch {
    return null;
  }
}

function manualResourceSignature(resource: RepositoryResource): string {
  return `${resource.uri}\u0000${resource.ref}\u0000${resource.expectedCommitSha ?? ""}`;
}

/**
 * Session-scoped repository additions for the follow-up composer. Session
 * resources are additive: accepted resources cannot be retargeted, but a person
 * can remove one from the chat after a confirmation (`removalDialog`). Only
 * explicit additions are ever sent, so a stale composer never re-attaches a
 * repository someone removed elsewhere.
 */
export function useFollowUpRepositories(
  session: Session,
  /** Starts workspace App setup from a click; the caller hosts the dialog. */
  onConnectWorkspaceApp: () => void,
): {
  pendingResources: ResourceRef[];
  error: string | null;
  selectionCount: number;
  pickerProps: (disabled: boolean) => RepositoryContextPickerProps;
  commitSent: (resources: ResourceRef[]) => void;
  /** Render next to the composer; it confirms removing a mounted repository. */
  removalDialog: ReactNode;
} {
  const context = useAppContext();
  const catalogRefresh = useRepositoryCatalogRefresh(session.workspaceId, context);
  const page = usePage();
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
  // Repositories this tab removed, hidden until the session read catches up.
  const [locallyRemovedKeys, setLocallyRemovedKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [removal, setRemoval] = useState<RepositoryRemoval | null>(null);
  const removalCheck = useRef<AbortController | null>(null);
  // Per optimistic mount, the removal record its send superseded (if any).
  const [supersededRemovalIds, setSupersededRemovalIds] = useState<
    Readonly<Record<string, string | null>>
  >({});
  const removedRecordsRef = useRef(session.removedRepositories ?? []);
  removedRecordsRef.current = session.removedRepositories ?? [];
  const nextManualRepoId = useRef(1);
  const currentSessionId = useRef(session.id);
  currentSessionId.current = session.id;
  const canRemoveRepositories = hasWorkspacePermission(
    context.accessContext,
    session.workspaceId,
    "sessions:control",
  );

  const mountedResources = useMemo(() => {
    const removedRecords = session.removedRepositories ?? [];
    // An optimistic mount someone has since removed must not linger.
    const optimistic = optimisticMountedRepos.filter((resource) => {
      if (resource.kind !== "repository") return true;
      const record = findSessionRemovedRepository(removedRecords, resource.uri);
      const key = repositoryMembershipKey(resource.uri) ?? resource.uri;
      return record === undefined || record.id === supersededRemovalIds[key];
    });
    return mergeResourceRefs(session.resources, optimistic).filter(
      (resource) =>
        resource.kind !== "repository" ||
        !locallyRemovedKeys.has(repositoryMembershipKey(resource.uri) ?? resource.uri),
    );
  }, [
    locallyRemovedKeys,
    optimisticMountedRepos,
    session.removedRepositories,
    session.resources,
    supersededRemovalIds,
  ]);
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
  const pendingBuild = useMemo(() => {
    try {
      return {
        resources: buildAdditionalRepositoryResources({
          mountedResources,
          manualRepos: pendingManualRepos,
          repositories: context.githubRepos,
          // A pending pick that became mounted elsewhere (for example from a
          // conversation card) is already in the chat; never resend or
          // conflict-check it against its own mount.
          selectedRepoIds: withoutMounted(
            pendingRepoIds,
            mountedRepositorySelection.selectedRepoIds,
          ),
          selectedRepoRefs: pendingRepoRefs,
          personalRepositories: context.personalGitHubRepositories,
          selectedPersonalRepositoryIds: withoutMounted(
            pendingPersonalRepoIds,
            mountedPersonalRepoIds,
          ),
          selectedPersonalRepositoryRefs: pendingPersonalRepoRefs,
          personalCredentialBindingId: context.personalGitHubSelection?.credentialBindingId,
        }),
        error: null,
      };
    } catch (error) {
      return {
        resources: [] as ResourceRef[],
        error: errorMessage(error),
      };
    }
  }, [
    context.githubRepos,
    context.personalGitHubRepositories,
    context.personalGitHubSelection?.credentialBindingId,
    mountedResources,
    mountedPersonalRepoIds,
    mountedRepositorySelection.selectedRepoIds,
    pendingManualRepos,
    pendingPersonalRepoIds,
    pendingPersonalRepoRefs,
    pendingRepoIds,
    pendingRepoRefs,
  ]);
  const pendingResourcesRef = useRef(pendingBuild.resources);
  pendingResourcesRef.current = pendingBuild.resources;
  const selectionCount =
    selectedRepoIds.size +
    selectedPersonalRepoIds.size +
    [...mountedManualRepos, ...pendingManualRepos].filter(
      (repository) => repository.attached !== false && repository.url.trim().length > 0,
    ).length;

  const togglePendingRepository = useCallback(
    (repo: GitHubRepository) => {
      if (mountedRepositorySelection.selectedRepoIds.has(repo.id)) return;
      const mountedPersonalConflict = context.personalGitHubRepositories.some(
        (personalRepo) =>
          mountedPersonalRepoIds.has(personalRepo.repositoryId) &&
          personalRepo.fullName.toLowerCase() === repo.fullName.toLowerCase(),
      );
      if (mountedPersonalConflict) {
        toast.info("This repository is already mounted as you");
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
          .filter(
            (personalRepo) => personalRepo.fullName.toLowerCase() === repo.fullName.toLowerCase(),
          )
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
          workspaceRepo.fullName.toLowerCase() === repo.fullName.toLowerCase(),
      );
      if (mountedWorkspaceConflict) {
        toast.info("This repository is already mounted with the workspace GitHub App");
        return;
      }
      if (!(await context.ensurePersonalGitHubAuthority(session.workspaceId))) return;
      const workspaceConflictIds = new Set(
        context.githubRepos
          .filter(
            (workspaceRepo) => workspaceRepo.fullName.toLowerCase() === repo.fullName.toLowerCase(),
          )
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

  const requestRepositoryRemoval = useCallback(
    (target: MountedRepositoryTarget) => {
      const resource = mountedRepositoryResources.find((candidate) => {
        if (target.kind === "app")
          return isRepositoryResourceForGitHubRepo(candidate, target.repository);
        if (target.kind === "personal") {
          return (
            candidate.connectionType === "github_personal" &&
            candidate.repositoryId === target.repository.repositoryId
          );
        }
        const key = repositoryMembershipKey(target.uri);
        return key !== null && repositoryMembershipKey(candidate.uri) === key;
      });
      if (!resource) return;
      removalCheck.current?.abort();
      removalCheck.current = null;
      const name =
        target.kind === "uri"
          ? repositoryDisplayName(target.uri)
          : (target.repository.fullName.split("/").at(-1) ?? target.repository.fullName);
      // Opengeni never deletes files on a Connected Machine; nothing to check.
      if (session.sandboxBackend === "selfhosted") {
        setRemoval({ open: true, resource, name, folder: "kept" });
        return;
      }
      const check = new AbortController();
      removalCheck.current = check;
      const timeout = setTimeout(() => check.abort(), REMOVAL_STATUS_TIMEOUT_MS);
      setRemoval({ open: true, resource, name, folder: "checking" });
      const settle = (folder: RepositoryRemovalFolderState) => {
        clearTimeout(timeout);
        if (removalCheck.current !== check) return;
        removalCheck.current = null;
        setRemoval((current) =>
          current?.resource === resource ? { ...current, folder } : current,
        );
      };
      // A failed or slow check says so; Remove stays available.
      context.client
        .gitStatus(
          session.workspaceId,
          session.id,
          { path: resourceMountPath(resource) },
          { signal: check.signal },
        )
        .then(
          (status) => settle(gitStatusHasUnsavedChanges(status) ? "unsaved" : "clean"),
          () => settle("unknown"),
        );
    },
    [
      context.client,
      mountedRepositoryResources,
      session.id,
      session.sandboxBackend,
      session.workspaceId,
    ],
  );

  const closeRepositoryRemoval = useCallback(() => {
    removalCheck.current?.abort();
    removalCheck.current = null;
    setRemoval((current) => (current ? { ...current, open: false } : current));
  }, []);

  const confirmRepositoryRemoval = useCallback(async (): Promise<boolean> => {
    if (!removal) return false;
    const { resource } = removal;
    const acceptedSessionId = session.id;
    const acceptedTransition = context.captureWorkspaceInvocation(session.workspaceId);
    if (!acceptedTransition) return false;
    let updated: Session;
    try {
      updated = await context.client.removeSessionResources(session.workspaceId, session.id, {
        resources: [{ kind: "repository", uri: resource.uri }],
      });
    } catch (error) {
      toast.error(`Couldn't remove ${removal.name}`, { description: userErrorText(error) });
      return false;
    }
    if (
      currentSessionId.current !== acceptedSessionId ||
      !context.ownsWorkspaceInvocation(session.workspaceId, acceptedTransition)
    ) {
      return true;
    }
    const key = repositoryMembershipKey(resource.uri) ?? resource.uri;
    const sameRepository = (candidate: ResourceRef) =>
      candidate.kind === "repository" &&
      (repositoryMembershipKey(candidate.uri) ?? candidate.uri) === key;
    setLocallyRemovedKeys((current) => new Set(current).add(key));
    setOptimisticMountedRepos((current) =>
      current.filter((candidate) => !sameRepository(candidate)),
    );
    // Switching the row off must not leave it queued to be re-attached.
    if (resource.githubRepositoryId !== undefined) {
      const repositoryId = resource.githubRepositoryId;
      setPendingRepoIds((current) => {
        if (!current.has(repositoryId)) return current;
        const next = new Set(current);
        next.delete(repositoryId);
        return next;
      });
    }
    if (
      resource.connectionType === "github_personal" &&
      typeof resource.repositoryId === "string"
    ) {
      const repositoryId = resource.repositoryId;
      setPendingPersonalRepoIds((current) => {
        if (!current.has(repositoryId)) return current;
        const next = new Set(current);
        next.delete(repositoryId);
        return next;
      });
    }
    context.setSession((current) => {
      if (!current || current.id !== updated.id) return current;
      const { removedRepositories: _previous, ...rest } = current;
      return {
        ...rest,
        resources: updated.resources,
        ...(updated.removedRepositories
          ? { removedRepositories: updated.removedRepositories }
          : {}),
      };
    });
    return true;
  }, [context, removal, session.id, session.workspaceId]);

  const removalDialog = (
    <RepositoryRemovalDialog
      open={removal?.open === true}
      name={removal?.name ?? ""}
      folder={removal?.folder ?? "clean"}
      onClose={closeRepositoryRemoval}
      onConfirm={confirmRepositoryRemoval}
    />
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
      personalGitHubManageUrl: `/workspaces/${encodeURIComponent(session.workspaceId)}/plugins?open=integration:github`,
      groups: context.repositoryGroups,
      selectedRepoIds,
      selectedRepoRefs,
      manualRepos: [...mountedManualRepos, ...pendingManualRepos],
      manualOpen: manualReposOpen,
      githubAppOpen: context.githubAppOpen,
      org: context.githubOrg,
      pending: disabled || context.busy,
      repoBusy: context.repoBusy,
      githubLoadFailed: context.githubStatusFailed && !context.githubCatalogReady,
      githubAppBusy: context.githubAppBusy,
      lockedRepoIds: mountedRepositorySelection.selectedRepoIds,
      lockedPersonalGitHubRepoIds: mountedPersonalRepoIds,
      lockedManualRepoIds,
      unavailableMountedRepositories: mountedRepositoryResources.filter(
        (resource) =>
          resource.connectionType === "github_personal" &&
          (context.personalGitHubStatus?.connection?.status !== "active" ||
            !context.personalGitHubRepositories.some(
              (repo) => repo.repositoryId === resource.repositoryId && repo.selectedAccess !== null,
            )),
      ),
      validationError: pendingBuild.error,
      ...(canRemoveRepositories ? { onRemoveMountedRepository: requestRepositoryRemoval } : {}),
      ...catalogRefresh,
      onConnectPersonalGitHub: () => void context.connectPersonalGitHub(session.workspaceId),
      onTogglePersonalGitHubRepo: (repo) => void togglePendingPersonalRepository(repo),
      onPersonalGitHubRefChange: (repositoryId, ref) =>
        setPendingPersonalRepoRefs((current) => ({ ...current, [repositoryId]: ref })),
      onToggleRepo: togglePendingRepository,
      onRefChange: (repoId, ref) =>
        setPendingRepoRefs((current) => ({ ...current, [repoId]: ref })),
      onLoadGitHubBranches: async (repository) => {
        const acceptedTransition = context.captureWorkspaceInvocation(session.workspaceId);
        const acceptedSessionId = session.id;
        if (!acceptedTransition) throw new Error("The session changed; refresh and try again.");
        const { listGitHubRepositoryBranches } = await import("@opengeni/sdk/github-repositories");
        const response = await listGitHubRepositoryBranches(
          context.client,
          session.workspaceId,
          repository.installationId,
          repository.id,
          { limit: 100 },
        );
        if (
          currentSessionId.current !== acceptedSessionId ||
          !context.ownsWorkspaceInvocation(session.workspaceId, acceptedTransition)
        ) {
          throw new Error("The session changed; refresh and try again.");
        }
        return response.branches;
      },
      onLoadPersonalGitHubBranches: async (repository) => {
        const acceptedTransition = context.captureWorkspaceInvocation(session.workspaceId);
        const acceptedSessionId = session.id;
        if (!acceptedTransition) throw new Error("The session changed; refresh and try again.");
        const connectionId = context.personalGitHubStatus?.connection?.id;
        if (!connectionId) throw new Error("Connect your GitHub identity to load branches.");
        const { listPersonalGitHubRepositoryBranches } =
          await import("@opengeni/sdk/github-repositories");
        const response = await listPersonalGitHubRepositoryBranches(
          context.client,
          session.workspaceId,
          connectionId,
          repository.repositoryId,
          { limit: 100 },
        );
        if (
          currentSessionId.current !== acceptedSessionId ||
          !context.ownsWorkspaceInvocation(session.workspaceId, acceptedTransition)
        ) {
          throw new Error("The session changed; refresh and try again.");
        }
        return response.branches;
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
      onManualAttach: async (repository) => {
        const acceptedTransition = context.captureWorkspaceInvocation(session.workspaceId);
        const acceptedSessionId = session.id;
        if (!acceptedTransition) throw new Error("The session changed; try again.");
        const assertCurrent = () => {
          if (
            currentSessionId.current !== acceptedSessionId ||
            !context.ownsWorkspaceInvocation(session.workspaceId, acceptedTransition)
          ) {
            throw new Error("The session changed; try again.");
          }
        };
        assertCurrent();
        const { attachManualRepository } = await import("./manual-repositories");
        assertCurrent();
        return await attachManualRepository({
          repository,
          workspaceRepositories: context.githubRepos,
          personalRepositories: context.personalGitHubRepositories,
          selectWorkspaceRepository: (matched, ref) => {
            assertCurrent();
            const mountedPersonalConflict = context.personalGitHubRepositories.some(
              (candidate) =>
                mountedPersonalRepoIds.has(candidate.repositoryId) &&
                candidate.fullName.toLowerCase() === matched.fullName.toLowerCase(),
            );
            if (mountedPersonalConflict) {
              throw new Error("This repository is already mounted as your GitHub identity.");
            }
            setPendingRepoIds((current) => new Set(current).add(matched.id));
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
            assertCurrent();
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
          verifyPublicGitHubRepository: async (request) => {
            const { verifyPublicGitHubRepositoryRef } =
              await import("@opengeni/sdk/github-repositories");
            const verified = await verifyPublicGitHubRepositoryRef(
              context.client,
              session.workspaceId,
              request,
            );
            assertCurrent();
            return verified;
          },
          attach: (attached) => {
            assertCurrent();
            setPendingManualRepos((current) =>
              current.map((candidate) => (candidate.id === attached.id ? attached : candidate)),
            );
          },
          remove: (id) => {
            assertCurrent();
            setPendingManualRepos((current) => current.filter((candidate) => candidate.id !== id));
          },
        });
      },
      newChatUrl: `/workspaces/${session.workspaceId}`,
      onGitHubAppOpenChange: context.setGithubAppOpen,
      onOrgChange: context.setGithubOrg,
      onStartGitHubApp: () => void context.startGitHubAppManifestFlow(session.workspaceId),
      onConnectWorkspaceApp,
      onConfigureInstallation: (installationId: number) =>
        openGitHubInstallationSettings(
          context.client,
          session.workspaceId,
          installationId,
          page.assign,
        ),
      onDisconnectInstallation: disconnectRepositoryInstallation,
    }),
    [
      page,
      catalogRefresh,
      canRemoveRepositories,
      context,
      disconnectRepositoryInstallation,
      onConnectWorkspaceApp,
      lockedManualRepoIds,
      manualReposOpen,
      mountedManualRepos,
      mountedRepositoryResources,
      mountedPersonalRepoIds,
      mountedRepositorySelection.selectedRepoIds,
      pendingBuild.error,
      pendingManualRepos,
      requestRepositoryRemoval,
      selectedPersonalRepoIds,
      selectedPersonalRepoRefs,
      selectedRepoIds,
      selectedRepoRefs,
      session.id,
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
    // This send ends the removal records it saw; only a later removal hides it.
    const supersededRemovals = Object.fromEntries(
      repositories.map((resource) => [
        repositoryMembershipKey(resource.uri) ?? resource.uri,
        findSessionRemovedRepository(removedRecordsRef.current, resource.uri)?.id ?? null,
      ]),
    );
    setSupersededRemovalIds((current) => ({ ...current, ...supersededRemovals }));
    // Re-attaching a repository this tab removed shows it as mounted again.
    const sentKeys = new Set(
      repositories.map((resource) => repositoryMembershipKey(resource.uri) ?? resource.uri),
    );
    setLocallyRemovedKeys((current) => {
      if (![...current].some((key) => sentKeys.has(key))) return current;
      return new Set([...current].filter((key) => !sentKeys.has(key)));
    });

    // An optimistic Send can be accepted after the picker becomes editable
    // again. Remove only pending selections represented by this immutable wire
    // snapshot; later additions must remain queued for the next message.
    const acceptedKeys = new Set(repositories.map(stableJson));
    const pendingResources = pendingResourcesRef.current;
    const acceptedRepoIds = new Set(
      pendingResources.flatMap((resource) =>
        resource.kind === "repository" &&
        resource.githubRepositoryId !== undefined &&
        acceptedKeys.has(stableJson(resource))
          ? [resource.githubRepositoryId]
          : [],
      ),
    );
    const acceptedPersonalRepoIds = new Set(
      pendingResources.flatMap((resource) =>
        resource.kind === "repository" &&
        resource.connectionType === "github_personal" &&
        typeof resource.repositoryId === "string" &&
        acceptedKeys.has(stableJson(resource))
          ? [resource.repositoryId]
          : [],
      ),
    );
    const acceptedManualDraftKeys = new Set(
      pendingResources.flatMap((resource) => {
        if (
          resource.kind !== "repository" ||
          resource.connectionType === "github_personal" ||
          resource.githubRepositoryId !== undefined ||
          resource.githubInstallationId !== undefined ||
          !acceptedKeys.has(stableJson(resource))
        ) {
          return [];
        }
        return [manualResourceSignature(resource)];
      }),
    );

    setPendingRepoIds((current) => {
      const next = new Set([...current].filter((id) => !acceptedRepoIds.has(id)));
      return next.size === current.size ? current : next;
    });
    setPendingRepoRefs((current) => {
      const next = { ...current };
      for (const id of acceptedRepoIds) delete next[id];
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
    setPendingPersonalRepoIds((current) => {
      const next = new Set([...current].filter((id) => !acceptedPersonalRepoIds.has(id)));
      return next.size === current.size ? current : next;
    });
    setPendingPersonalRepoRefs((current) => {
      const next = { ...current };
      for (const id of acceptedPersonalRepoIds) delete next[id];
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
    setPendingManualRepos((current) => {
      const next = current.filter((draft) => {
        const signature = manualDraftSignature(draft);
        return signature === null || !acceptedManualDraftKeys.has(signature);
      });
      return next.length === current.length ? current : next;
    });
  }, []);

  return {
    pendingResources: pendingBuild.resources,
    error: pendingBuild.error,
    selectionCount,
    pickerProps,
    commitSent,
    removalDialog,
  };
}
